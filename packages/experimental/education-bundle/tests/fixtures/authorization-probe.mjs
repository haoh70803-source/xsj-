/** Real employee ownership against native Session history and Gateway event delivery. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const check = (condition, message) => { if (!condition) throw new Error(message) }

async function until(predicate) {
  const end = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('authorization probe timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Verify authorization with real Profiles; return the two event sockets for the existing A-06 logout assertions. */
export async function verifyAuthorization(ctx, origin, actorA, actorB, aCookie, bCookie, projectA) {
  const repository = ctx.educationPlatform.repository
  const authorization = ctx.educationAuthorization
  const projectB = repository.createProject(actorB, { title: 'private-project-B-marker', scenario: 'spoken-script', requestId: randomUUID() })
  const createAgent = () => ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: process.cwd() }, setup: (agentCtx) => {
    agentCtx.tools.restrict({ allow: [] })
  } })
  const [handleA, handleB] = await Promise.all([createAgent(), createAgent()])
  for (const [handle, marker] of [[handleA, 'private-session-A-marker'], [handleB, 'private-session-B-marker']]) {
    handle.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: marker }], source: { kind: 'user' } }),
      { surfaceOp: 'append' })
  }
  const bind = (actor, project, handle) => authorization.bindAgent(actor, {
    projectId: project.projectId, artifactId: project.artifactId, harnessSessionId: handle.agent.id, requestId: randomUUID(),
  }, handle)
  await bind(actorA, projectA, handleA)
  await bind(actorB, projectB, handleB)
  const call = async (cookie, endpoint, args) => {
    const response = await fetch(`${origin}/api/${endpoint}`, { method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
    })
    return { status: response.status, text: await response.text() }
  }
  const pageArgs = id => ({ request: { address: { kind: 'session', sessionId: id }, throughSeq: 0 } })
  // Page cuts belong to the Session log; native follow supplies the authoritative cursor below.
  const open = async (cookie, streamId, endpoint = '$events', args = {}) => {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: { Cookie: cookie, Origin: origin } })
    const frames = []
    const state = { closed: false }
    const closed = new Promise(resolve => socket.once('close', () => { state.closed = true; resolve() }))
    socket.on('message', data => { frames.push(JSON.parse(String(data))) })
    ctx.effect(() => async () => { socket.terminate(); await closed }, 'education-authorization-test: socket')
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    await until(() => frames.some(frame => frame.streamId === streamId))
    return { socket, frames, state, closed, streamId }
  }
  const ownFollow = await open(aCookie, 'own-follow', 'session/follow', { request: { address: { kind: 'session', sessionId: handleA.agent.id } } })
  const snapshot = ownFollow.frames.find(frame => frame.type === 'item')?.value
  check(snapshot?.type === 'snapshot' && JSON.stringify(snapshot).includes('private-session-A-marker'),
    `native own Session follow failed: ${JSON.stringify(ownFollow.frames)}`)
  const cut = snapshot.cursor
  const args = pageArgs(handleA.agent.id)
  args.request.throughSeq = cut
  const own = await call(aCookie, 'session/page', args)
  check(own.status === 200 && own.text.includes('private-session-A-marker'), 'native own Session page failed')
  let internalDenied = false
  try { await ctx.typertGateway.invoke({ namespace: 'session', method: 'page', args }) }
  catch (error) { internalDenied = error?.code === 'gateway/cancelled' }
  check(internalDenied, 'internal operator bypassed employee resource authorization')
  const foreign = await call(bCookie, 'session/page', args)
  const missing = await call(bCookie, 'session/page', { request: { ...args.request, address: { kind: 'session', sessionId: randomUUID() } } })
  check(foreign.status === 403 && foreign.text === missing.text, 'native foreign/missing Session responses differed')
  const forged = await call(bCookie, 'session/page', { request: { ...args.request, owner: actorA.userId } })
  check(forged.status === 403, 'forged owner granted Session access')
  const foreignFollow = await open(bCookie, 'foreign-follow', 'session/follow', { request: args.request })
  check(foreignFollow.frames.some(frame => frame.type === 'error') && !JSON.stringify(foreignFollow.frames).includes('private-session-A-marker'),
    'WebSocket exposed a foreign Session')
  for (const endpoint of ['session/list', 'session/search', 'session/control', 'session/create', 'session/prompt', 'session/cancel',
    'session/fork', 'workspaceFiles/read', 'credentials/list', 'terminal/execute', 'plugins/list', 'config/read']) {
    const denied = await call(aCookie, endpoint, { request: { sessionId: handleA.agent.id } })
    check(endpoint.startsWith('session/') ? denied.status === 403 : [403, 404].includes(denied.status),
      `unexposed native operation was reachable: ${endpoint}`)
  }
  const upload = await fetch(`${origin}/api/session/uploadFileBinary`, { method: 'POST',
    headers: { Cookie: aCookie, Origin: origin, 'Content-Type': 'application/octet-stream' }, body: 'synthetic-file-marker' })
  check(upload.status === 403, 'mounted native file upload bypassed the resource policy')
  for (const cookie of [aCookie, bCookie]) {
    for (const method of ['GET', 'HEAD']) {
      const exported = await fetch(`${origin}/api/session.export?sessionId=${handleA.agent.id}`, {
        method, headers: { Cookie: cookie, Origin: origin },
      })
      check(exported.status === 403, 'mounted native log export bypassed the resource policy')
    }
  }
  const unbound = await createAgent()
  check((await call(aCookie, 'session/projections', { request: { sessionId: unbound.agent.id } })).status === 403, 'unbound native Session was exposed')
  await unbound.dispose()
  const failed = await createAgent()
  let rejected = false
  try { await bind(actorB, projectA, failed) } catch (error) { rejected = error?.code === 'resource-unavailable' }
  check(rejected && ctx.agents.get(failed.agent.id) === undefined, 'failed business binding did not release native Agent')
  check((await call(aCookie, 'session/projections', { request: { sessionId: failed.agent.id } })).status === 403, 'failed binding remained reachable')

  const queue = []
  let wake
  ctx.effect(() => ctx.typertGateway.registerRemoteEvents(signal => (async function* () {
    const abort = () => wake?.()
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        while (queue.length > 0) yield queue.shift()
        if (!signal.aborted) await new Promise(resolve => { wake = resolve })
      }
    } finally { signal.removeEventListener('abort', abort) }
  })(), { home: '/private-server-home-must-not-leak' }), 'education-authorization-test: event source')
  const push = dispatch => { queue.push(dispatch); wake?.(); wake = undefined }
  const pending = (handle, marker) => {
    const settled = Promise.withResolvers()
    void settled.promise.catch(() => undefined) // Failure cleanup can reject an already-asserted pending request.
    push({ event: 'education/validation', request: { prompt: marker, agent: handle.agent },
      context: { value: handle.agent.ctx, subject: handle.agent, agentId: handle.agent.id },
      resolve: settled.resolve, reject: settled.reject })
    return settled.promise
  }
  const early = pending(handleA, 'private-pending-A-marker')
  await new Promise(resolve => setImmediate(resolve))
  const [aEvents, bEvents] = await Promise.all([open(aCookie, 'events-a'), open(bCookie, 'events-b')])
  const eventFrame = client => client.frames.find(frame => frame.value?.type === 'waterfall')?.value
  await until(() => eventFrame(aEvents) !== undefined)
  check(!JSON.stringify(bEvents.frames).includes('private-pending-A-marker'), 'pending initial event leaked to employee B')
  check(!JSON.stringify(aEvents.frames).includes('private-server-home'), 'private Host home leaked in ready metadata')
  const clientId = aEvents.frames.find(frame => frame.value?.type === 'ready').value.clientId
  const replyArgs = { clientId, eventId: eventFrame(aEvents).eventId, outcome: { kind: 'result', value: 'owner-A-approved' } }
  const forgedReply = await call(bCookie, '$events/result', replyArgs)
  check(forgedReply.status === 200 && JSON.parse(forgedReply.text).result.ok === false, 'foreign Peer settled an owner event')
  check(JSON.parse((await call(aCookie, '$events/result', replyArgs)).text).result.ok === true, 'owner event reply rejected')
  check((await early).value === 'owner-A-approved', 'owner event settled incorrectly')
  const forgedSubject = Promise.withResolvers()
  const forgedAbort = new AbortController()
  void forgedSubject.promise.catch(() => undefined)
  push({ event: 'education/validation', request: { prompt: 'forged-agent-private-marker', agent: handleB.agent, signal: forgedAbort.signal },
    context: { value: handleB.agent.ctx, subject: handleB.agent, agentId: handleA.agent.id },
    resolve: forgedSubject.resolve, reject: forgedSubject.reject })
  const queuedForReconnect = pending(handleA, 'private-reconnect-A-marker')
  await until(() => JSON.stringify(aEvents.frames).includes('private-reconnect-A-marker'))
  check(!JSON.stringify(aEvents.frames).includes('forged-agent-private-marker')
    && !JSON.stringify(bEvents.frames).includes('forged-agent-private-marker'), 'event Agent subject did not match its declared identity')
  forgedAbort.abort(new Error('synthetic forged-subject probe cleanup'))
  await forgedSubject.promise.catch(error => check(error instanceof Error, 'forged event cleanup did not reject'))
  push({ event: 'session/global-private', args: ['private-global-marker'] })
  const later = pending(handleB, 'private-realtime-B-marker')
  await until(() => JSON.stringify(bEvents.frames).includes('private-realtime-B-marker'))
  check(!JSON.stringify(aEvents.frames).includes('private-realtime-B-marker'), 'realtime event leaked to employee A')
  check(!JSON.stringify(aEvents.frames).includes('private-global-marker') && !JSON.stringify(bEvents.frames).includes('private-global-marker'),
    'global private event was broadcast')
  const bClientId = bEvents.frames.find(frame => frame.value?.type === 'ready').value.clientId
  await call(bCookie, '$events/result', { clientId: bClientId, eventId: eventFrame(bEvents).eventId, outcome: { kind: 'next' } })
  await later
  const reconnect = await open(bCookie, 'events-b-reconnected')
  check(!JSON.stringify(reconnect.frames).includes('private-reconnect-A-marker'), 'reconnected foreign client received private pending data')
  const reconnectFrame = aEvents.frames.find(frame => frame.value?.request?.prompt === 'private-reconnect-A-marker')?.value
  check(reconnectFrame, 'owner reconnect validation event missing')
  await call(aCookie, '$events/result', { clientId, eventId: reconnectFrame.eventId, outcome: { kind: 'next' } })
  await queuedForReconnect
  reconnect.socket.terminate()
  await reconnect.closed
  const cResponse = await fetch(`${origin}/education/auth/sign-in`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'identity-c', password: 'synthetic-profile-identity-password' }) })
  const cCookie = cResponse.headers.get('set-cookie')
  check(cResponse.status === 200 && cCookie, 'third validation employee login failed')
  const actorC = ctx.educationIdentity.me({ headers: { host: new URL(origin).host, cookie: cCookie }, remoteAddress: '127.0.0.1' }).actor
  const cProject = repository.createProject(actorC, { title: 'revocation-validation', scenario: 'spoken-script', requestId: randomUUID() })
  const cHandle = await createAgent()
  await bind(actorC, cProject, cHandle)
  const cEvents = await open(cCookie, 'events-c')
  await authorization.invalidateSession(actorC, cHandle.agent.id)
  await cEvents.closed
  check(ctx.agents.get(cHandle.agent.id) === undefined, 'invalidated association retained its Agent')
  check((await call(cCookie, 'session/projections', { request: { sessionId: cHandle.agent.id } })).status === 403,
    'invalidated binding became accessible after reconnect')
  check(!aEvents.state.closed && !bEvents.state.closed, 'binding invalidation affected another employee')
  process.stdout.write('EDUCATION_RESOURCE_AUTHORIZATION_PROBE {"nativeHistory":true,"foreignDenied":true,"eventsIsolated":true,"bindingCompensated":true,"revocationClosed":true}\n')
  return { aEvents, bEvents }
}
