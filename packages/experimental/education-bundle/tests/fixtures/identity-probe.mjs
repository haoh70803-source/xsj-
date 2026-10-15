/** Real HTTP employee logins after the supported Profile is ready; all data is synthetic. */
import { randomUUID } from 'node:crypto'
import { verifyAuthorization } from './authorization-probe.mjs'
import { verifyController } from './controller-probe.mjs'

export const name = 'education-identity-http-test-probe'
export const inject = ['educationIdentity', 'educationPlatform', 'educationPeers', 'connection', 'typertGateway',
  'educationAuthorization', 'educationController', 'typert', 'agents', 'sessionController', 'webServer', 'appReady', 'appExit']

export function apply(ctx) {
  const exit = ctx.appExit
  const logger = ctx.logger
  ctx.effect(() => ctx.appReady.onReady(() => {
    void verify(ctx).then(() => exit(0), error => {
      logger.error(error)
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      exit(1)
    })
  }), 'education-identity-test: HTTP readiness probe')
}

async function verify(ctx) {
  const identity = ctx.educationIdentity
  const repository = ctx.educationPlatform.repository
  const connection = ctx.connection
  const peers = ctx.educationPeers
  ctx.educationAuthorization.register({
    matches: access => (access.kind === 'rpc' && access.channel === '/education-test' && access.endpoint === 'current')
      || (access.kind === 'fetch' && access.url.pathname === '/api/education-test-download'),
    allows: () => true,
  })
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const send = (path, cookie, input) => fetch(`${origin}/education/auth/${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  })
  const [aResponse, bResponse] = await Promise.all(['identity-a', 'identity-b'].map(username =>
    send('sign-in', undefined, { username, password: 'synthetic-profile-identity-password' })))
  if (aResponse.status !== 200 || bResponse.status !== 200) throw new Error('HTTP sign-in did not succeed')
  const aCookie = aResponse.headers.get('set-cookie')
  const bCookie = bResponse.headers.get('set-cookie')
  if (!aCookie || !bCookie || !aCookie.includes('HttpOnly') || !aCookie.includes('SameSite=Strict')) throw new Error('secure cookie flags missing')
  const aUser = await aResponse.json()
  const bUser = await bResponse.json()
  if (Object.keys(aUser).join(',') !== 'user' || aUser.user.id === bUser.user.id) throw new Error('HTTP employee response was not isolated')
  const me = await send('me', aCookie)
  if (me.status !== 200 || me.headers.get('cache-control') !== 'no-store') throw new Error('current employee or cache control failed')
  const actorA = identity.me({ headers: { host: new URL(origin).host, cookie: aCookie }, remoteAddress: '127.0.0.1' }).actor
  const actorB = identity.me({ headers: { host: new URL(origin).host, cookie: bCookie }, remoteAddress: '127.0.0.1' }).actor
  const created = repository.createProject(actorA, { title: '合成 HTTP 身份项目 A', scenario: 'spoken-script', requestId: randomUUID() })
  if (repository.listProjects(actorB, { limit: 10 }).items.length !== 0) throw new Error('employee B received private project A')
  const receivedPeers = new Map()
  connection.rpc.handle('/education-test', async (_endpoint, _payload, _signal, peer) => {
    const actor = peers.actor(peer)
    receivedPeers.set(actor.userId, peer)
    return { ok: true, value: { userId: actor.userId, peerId: peer.id,
      titles: repository.listProjects(actor, { limit: 10 }).items.map(project => project.title) } }
  })
  connection.fetch.register({ path: '/api/education-test-download', methods: ['GET'], requestBody: 'buffered',
    fetch: async (_request, peer) => Response.json({ userId: peers.actor(peer).userId, peerId: peer.id }),
  })
  const call = cookie => fetch(`${origin}/education-test/current`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'current', payload: { owner: actorB.userId } }),
  })
  const [aRpc, bRpc] = await Promise.all([call(aCookie), call(bCookie)])
  if (aRpc.status !== 200 || bRpc.status !== 200) throw new Error('employee RPC admission failed')
  const aValue = (await aRpc.json()).result.value
  const bValue = (await bRpc.json()).result.value
  if (aValue.userId !== actorA.userId || bValue.userId !== actorB.userId || aValue.peerId === bValue.peerId
    || !aValue.titles.includes('合成 HTTP 身份项目 A') || bValue.titles.length !== 0) throw new Error('RPC leaked employee identity or private content')
  if ((await (await call(aCookie)).json()).result.value.peerId !== aValue.peerId) throw new Error('login Peer was not stable')
  const download = await fetch(`${origin}/api/education-test-download`, { headers: { Cookie: aCookie, Origin: origin } })
  const downloaded = await download.json()
  if (downloaded.userId !== actorA.userId || downloaded.peerId !== aValue.peerId) throw new Error('Fetch did not retain admitted Peer')
  const peerA = receivedPeers.get(actorA.userId)
  if (!peerA) throw new Error('missing RPC Peer')
  const revoked = peers.signal(peerA)
  const { aEvents, bEvents } = await verifyAuthorization(ctx, origin, actorA, actorB, aCookie, bCookie, created)
  const controllerProof = await verifyController(ctx, origin, aCookie, bCookie, actorA)
  const forged = await fetch(`${origin}/education/auth/sign-in`, {
    method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'identity-a', password: 'synthetic-profile-identity-password' }),
  })
  if (forged.status !== 403) throw new Error('cross-origin sign-in was not rejected')
  const oversized = await send('sign-in', undefined, { username: 'identity-a', password: 'x'.repeat(5_000) })
  if (oversized.status !== 413) throw new Error('auth request body was not bounded')
  const out = await send('sign-out', aCookie, {})
  if (out.status !== 200 || !out.headers.get('set-cookie')?.includes('Max-Age=0')) throw new Error('logout cookie was not cleared')
  if ((await send('me', aCookie)).status !== 401 || (await send('me', bCookie)).status !== 200) throw new Error('logout affected the wrong employee')
  if (!revoked.aborted || (await call(aCookie)).status !== 401 || (await call(bCookie)).status !== 200) throw new Error('logout Peer was not isolated')
  await aEvents.closed
  await controllerProof.projectFollowClosed
  if (bEvents.state.closed) throw new Error('employee A logout closed employee B WebSocket')
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'education-identity')
  if (!entry?.fiber) throw new Error('identity Loader entry is missing')
  await entry.fiber.dispose()
  await bEvents.closed
  if ((await send('me', bCookie)).status !== 404 || ctx.get('educationIdentity') !== undefined) throw new Error('identity routes survived unload')
  if (ctx.get('educationController') !== undefined) throw new Error('business Controller survived identity unload')
  if ('peer' in connection.admit({ headers: { host: new URL(origin).host, cookie: bCookie } })) throw new Error('withdrawn policy admitted a Peer')
  process.stdout.write(`EDUCATION_IDENTITY_HTTP_PROBE ${JSON.stringify({
    employees: 2, cookieProtected: true, originDenied: true, logoutIsolated: true, routesRemoved: true, projectId: created.projectId,
    requestPeers: true, fetchPeers: true, revokedPeer: true, policyWithdrawn: true,
    websocketLogoutIsolated: true,
  })}\n`)
}
