/** Authentication against a real isolated repository; no synthetic identity provider or password verifier. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectId, RequestId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveConfig } from '@deepseek-ai/dsh-experimental-education-storage-sqlite'
import { SqliteEducationRepository } from '../../education-storage-sqlite/src/repository.ts'
import type { OrganizationId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import type { IdentityRequest } from '@deepseek-ai/dsh-experimental-education-platform'
import EducationIdentityProvider from '../src/index.ts'
import { createPasswordCredential, normalizeUsername } from '../src/credentials.ts'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
type BrowserAuth = ConstructorParameters<typeof HostConnectionService>[2]

const cache = fileURLToPath(new URL('../../../../.cache/education-identity-tests/', import.meta.url))
const password = 'synthetic-identity-password-only'
const origin = 'http://127.0.0.1:12345'
let root: string
let path: string
let ctx: Context
let repository: SqliteEducationRepository
let organizationId: OrganizationId
let identity: EducationIdentityProvider
let fiber: ReturnType<Context['plugin']>

function request(cookie?: string, address = '127.0.0.1'): IdentityRequest {
  return { headers: { host: '127.0.0.1:12345', origin, ...(cookie === undefined ? {} : { cookie }) }, remoteAddress: address }
}

async function mount(config: Partial<ConstructorParameters<typeof EducationIdentityProvider>[1]> = {}): Promise<void> {
  fiber = ctx.plugin(EducationIdentityProvider, { organizationId, publicOrigin: origin, ...config })
  await fiber.await()
  const provided = ctx.get('educationIdentity')
  if (!(provided instanceof EducationIdentityProvider)) throw new Error('identity did not activate')
  identity = provided
}

async function login(username = 'employee-a', sender = request()) {
  return identity.signIn(sender, { username, password })
}

async function nativePolicy() {
  await fiber.dispose()
  await ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth, true) }).await()
  await mount({ adaptConnection: true })
  await expect.poll(() => ctx.get('educationAuthorization')).toBeDefined()
  const result = await login()
  const admission = ctx.connection.admit(request(result.setCookie))
  if ('rejection' in admission) throw new Error('fixture login refused')
  return { actor: identity.me(request(result.setCookie)).actor, peer: admission.peer }
}

beforeEach(async () => {
  mkdirSync(cache, { recursive: true })
  root = mkdtempSync(join(cache, 'owned-'))
  path = join(root, 'business.sqlite')
  repository = await SqliteEducationRepository.open(resolveConfig({ path }))
  organizationId = repository.provisionOrganization('合成身份测试组织')
  const credentials = await createPasswordCredential(password)
  for (const usernameNormalized of ['employee-a', 'employee-b']) {
    repository.provisionUser({ organizationId, usernameNormalized, ...credentials })
  }
  ctx = new Context()
  ctx.provide('educationRepository', repository)
  await mount()
})

afterEach(async () => {
  vi.useRealTimers()
  await ctx.fiber.dispose()
  repository.close()
  if (dirname(resolve(root)) !== resolve(cache) || !root.startsWith(join(cache, 'owned-'))) throw new Error('fixture outside owned root')
  rmSync(root, { recursive: true, force: true })
})

it('normalizes login names and returns only public employee fields', async () => {
  expect(normalizeUsername(' ＥＭＰＬＯＹＥＥ-Ａ ')).toBe('employee-a')
  const result = await identity.signIn(request(), { username: 'ＥＭＰＬＯＹＥＥ-Ａ', password })
  expect(result.user.username).toBe('employee-a')
  expect(Object.keys(result.user).sort()).toEqual(['id', 'organizationId', 'username'])
  const current = identity.me(request(result.setCookie))
  expect(current.user).toEqual(result.user)
  expect(Object.keys(current.actor).sort()).toEqual(['authRevision', 'loginSessionId', 'organizationId', 'userId'])
})

it('authorizes native Session history only through current same-owner bindings', async () => {
  const { actor, peer } = await nativePolicy()
  const second = await login('employee-b')
  const actorB = identity.me(request(second.setCookie)).actor
  const project = repository.createProject(actor, { title: '授权项目 A', scenario: 'spoken-script', requestId: brandString<RequestId>(randomUUID()) })
  const sessionId = brandString<SessionId>(randomUUID())
  repository.bindSession(actor, { projectId: project.projectId, artifactId: project.artifactId, harnessSessionId: sessionId,
    requestId: brandString<RequestId>(randomUUID()) })
  for (const method of ['page', 'follow', 'projections']) {
    const args = { request: method === 'projections' ? { sessionId } : { address: { kind: 'session', sessionId }, throughSeq: 0 } }
    expect(ctx.connection.authorize(peer, { kind: 'remote', namespace: 'session', method, args })).toBe(true)
    expect(ctx.educationAuthorization.allows(actorB, { kind: 'remote', namespace: 'session', method, args })).toBe(false)
    expect(ctx.connection.authorize(peer, { kind: 'rpc', channel: '/api', endpoint: `session/${method}`, payload: { args } })).toBe(true)
  }
  for (const address of [{ kind: 'session', sessionId: randomUUID() },
    { kind: 'subagent', parentSessionId: sessionId, childSessionId: randomUUID(), mode: 'continuable' }]) {
    expect(ctx.connection.authorize(peer, { kind: 'remote', namespace: 'session', method: 'follow', args: { request: { address, owner: actor.userId } } }))
      .toBe(false)
  }
  repository.invalidateSessionBinding(actor, sessionId)
  expect(ctx.connection.authorize(peer, { kind: 'remote', namespace: 'session', method: 'projections', args: { request: { sessionId } } })).toBe(false)
})

it.each(['list', 'search', 'create', 'control', 'prompt', 'cancel', 'fork', 'selectModel', 'openWorkspacePath'])(
  'denies the unexposed native session.%s operation even to the resource owner', async (method) => {
    const { peer } = await nativePolicy()
    expect(ctx.connection.authorize(peer, { kind: 'remote', namespace: 'session', method, args: {} })).toBe(false)
  })

it('denies raw files, operational namespaces and unknown Agent events without serializing their content', async () => {
  const { peer } = await nativePolicy()
  const secret = 'synthetic-private-marker-must-not-enter-audit'
  const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  try {
    for (const namespace of ['workspaceFiles', 'credentials', 'terminal', 'plugins', 'config', 'tools', 'llm']) {
      expect(ctx.connection.authorize(peer, { kind: 'remote', namespace, method: 'read', args: { path: secret } })).toBe(false)
    }
    expect(ctx.connection.authorize(peer, { kind: 'event', event: 'session/private', args: [secret], agentId: randomUUID() })).toBe(false)
    expect(ctx.connection.authorize(peer, { kind: 'event', event: 'session/global', args: [secret] })).toBe(false)
    const fetch = vi.fn(async () => new Response(secret))
    ctx.connection.fetch.register({ path: '/api/raw-file', methods: ['GET'], requestBody: 'buffered', fetch })
    const response = await ctx.connection.createSharedFetchHandler('/api', peer).fetch(new Request('http://localhost/api/raw-file'))
    expect(response.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
    expect(await response.text()).not.toContain(secret)
    expect(JSON.stringify(warning.mock.calls)).not.toContain(secret)
    expect(ctx.connection.authorize(peer, { kind: 'metadata', name: 'remote-host-home' })).toBe(false)
  } finally { warning.mockRestore() }
})

it('withdraws explicit feature grants and rechecks private resource ownership for each call', async () => {
  const { actor, peer } = await nativePolicy()
  const b = await login('employee-b')
  const actorB = identity.me(request(b.setCookie)).actor
  const created = repository.createProject(actor, { title: '授权私有项目', scenario: 'spoken-script', requestId: brandString<RequestId>(randomUUID()) })
  const grant = ctx.educationAuthorization.register({
    matches: access => access.kind === 'fetch' && access.url.pathname === '/api/controlled-export',
    allows: (current, access) => {
      if (access.kind !== 'fetch') return false
      const projectId = access.url.searchParams.get('projectId')
      if (projectId === null) return false
      repository.openProject(current, brandString<ProjectId>(projectId))
      return true
    },
  })
  const access = { kind: 'fetch' as const, method: 'GET', url: new URL(`http://localhost/api/controlled-export?projectId=${created.projectId}`) }
  expect(ctx.connection.authorize(peer, access)).toBe(true)
  expect(ctx.educationAuthorization.allows(actorB, access)).toBe(false)
  await grant()
  expect(ctx.connection.authorize(peer, access)).toBe(false)
})

it('binds stable per-login Peers and revokes only the logged-out scope', async () => {
  await fiber.dispose()
  const carrier = ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth, true) })
  await carrier.await()
  await mount({ adaptConnection: true })
  await expect.poll(() => ctx.get('educationPeers')).toBeDefined()
  const peers = ctx.educationPeers
  const connection = ctx.connection
  const [a, b, again] = await Promise.all([login('employee-a'), login('employee-b'), login('employee-a')])
  const admitted = [a, b, again].map((result) => {
    const admission = connection.admit(request(result.setCookie))
    if ('rejection' in admission) throw new Error('valid employee was refused')
    return admission.peer
  })
  const [peerA, peerB, peerAgain] = admitted
  if (peerA === undefined || peerB === undefined || peerAgain === undefined) throw new Error('missing test Peer')
  expect(connection.admit(request(a.setCookie))).toEqual({ peer: peerA })
  expect(new Set(admitted).size).toBe(3)
  expect(peers.actor(peerA).userId).toBe(a.user.id)
  expect(peers.actor(peerB).userId).toBe(b.user.id)
  expect(peers.actor(peerAgain).userId).toBe(a.user.id)
  expect(() => peers.actor(connection.operator)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  const signal = peers.signal(peerA)
  let released = false
  peerA.ctx.effect(() => () => { released = true })
  identity.signOut(request(a.setCookie))
  expect(signal.aborted).toBe(true)
  await expect.poll(() => released).toBe(true)
  expect(() => peers.actor(peerA)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  expect(peers.actor(peerB).userId).toBe(b.user.id)
  expect(peers.actor(peerAgain).userId).toBe(a.user.id)
  const otherSignal = peers.signal(peerB)
  await fiber.dispose()
  expect(otherSignal.aborted).toBe(true)
  expect(connection.admit(request(b.setCookie))).toEqual({ rejection: 401 })
  expect(ctx.get('educationPeers')).toBeUndefined()
})

it('revalidates expired and disabled idle Peers and bounds the active scope registry', async () => {
  await fiber.dispose()
  const carrier = ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth, true) })
  await carrier.await()
  await mount({ adaptConnection: true, maxPeers: 1, peerSweepIntervalMs: 10, sessionLifetimeMs: 60_000 })
  await expect.poll(() => ctx.get('educationPeers')).toBeDefined()
  const a = await login()
  const b = await login('employee-b')
  const admission = ctx.connection.admit(request(a.setCookie))
  if ('rejection' in admission) throw new Error('first employee refused')
  const signal = ctx.educationPeers.signal(admission.peer)
  expect(ctx.connection.admit(request(b.setCookie))).toEqual({ rejection: 403 })
  repository.setUserStatus(organizationId, a.user.id, 'disabled')
  await expect.poll(() => signal.aborted).toBe(true)
  const second = ctx.connection.admit(request(b.setCookie))
  if ('rejection' in second) throw new Error('released slot was not reused')
  const secondSignal = ctx.educationPeers.signal(second.peer)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 60_001)
  await expect.poll(() => secondSignal.aborted).toBe(true)
  expect(ctx.connection.admit(request(b.setCookie))).toEqual({ rejection: 401 })
})

it('uses independent durable logins for concurrent employees and repeated logins', async () => {
  const [a, b, again] = await Promise.all([login('employee-a'), login('employee-b'), login('employee-a')])
  const actorA = identity.me(request(a.setCookie)).actor
  const actorB = identity.me(request(b.setCookie)).actor
  const actorAgain = identity.me(request(again.setCookie)).actor
  expect(actorA.userId).not.toBe(actorB.userId)
  expect(actorA.loginSessionId).not.toBe(actorAgain.loginSessionId)
  expect(actorAgain.userId).toBe(actorA.userId)
})

it('stores a token digest rather than its raw cookie and preserves password spaces', async () => {
  const spaced = '  synthetic-spaced-password  '
  repository.provisionUser({ organizationId, usernameNormalized: 'spaced-user', ...await createPasswordCredential(spaced) })
  await expect(identity.signIn(request(), { username: 'spaced-user', password: spaced.trim() })).rejects.toMatchObject({ code: 'unauthenticated' })
  const result = await identity.signIn(request(), { username: 'spaced-user', password: spaced })
  const rawToken = result.setCookie.split(';', 1)[0]!.split('=', 2)[1]!
  const db = new DatabaseSync(path)
  try {
    const hashes = db.prepare('SELECT token_hash FROM login_sessions').all().map(row => row.token_hash)
    expect(hashes).toHaveLength(1)
    expect(hashes).not.toContain(rawToken)
    expect(JSON.stringify(identity.me(request(result.setCookie)))).not.toContain(rawToken)
  } finally { db.close() }
})

it('does not reveal whether an unknown, disabled or wrong-password account exists', async () => {
  const a = await login()
  repository.setUserStatus(organizationId, a.user.id, 'disabled')
  for (const input of [
    { username: 'employee-a', password }, { username: 'unknown-user', password },
    { username: 'employee-b', password: 'synthetic-wrong-password' },
  ]) {
    await expect(identity.signIn(request(), input)).rejects.toMatchObject({ code: 'unauthenticated', message: 'employee credentials or login are invalid' })
  }
})

it('requires matching mutation Origin and rejects forged Host without allocating a login', async () => {
  for (const headers of [
    { host: 'evil.example', origin }, { host: '127.0.0.1:12345', origin: 'https://evil.example' },
    { host: '127.0.0.1:12345' }, { host: 'user@127.0.0.1:12345', origin },
  ]) {
    await expect(login('employee-a', { headers, remoteAddress: '127.0.0.1' })).rejects.toMatchObject({ code: 'forbidden' })
  }
  const db = new DatabaseSync(path)
  try { expect(db.prepare('SELECT COUNT(*) AS count FROM login_sessions').get()?.count).toBe(0) }
  finally { db.close() }
})

it('sets secure HTTPS cookies and keeps local HTTP cookies distinct from native operator cookies', async () => {
  const local = await login()
  expect(local.setCookie).toContain('Path=/; HttpOnly; SameSite=Strict; Max-Age=43200')
  expect(local.setCookie).not.toContain('; Secure')
  await fiber.dispose()
  await mount({ publicOrigin: 'https://education.example' })
  const result = await login('employee-a', { headers: { host: 'education.example', origin: 'https://education.example' }, remoteAddress: '127.0.0.1' })
  expect(result.setCookie).toMatch(/^__Host-education-business-session=/)
  expect(result.setCookie).toContain('; Secure')
})

it('revokes one session, clears its cookie and keeps another employee authenticated', async () => {
  const [a, b] = await Promise.all([login(), login('employee-b')])
  expect(identity.signOut(request(a.setCookie))).toContain('Max-Age=0')
  expect(identity.actor(request(a.setCookie))).toBeNull()
  expect(identity.me(request(b.setCookie)).user.id).toBe(b.user.id)
  expect(identity.signOut(request(a.setCookie))).toContain('Max-Age=0')
  expect(() => identity.signOut({ headers: { host: '127.0.0.1:12345', cookie: b.setCookie }, remoteAddress: '127.0.0.1' }))
    .toThrow(expect.objectContaining({ code: 'forbidden' }))
})

it('checks durable expiry, disable and permission revision on each request', async () => {
  await fiber.dispose()
  await mount({ sessionLifetimeMs: 60_000 })
  const a = await login()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 60_000)
  expect(identity.actor(request(a.setCookie))).toBeNull()
  expect(() => identity.me(request(a.setCookie))).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  vi.useRealTimers()
  const b = await login('employee-b')
  repository.setUserStatus(organizationId, b.user.id, 'disabled')
  expect(identity.actor(request(b.setCookie))).toBeNull()
  repository.setUserStatus(organizationId, b.user.id, 'active')
  expect(identity.actor(request(b.setCookie))).toBeNull()
})

it('preserves valid login state through provider and repository restart', async () => {
  const a = await login()
  const previous = identity.me(request(a.setCookie))
  await ctx.fiber.dispose()
  repository.close()
  repository = await SqliteEducationRepository.open(resolveConfig({ path }))
  ctx = new Context()
  ctx.provide('educationRepository', repository)
  await mount()
  expect(identity.me(request(a.setCookie))).toEqual(previous)
})

it('rejects malformed and duplicate cookie tokens', async () => {
  const a = await login()
  for (const cookie of ['education-business-session=invalid', `${a.setCookie}; ${a.setCookie}`, 'native-cookie=anything']) {
    expect(identity.actor(request(cookie))).toBeNull()
  }
  expect(identity.actor(request())).toBeNull()
})

it('limits username failures across addresses and resets after the configured window', async () => {
  await fiber.dispose()
  await mount({ loginAttempts: 1, loginWindowMs: 1_000 })
  await expect(identity.signIn(request(undefined, 'address-a'), { username: 'employee-a', password: 'wrong' })).rejects.toMatchObject({ code: 'unauthenticated' })
  await expect(login('employee-a', request(undefined, 'address-b'))).rejects.toMatchObject({ code: 'rate-limited' })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 1_001)
  expect((await login('employee-a', request(undefined, 'address-b'))).user.username).toBe('employee-a')
})

it('bounds concurrent verifications and drains an in-flight attempt on unload without minting a login', async () => {
  await fiber.dispose()
  await mount({ maxConcurrentVerifications: 1 })
  const pending = login()
  const settlement = pending.catch((error: unknown) => error)
  await expect(login('employee-b')).rejects.toMatchObject({ code: 'rate-limited' })
  await fiber.dispose()
  expect(await settlement).toMatchObject({ code: 'closed' })
  expect(ctx.get('educationIdentity')).toBeUndefined()
  const db = new DatabaseSync(path)
  try { expect(db.prepare('SELECT COUNT(*) AS count FROM login_sessions').get()?.count).toBe(0) }
  finally { db.close() }
})

it('does not create a login after its request is canceled', async () => {
  const control = new AbortController()
  const result = login('employee-a', { ...request(), signal: control.signal })
  control.abort()
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  const db = new DatabaseSync(path)
  try { expect(db.prepare('SELECT COUNT(*) AS count FROM login_sessions').get()?.count).toBe(0) }
  finally { db.close() }
})

it.each([null, [], { username: 'employee-a', password, owner: 'forged-owner' }, { username: 'x', password },
  { username: 'employee-a', password: '' }])('validates external login JSON without accepting owner overrides (%j)', async (input) => {
  await expect(identity.signIn(request(), input)).rejects.toMatchObject({ code: 'validation-failed' })
})

it('rejects non-HTTPS remote origins and path-bearing origin configuration', async () => {
  await fiber.dispose()
  for (const publicOrigin of ['http://education.example', 'https://education.example/path', 'https://user:password@education.example']) {
    expect(() => new EducationIdentityProvider(ctx, { organizationId, publicOrigin }))
      .toThrow(expect.objectContaining({ code: 'validation-failed' }))
  }
})
