/** Actual education RPC, optimistic transactions, follow and text downloads through the selected Profile. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'

const check = (condition, message) => { if (!condition) throw new Error(message) }
async function until(predicate) {
  const end = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Controller probe timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export async function verifyController(ctx, origin, aCookie, bCookie, actorA) {
  if (process.env.EDUCATION_TEST_MODE === 'lib') {
    const { TYPERT_REMOTE } = await import('@deepseek-ai/dsh-experimental-education-controller/remote')
    check(TYPERT_REMOTE.descriptors.length === 53 && TYPERT_REMOTE.descriptors.every(method =>
      method.parameters.every(parameter => parameter.codec.mode === 'strict')), 'published Remote contribution was incomplete')
    check(ctx.typert.local.get('education/projectsCreate')?.parameters[0]?.codec.mode === 'strict',
      'built Controller did not activate strict Host descriptors')
  }
  const send = async (cookie, method, request) => {
    const endpoint = `education/${method}`
    const response = await fetch(`${origin}/api/${endpoint}`, { method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args: { request } } }),
    })
    const text = await response.text()
    return { status: response.status, text, result: response.status === 200 ? JSON.parse(text).result : undefined }
  }
  const ok = async (method, request, cookie = aCookie) => {
    const reply = await send(cookie, method, request)
    check(reply.status === 200 && reply.result?.ok, `RPC ${method} failed: ${reply.text}`)
    return reply.result.value
  }
  const creation = { title: 'Controller private project A', scenario: 'spoken-script', requestId: randomUUID() }
  const project = await ok('projectsCreate', creation)
  check(JSON.stringify(await ok('projectsCreate', creation)) === JSON.stringify(project), 'project idempotency failed')
  const wrongKey = await send(aCookie, 'projectsCreate', { ...creation, title: 'changed same key' })
  check(wrongKey.result?.error?.code === 'education/IDEMPOTENCY_CONFLICT', 'idempotency error was not structured')
  const foreign = await send(bCookie, 'projectsOpen', { projectId: project.projectId })
  const absent = await send(bCookie, 'projectsOpen', { projectId: randomUUID() })
  check(foreign.status === 403 && foreign.text === absent.text, 'foreign and nonexistent projects were distinguishable')
  const invalid = await send(aCookie, 'projectsCreate', { ...creation, requestId: randomUUID(), owner: 'forged-owner' })
  check(invalid.result?.ok === false && invalid.result.error.code === 'education/INPUT_INVALID'
    && typeof invalid.result.error.message === 'string', 'owner override was accepted or lacked a complete failure envelope')
  const moments = await ok('projectsCreate', { ...creation, requestId: randomUUID(), scenario: 'moments' })
  check((await ok('projectsOpen', { projectId: moments.projectId })).project.scenario === 'moments',
    'the supported moments scenario did not persist')
  for (const request of [{ ...creation, requestId: randomUUID(), scenario: 'unsupported-scenario' },
    { ...creation, requestId: randomUUID(), title: '中'.repeat(100) }]) {
    check((await send(aCookie, 'projectsCreate', request)).result?.ok === false, 'invalid creation fields were accepted')
  }
  const opened = await ok('projectsOpen', { projectId: project.projectId })
  check(opened.draft.revision === 0 && opened.latestVersion === null && opened.sessionBindings.length === 0, 'initial state was not authoritative')
  const missingNativeId = randomUUID()
  ctx.educationPlatform.repository.bindSession(actorA, { projectId: project.projectId, artifactId: project.artifactId,
    harnessSessionId: missingNativeId, requestId: randomUUID() })
  const checkedBinding = await ok('projectsOpen', { projectId: project.projectId })
  check(checkedBinding.sessionBindings[0].status === 'invalid' && ctx.agents.get(missingNativeId) === undefined,
    'missing native binding was not reported without resuming an Agent')
  const requestA = { artifactId: project.artifactId, body: '  V1 中文😀\r\n正文  \r', expectedDraftRevision: 0, requestId: randomUUID() }
  const synced = await ok('draftsSync', requestA)
  const firstSave = { artifactId: project.artifactId, expectedDraftRevision: synced.revision, expectedLatestVersionId: null, requestId: randomUUID() }
  const v1 = await ok('artifactsSaveVersion', firstSave)
  const v1Body = '  V1 中文😀\n正文  \r'
  check((await ok('artifactsReadVersion', { artifactId: project.artifactId, versionId: v1.versionId })).body === v1Body, 'V1 text changed')
  const drafts = await Promise.all(['winning-draft-one', 'winning-draft-two'].map(body =>
    send(aCookie, 'draftsSync', { artifactId: project.artifactId, body, expectedDraftRevision: 1, requestId: randomUUID() })))
  check(drafts.filter(reply => reply.result?.ok).length === 1
    && drafts.some(reply => reply.result?.error?.code === 'education/DRAFT_CONFLICT'), 'concurrent draft writes did not conflict')
  const revision2 = (await ok('projectsOpen', { projectId: project.projectId })).draft
  const saveBase = { artifactId: project.artifactId, expectedDraftRevision: revision2.revision, expectedLatestVersionId: v1.versionId }
  const saves = await Promise.all([1, 2].map(() => send(aCookie, 'artifactsSaveVersion', { ...saveBase, requestId: randomUUID() })))
  check(saves.filter(reply => reply.result?.ok).length === 1
    && saves.some(reply => reply.result?.error?.code === 'education/VERSION_CONFLICT'), 'concurrent formal saves did not conflict')
  const v2 = saves.find(reply => reply.result?.ok).result.value
  check(JSON.stringify(await ok('artifactsSaveVersion', firstSave)) === JSON.stringify(v1), 'save replay used a changed latest pointer')
  const restored = await ok('draftsRestoreVersion', { artifactId: project.artifactId, versionId: v1.versionId,
    expectedDraftRevision: revision2.revision, requestId: randomUUID() })
  check((await ok('projectsOpen', { projectId: project.projectId })).artifact.latestVersionId === v2.versionId, 'restore changed formal history')
  const v3 = await ok('artifactsSaveVersion', { artifactId: project.artifactId, expectedDraftRevision: restored.revision,
    expectedLatestVersionId: v2.versionId, requestId: randomUUID() })
  check(v3.versionNo === 3 && (await ok('artifactsReadVersion', { artifactId: project.artifactId, versionId: v1.versionId })).body === v1Body,
    'restore/save did not append V3 while preserving V1')
  const unsavedBody = '  unsaved-draft-export-marker 😀  '
  const currentDraft = await ok('draftsSync', { artifactId: project.artifactId, body: unsavedBody,
    expectedDraftRevision: restored.revision, requestId: randomUUID() })
  const crossVersion = await send(aCookie, 'artifactsReadVersion', { artifactId: project.artifactId, versionId: randomUUID() })
  check(crossVersion.result?.error?.code === 'education/RESOURCE_UNAVAILABLE', 'unknown version exposed a nonuniform resource error')
  const result = await ok('requestsGetResult', { operation: 'artifacts.saveVersion', requestId: firstSave.requestId })
  check(result.versionId === v1.versionId, 'uncertain result query lost the original version')
  check(await ok('requestsGetResult', { operation: 'artifacts.saveVersion', requestId: firstSave.requestId }, bCookie) === null,
    'foreign request result leaked')
  const versions = await ok('artifactsListVersions', { artifactId: project.artifactId, limit: 1 })
  check(versions.items.length === 1 && versions.items[0].versionNo === 3 && !('body' in versions.items[0]) && versions.nextCursor,
    'version metadata pagination failed')
  check((await ok('artifactsListVersions', { artifactId: project.artifactId, limit: 1, cursor: versions.nextCursor })).items[0].versionNo === 2,
    'version cursor was not stable')
  const projectPage = await ok('projectsList', { limit: 1 })
  check(projectPage.items.length === 1 && !('draft' in projectPage.items[0]), 'project list leaked full text')
  if (projectPage.nextCursor) check((await send(bCookie, 'projectsList', { limit: 1, cursor: projectPage.nextCursor })).result?.ok === false,
    'foreign page cursor accepted')
  const exportUrl = params => `${origin}/api/education/artifacts.exportText?${new URLSearchParams(params)}`
  const download = async (cookie, params, method = 'GET') => fetch(exportUrl(params), { method, headers: { Cookie: cookie, Origin: origin } })
  for (const target of ['draft', 'version']) {
    const params = { artifactId: project.artifactId, target, ...(target === 'version' ? { versionId: v1.versionId } : {}) }
    const exported = await download(aCookie, params)
    const expectedBody = target === 'draft' ? unsavedBody : v1Body
    check(exported.status === 200 && await exported.text() === expectedBody, 'explicit text export source was wrong')
    check(exported.headers.get('cache-control') === 'no-store' && exported.headers.get('content-type') === 'text/plain; charset=utf-8'
      && exported.headers.get('x-content-type-options') === 'nosniff', 'private export response headers failed')
    const head = await download(aCookie, params, 'HEAD')
    check(head.status === 200 && await head.text() === '' && Number(head.headers.get('content-length')) === Buffer.byteLength(expectedBody),
      'HEAD export metadata or body failed')
    check((await download(bCookie, params)).status === 403, 'foreign employee exported private text')
  }
  for (const params of [{ artifactId: project.artifactId, target: 'version' },
    { artifactId: project.artifactId, target: 'draft', versionId: v1.versionId },
    { artifactId: project.artifactId, target: 'draft', path: 'C:/private-file' }]) {
    check((await download(aCookie, params)).status === 400, 'invalid export fields were accepted')
  }
  check((await fetch(`${exportUrl({ artifactId: project.artifactId, target: 'draft' })}&target=version`,
    { headers: { Cookie: aCookie, Origin: origin } })).status === 400, 'duplicate export fields were accepted')
  const inspect = new DatabaseSync(process.env.EDUCATION_DATABASE_PATH)
  const beforeFault = await ok('projectsOpen', { projectId: project.projectId })
  try {
    inspect.exec("CREATE TRIGGER education_controller_fault BEFORE INSERT ON audit_records WHEN NEW.action = 'artifacts.saveVersion' BEGIN SELECT RAISE(ABORT, 'synthetic-private-db-diagnostic'); END")
    const failedRequest = { artifactId: project.artifactId, expectedDraftRevision: beforeFault.draft.revision,
      expectedLatestVersionId: v3.versionId, requestId: randomUUID() }
    const failed = await send(aCookie, 'artifactsSaveVersion', failedRequest)
    check(failed.result?.error?.code === 'education/STORAGE_UNAVAILABLE' && !failed.text.includes('synthetic-private-db-diagnostic')
      && !failed.text.includes(process.env.EDUCATION_DATABASE_PATH), 'storage failure leaked private diagnostics')
    check((await ok('projectsOpen', { projectId: project.projectId })).artifact.latestVersionId === v3.versionId, 'failed save changed the pointer')
    check(await ok('requestsGetResult', { operation: 'artifacts.saveVersion', requestId: failedRequest.requestId }) === null, 'failed save retained a receipt')
    inspect.exec('DROP TRIGGER education_controller_fault')
    check((await ok('artifactsSaveVersion', failedRequest)).versionNo === 4, 'retry after rolled-back save was not safe')
  } finally { inspect.close() }
  const follow = async (cookie, id, streamId) => {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: { Cookie: cookie, Origin: origin } })
    const frames = []
    const closed = new Promise(resolve => socket.once('close', resolve))
    socket.on('message', data => { frames.push(JSON.parse(String(data))) })
    ctx.effect(() => async () => { socket.terminate(); await closed }, 'education-controller-test: project socket')
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'education/projectsFollow', payload: { args: { request: { projectId: id } } } }))
    await until(() => frames.length > 0)
    return { socket, frames, closed }
  }
  const ownFollow = await follow(aCookie, project.projectId, 'private-project-a')
  check(ownFollow.frames.some(frame => frame.value?.type === 'snapshot'), 'project follow lacked its opening snapshot')
  const excess = await follow(aCookie, project.projectId, 'excess-project-a')
  check(excess.frames.some(frame => frame.error?.code === 'education/PROVIDER_UNAVAILABLE'), 'subscription capacity was not bounded')
  excess.socket.terminate()
  await excess.closed
  const foreignFollow = await follow(bCookie, project.projectId, 'foreign-project-a')
  check(foreignFollow.frames.some(frame => frame.type === 'error') && !JSON.stringify(foreignFollow.frames).includes(v1Body),
    'project follow leaked private state')
  const syncId = randomUUID()
  await ok('draftsSync', { artifactId: project.artifactId, body: 'new-follow-marker', expectedDraftRevision: currentDraft.revision, requestId: syncId })
  await until(() => ownFollow.frames.some(frame => frame.value?.requestId === syncId))
  check(!JSON.stringify(ownFollow.frames.filter(frame => frame.value?.type === 'committed')).includes('new-follow-marker'),
    'commit notification copied private text')
  foreignFollow.socket.terminate()
  await foreignFollow.closed
  const historicalExport = await download(aCookie, { artifactId: project.artifactId, target: 'version', versionId: v1.versionId })
  check(historicalExport.status === 200 && await historicalExport.text() === v1Body,
    'historical version export changed after draft edits')
  let internalDenied = false
  try { ctx.educationController.projectsList({ limit: 1 }) } catch (error) { internalDenied = error?.code === 'education/UNAUTHENTICATED' }
  check(internalDenied, 'direct Controller call used an ambient operator')
  process.stdout.write('EDUCATION_CONTROLLER_PROBE {"transactions":true,"idempotency":true,"versions":true,"export":true,"follow":true,"privacy":true}\n')
  return { projectFollowClosed: ownFollow.closed }
}
