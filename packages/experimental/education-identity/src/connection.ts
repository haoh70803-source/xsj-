/** Opt-in employee Peer scopes for the native Connection carrier. */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { ConnectionTrustRequest, PeerAdmission, PeerId, PeerScope } from '@deepseek-ai/dsh-client-connection'
import { EducationError, type EducationIdentity, type EducationRepository } from '@deepseek-ai/dsh-experimental-education-platform'
import type { ActorContext, LoginSessionId } from '@deepseek-ai/dsh-experimental-education-platform/types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-only resolution of a native request Peer to its current employee authorization. */
    educationPeers: EducationPeers
  }
}

class EmployeePeer implements PeerScope {
  readonly id = brandString<PeerId>(randomUUID())
  readonly ctx: Context
  readonly lifetime = new AbortController()
  private readonly scope: Scope

  constructor(owner: Context, readonly actor: ActorContext) {
    this.scope = createScope(owner, this)
    this.ctx = this.scope.ctx
  }

  dispose(): Promise<void> {
    this.lifetime.abort()
    return this.scope.dispose()
  }
}

/** Native employee identity registry; does not grant Session, file or Remote-event resource access. */
export class EducationPeers extends Service {
  private readonly peers = new Map<LoginSessionId, EmployeePeer>()
  private readonly retiring = new Set<Promise<void>>()
  private closed = false
  private readonly reportDisposal: (error: unknown) => void

  /**
   * Bind employee admission only to a Connection configured to require a request policy.
   * @param ctx - injected Connection and owning identity context.
   * @param identity - durable cookie resolver.
   * @param repository - current employee authorization owner.
   * @param maxPeers - maximum active login scopes in this process.
   * @param sweepIntervalMs - maximum polling delay for idle expiry and account revocation.
   */
  constructor(ctx: Context, private readonly identity: EducationIdentity, private readonly repository: EducationRepository,
    private readonly maxPeers: number, sweepIntervalMs: number, loginShell = false) {
    if (!ctx.connection.requiresRequestPolicy) throw new Error('education identity requires connection.requireRequestPolicy=true')
    super(ctx, 'educationPeers')
    const logger = ctx.logger
    this.reportDisposal = (error) => {
      logger.error('Employee Peer scope disposal failed; the login scope is already revoked.', error)
    }
    ctx.connection.registerRequestPolicy({
      admit: request => this.admit(request),
      accepts: (peer) => {
        try { this.actor(peer); return true }
        catch (error) {
          if (error instanceof EducationError && error.code === 'unauthenticated') return false
          throw error
        }
      },
      signal: peer => this.signal(peer),
      authorize: (peer, access) => this.ctx.get('educationAuthorization')?.allows(this.actor(peer), access) ?? false,
      authorizeIndex: (request, response) => {
        const admission = this.admit(request)
        if ('peer' in admission) return true
        if (admission.rejection === 401 && loginShell) {
          response.writeHead(303, { location: '/education/sign-in', 'cache-control': 'no-store' })
          response.end()
          return false
        }
        response.writeHead(admission.rejection)
        response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return false
      },
    })
    ctx.on('education-identity/revoked', (sessionId) => {
      const peer = this.peers.get(sessionId)
      if (peer !== undefined) this.retire(peer)
    })
    ctx.on('education-authorization/revoked', (actor) => {
      for (const peer of this.peers.values()) {
        if (peer.actor.organizationId === actor.organizationId && peer.actor.userId === actor.userId) this.retire(peer)
      }
    })
    ctx.on('education-authorization/policy-changed', () => {
      for (const peer of this.peers.values()) this.retire(peer)
    })
    ctx.effect(() => {
      const timer = setInterval(() => {
        try { for (const peer of this.peers.values()) this.current(peer) }
        catch (error) {
          // A repository failure cannot leave existing scopes authorized.
          for (const peer of this.peers.values()) this.retire(peer)
          logger.error('Employee Peer validation failed; active scopes revoked. Check identity storage before reconnecting.', error)
        }
      }, sweepIntervalMs)
      timer.unref()
      return async () => {
        this.closed = true
        clearInterval(timer)
        for (const peer of this.peers.values()) this.retire(peer)
        await Promise.all([...this.retiring])
      }
    }, 'education-identity: employee Peer lifecycle')
  }

  /**
   * Resolve current authorization without accepting an Actor supplied by the client.
   * @param peer - exact Peer instance admitted by this registry.
   * @returns current employee Actor; unknown, expired and revoked Peers reject uniformly.
   */
  actor(peer: PeerScope): ActorContext {
    if (!(peer instanceof EmployeePeer) || !this.current(peer)) throw inactive()
    return peer.actor
  }

  /**
   * Observe the lifecycle of an admitted employee login.
   * @param peer - exact active Peer admitted by this registry.
   * @returns signal aborted when its scope is revoked or disposed.
   */
  signal(peer: PeerScope): AbortSignal {
    this.actor(peer)
    if (!(peer instanceof EmployeePeer)) throw inactive()
    return peer.lifetime.signal
  }

  private admit(request: ConnectionTrustRequest): PeerAdmission {
    if (this.closed) return { rejection: 401 }
    let actor: ActorContext | null
    try { actor = this.identity.actor({ headers: request.headers, remoteAddress: '' }) }
    catch (error) {
      if (error instanceof EducationError && error.code === 'forbidden') return { rejection: 403 }
      throw error
    }
    if (actor === null) return { rejection: 401 }
    const existing = this.peers.get(actor.loginSessionId)
    if (existing !== undefined && this.current(existing)) return { peer: existing }
    if (this.peers.size >= this.maxPeers) return { rejection: 403 }
    const peer = new EmployeePeer(this.ctx, actor)
    this.peers.set(actor.loginSessionId, peer)
    return { peer }
  }

  private current(peer: EmployeePeer): boolean {
    if (this.closed || this.peers.get(peer.actor.loginSessionId) !== peer || peer.lifetime.signal.aborted) return false
    try { this.repository.readSelf(peer.actor); return true }
    catch (error) {
      this.retire(peer)
      if (error instanceof EducationError && error.code === 'unauthenticated') return false
      throw error
    }
  }

  private retire(peer: EmployeePeer): void {
    this.peers.delete(peer.actor.loginSessionId)
    const done = peer.dispose().catch(this.reportDisposal)
    this.retiring.add(done)
    void done.finally(() => { this.retiring.delete(done) })
  }
}

function inactive(): EducationError {
  return new EducationError('unauthenticated', 'employee Peer is expired, revoked or invalid')
}
