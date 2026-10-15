/** Durable employee authentication and controlled HTTP routes; native Peer adaptation is a separate consumer. */
import { createHash, randomBytes } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'
import type { EducationIdentity, EducationRepository, IdentityRequest, IdentitySignInResult, IdentityState } from '@deepseek-ai/dsh-experimental-education-platform'
import type { ActorContext, OrganizationId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { derivePassword, loginPassword, matchesPassword, normalizeUsername } from './credentials.ts'
import { mountIdentityHttp } from './http.ts'
import { EducationPeers } from './connection.ts'
import { EducationAuthorization } from './authorization.ts'
import type { LoginSessionId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import type { Config, ResolvedConfig } from './types.ts'

export type { Config } from './types.ts'
export { createPasswordCredential } from './credentials.ts'
export type { EducationPeers } from './connection.ts'
export type { EducationAuthorization, EducationAccessRule } from './authorization.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Revoke scopes after the durable login has been revoked.
     * @param sessionId - server-resolved login identity, never its cookie token.
     * @mode parallel
     */
    'education-identity/revoked'(sessionId: LoginSessionId): void
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const CONFIG: z<Config> = z.object({
  organizationId: z.string().pattern(UUID).required(),
  publicOrigin: z.string().required(),
  sessionLifetimeMs: z.number().step(1).min(60_000).max(604_800_000).default(43_200_000),
  loginAttempts: z.number().step(1).min(1).max(100).default(10),
  loginWindowMs: z.number().step(1).min(1_000).max(86_400_000).default(900_000),
  maxConcurrentVerifications: z.number().step(1).min(1).max(64).default(4),
  maxThrottleKeys: z.number().step(1).min(2).max(100_000).default(10_000),
  maxAuthRequestBytes: z.number().step(1).min(256).max(65_536).default(4_096),
  adaptConnection: z.boolean().default(false),
  loginShell: z.boolean().default(false),
  maxPeers: z.number().step(1).min(1).max(100_000).default(1_000),
  peerSweepIntervalMs: z.number().step(1).min(10).max(60_000).default(1_000),
})

interface Attempt { count: number; resetAt: number }

/** Persistent-login provider; each request verifies current organization, user, permission revision and expiry. */
export class EducationIdentityProvider extends Service implements EducationIdentity {
  static inject = ['educationRepository']
  static Config = CONFIG
  readonly publicOrigin: string
  /** Cookie namespace is distinct from both the prototype and native operator cookies. */
  readonly cookieName: string
  private readonly config: ResolvedConfig
  private readonly organizationId: OrganizationId
  private readonly repository: EducationRepository
  private readonly attempts = new Map<string, Attempt>()
  private readonly pending = new Set<Promise<IdentitySignInResult>>()
  private closed = false

  /**
   * Select an existing active organization and validate deployment before publishing authentication.
   * @param ctx - injected repository context.
   * @param config - explicit organization/origin and bounded authentication settings.
   */
  constructor(ctx: Context, config: Config) {
    const resolved = CONFIG(config) as ResolvedConfig
    const origin = browserOrigin(resolved.publicOrigin)
    const organizationId = brandString<OrganizationId>(resolved.organizationId)
    ctx.educationRepository.requireActiveOrganization(organizationId)
    super(ctx, 'educationIdentity')
    this.repository = ctx.educationRepository
    this.organizationId = organizationId
    this.config = resolved
    this.publicOrigin = origin
    this.cookieName = origin.startsWith('https:') ? '__Host-education-business-session' : 'education-business-session'
    ctx.effect(() => async () => {
      this.closed = true
      this.attempts.clear()
      await Promise.allSettled([...this.pending])
    }, 'education-identity: drain authentication')
    ctx.inject(['webServer'], (web) => { mountIdentityHttp(web, this, resolved.maxAuthRequestBytes, resolved.loginShell) })
    if (resolved.adaptConnection) {
      ctx.inject(['connection'], (carrier) => {
        new EducationPeers(carrier, this, this.repository, resolved.maxPeers, resolved.peerSweepIntervalMs, resolved.loginShell)
        new EducationAuthorization(carrier, this.repository)
      })
    }
  }

  signIn(request: IdentityRequest, input: unknown): Promise<IdentitySignInResult> {
    if (this.closed) return Promise.reject(closed())
    if (this.pending.size >= this.config.maxConcurrentVerifications) {
      return Promise.reject(new EducationError('rate-limited', 'authentication is busy; try again later'))
    }
    const operation = this.verify(request, input)
    this.pending.add(operation)
    return operation.finally(() => { this.pending.delete(operation) })
  }

  me(request: IdentityRequest): IdentityState {
    const actor = this.actor(request)
    if (actor === null) throw unauthenticated()
    return { actor, user: this.repository.readSelf(actor) }
  }

  actor(request: IdentityRequest): ActorContext | null {
    this.assertRequest(request, false)
    const token = this.token(request)
    if (token === undefined) return null
    const actor = this.repository.resolveLoginSession(digest(token))
    return actor?.organizationId === this.organizationId ? actor : null
  }

  signOut(request: IdentityRequest): string {
    this.assertRequest(request, true)
    const actor = this.actor(request)
    if (actor !== null) {
      this.repository.revokeLoginSession(actor.loginSessionId)
      this.ctx.emit('education-identity/revoked', actor.loginSessionId)
    }
    return this.cookie('', 0)
  }

  private async verify(request: IdentityRequest, input: unknown): Promise<IdentitySignInResult> {
    this.assertRequest(request, true)
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid()
    const fields = input as Record<string, unknown>
    if (Object.keys(fields).some(key => key !== 'username' && key !== 'password')) throw invalid()
    const username = normalizeUsername(fields.username)
    const password = loginPassword(fields.password)
    this.throttle(`address:${request.remoteAddress}`)
    this.throttle(`username:${username}`)
    const account = this.repository.findUserCredentials(this.organizationId, username)
    const derived = await derivePassword(password, account?.credentialSalt ?? 'education-workbench-dummy-salt')
    if (this.closed) throw closed()
    request.signal?.throwIfAborted()
    if (account === null || !matchesPassword(derived, account.credentialHash) || account.status !== 'active') throw unauthenticated()
    const token = randomBytes(32).toString('hex')
    this.repository.createLoginSession({ organizationId: this.organizationId, userId: account.user.id,
      tokenHash: digest(token), authRevision: account.authRevision,
      expiresAt: new Date(Date.now() + this.config.sessionLifetimeMs).toISOString() })
    this.attempts.delete(`username:${username}`)
    return { user: account.user, setCookie: this.cookie(token, this.config.sessionLifetimeMs / 1_000) }
  }

  private assertRequest(request: IdentityRequest, mutation: boolean): void {
    if (this.closed) throw closed()
    request.signal?.throwIfAborted()
    const host = header(request, 'host')
    const origin = header(request, 'origin')
    let authority: string | undefined
    if (host !== undefined && !/[\s/@?#\\]/.test(host)) {
      try { authority = new URL(`${new URL(this.publicOrigin).protocol}//${host}`).origin }
      catch (_error) { /* Invalid authority is rejected by the shared comparison below. */ }
    }
    if (authority !== this.publicOrigin || (mutation && origin === undefined)
      || (origin !== undefined && origin !== this.publicOrigin)) {
      throw new EducationError('forbidden', 'authentication Host or Origin is not allowed')
    }
  }

  private token(request: IdentityRequest): string | undefined {
    const cookies = header(request, 'cookie')?.split(';').map(value => value.trim())
      .filter(value => value.startsWith(`${this.cookieName}=`))
    if (cookies?.length !== 1) return undefined
    const encoded = cookies[0]
    if (encoded === undefined) return undefined
    const value = encoded.slice(this.cookieName.length + 1)
    return /^[a-f0-9]{64}$/.test(value) ? value : undefined
  }

  private cookie(token: string, seconds: number): string {
    const secure = this.publicOrigin.startsWith('https:') ? '; Secure' : ''
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(seconds)}${secure}`
  }

  private throttle(key: string): void {
    const now = Date.now()
    for (const [name, entry] of this.attempts) if (entry.resetAt <= now) this.attempts.delete(name)
    let attempt = this.attempts.get(key)
    if (attempt === undefined) {
      if (this.attempts.size >= this.config.maxThrottleKeys) throw new EducationError('rate-limited', 'authentication rate limit reached')
      attempt = { count: 0, resetAt: now + this.config.loginWindowMs }
      this.attempts.set(key, attempt)
    }
    attempt.count++
    if (attempt.count > this.config.loginAttempts) throw new EducationError('rate-limited', 'authentication rate limit reached')
  }
}

function header(request: IdentityRequest, name: string): string | undefined {
  if (request.headers instanceof Headers) return request.headers.get(name) ?? undefined
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

function browserOrigin(value: string): string {
  let origin: URL
  try { origin = new URL(value) } catch (error) { throw new EducationError('validation-failed', 'identity browser origin is invalid', { cause: error }) }
  if (origin.username !== '' || origin.password !== '' || origin.pathname !== '/' || origin.search !== '' || origin.hash !== ''
    || (origin.protocol !== 'http:' && origin.protocol !== 'https:') || origin.port === '0'
    || (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new EducationError('validation-failed', 'identity requires an HTTPS origin or explicit HTTP loopback origin')
  }
  return origin.origin
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function invalid(): EducationError { return new EducationError('validation-failed', 'authentication input is invalid') }
function closed(): EducationError { return new EducationError('closed', 'employee identity provider is closed') }
function unauthenticated(): EducationError { return new EducationError('unauthenticated', 'employee credentials or login are invalid') }

export default EducationIdentityProvider
