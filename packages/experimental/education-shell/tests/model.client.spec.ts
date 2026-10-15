import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { DraftCommitted, ProjectState, UserDTO } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { EducationWorkspace } from '../src/client/model.ts'
import { artifactId, deferred, fixture, ok, other, projectId, state, user, version, versionId } from './fixture.client.ts'

const models: EducationWorkspace[] = []
async function opened() {
  const f = fixture(); models.push(f.model)
  await f.model.authenticate(); await f.model.open(projectId)
  return f
}
afterEach(() => { models.splice(0).forEach((model) => { model.dispose() }) })
describe('employee workspace state and transaction baselines', () => {
  it('loads only catalog metadata and opens confirmed server text', async () => {
    const { model, remote } = await opened()
    expect(remote.projectsList).toHaveBeenCalledWith({ limit: 30 })
    expect(model.getSnapshot()).toMatchObject({ user, project: state, text: state.draft.body, dirty: false, versions: [version] })
  })
  it('syncs normalized current editor before saving both returned revision and original formal pointer', async () => {
    const { model, remote } = await opened()
    model.edit(' edited\r\ntext ')
    await model.save()
    expect(remote.draftsSync).toHaveBeenCalledWith({ artifactId, body: ' edited\ntext ', expectedDraftRevision: 4, requestId: 'request-1' })
    expect(remote.artifactsSaveVersion).toHaveBeenCalledWith({ artifactId, expectedDraftRevision: 5, expectedLatestVersionId: versionId, requestId: 'request-2' })
    expect(remote.draftsSync.mock.invocationCallOrder[0]).toBeLessThan(remote.artifactsSaveVersion.mock.invocationCallOrder[0]!)
    expect(model.getSnapshot()).toMatchObject({ dirty: false, text: ' edited\ntext ', notice: 'saved' })
  })
  it('sync alone never creates a version; clean save uses current revision', async () => {
    const { model, remote } = await opened()
    await model.save()
    expect(remote.draftsSync).not.toHaveBeenCalled()
    expect(remote.artifactsSaveVersion.mock.calls[0]?.[0].expectedDraftRevision).toBe(4)
    remote.artifactsSaveVersion.mockClear()
    model.edit('new'); await model.sync()
    expect(remote.artifactsSaveVersion).not.toHaveBeenCalled()
  })
  it('never saves a version if draft synchronization conflicts', async () => {
    const { model, remote } = await opened()
    remote.draftsSync.mockResolvedValue({ ok: false, error: new RemoteError('education/DRAFT_CONFLICT', 'safe', {}) })
    model.edit('keep this'); await model.save()
    expect(remote.artifactsSaveVersion).not.toHaveBeenCalled()
    expect(model.getSnapshot()).toMatchObject({ dirty: true, text: 'keep this', problem: 'conflict' })
  })
  it('keeps synchronized text when the formal pointer conflicts', async () => {
    const { model, remote } = await opened()
    remote.artifactsSaveVersion.mockResolvedValue({ ok: false, error: new RemoteError('education/VERSION_CONFLICT', 'safe', {}) })
    model.edit('keep synced'); await model.save()
    expect(model.getSnapshot()).toMatchObject({ text: 'keep synced', dirty: false, problem: 'conflict' })
  })
  it('reads history without touching draft; explicit restore changes draft and preserves latest pointer', async () => {
    const { model, remote } = await opened()
    await model.preview(version)
    expect(model.getSnapshot()).toMatchObject({ text: state.draft.body, project: state, preview: version })
    model.edit('unsynced'); await model.restore()
    expect(remote.draftsRestoreVersion).not.toHaveBeenCalled()
    await model.restore(true)
    expect(remote.draftsRestoreVersion).toHaveBeenCalledWith({ artifactId, versionId, expectedDraftRevision: 4, requestId: 'request-1' })
    expect(model.getSnapshot()).toMatchObject({
      text: version.body, dirty: false,
      project: { artifact: { latestVersionId: versionId }, draft: { revision: 5 } },
    })
  })
  it('requires explicit discard to open/create over dirty editor', async () => {
    const { model, remote } = await opened(); model.edit('unsynced')
    remote.projectsOpen.mockClear()
    await model.open(projectId); await model.create('new')
    expect(remote.projectsOpen).not.toHaveBeenCalled(); expect(remote.projectsCreate).not.toHaveBeenCalled()
    await model.open(projectId, true)
    expect(model.getSnapshot().text).toBe(state.draft.body)
  })
  it('retains the editor after read and storage errors', async () => {
    const { model, remote } = await opened(); model.edit('keep')
    remote.projectsOpen.mockRejectedValue(new Error('transport'))
    await model.open(projectId, true)
    expect(model.getSnapshot()).toMatchObject({ text: 'keep', dirty: true, problem: 'failed', busy: false })
  })
  it('checks unknown receipt then retries exactly the same immutable request', async () => {
    const { model, remote } = await opened(); model.edit('uncertain')
    remote.draftsSync.mockRejectedValueOnce(new Error('lost response'))
    await model.sync()
    expect(model.getSnapshot()).toMatchObject({ text: 'uncertain', dirty: true, uncertain: true, problem: 'unknown' })
    await model.save(); expect(remote.artifactsSaveVersion).not.toHaveBeenCalled()
    model.edit('cannot change pending args'); expect(model.getSnapshot().text).toBe('uncertain')
    await model.resolve()
    expect(model.getSnapshot().uncertain).toBe(true)
    await model.resolve(true)
    expect(remote.draftsSync.mock.calls[1]?.[0]).toEqual(remote.draftsSync.mock.calls[0]?.[0])
    expect(remote.requestsGetResult).toHaveBeenCalledWith({ operation: 'drafts.sync', requestId: 'request-1' })
    expect(model.getSnapshot()).toMatchObject({ uncertain: false, text: 'uncertain', dirty: false })
  })
  it('accepts committed receipt without resending, and does not invent a failed outcome for null', async () => {
    const { model, remote } = await opened(); model.edit('committed')
    remote.draftsSync.mockRejectedValue(new Error('lost'))
    await model.sync(); await model.resolve()
    expect(model.getSnapshot().uncertain).toBe(true)
    remote.requestsGetResult.mockResolvedValue(ok({ operation: 'drafts.sync', artifactId, revision: 5, bodyHash: 'h', updatedAt: version.savedAt }))
    await model.resolve(true)
    expect(remote.draftsSync).toHaveBeenCalledTimes(1)
    expect(model.getSnapshot()).toMatchObject({ text: 'committed', dirty: false, uncertain: false })
  })
  it('treats explicit operation interruption as uncertain', async () => {
    const { model, remote } = await opened()
    remote.artifactsSaveVersion.mockResolvedValue({ ok: false, error: new RemoteError('education/OPERATION_INTERRUPTED', 'interrupted', {}) })
    await model.save(); expect(model.getSnapshot().uncertain).toBe(true)
  })
  it('blocks duplicate clicks during an outstanding transaction', async () => {
    const { model, remote } = await opened(), gate = deferred<RemoteResult<DraftCommitted>>()
    model.edit('one write'); remote.draftsSync.mockReturnValue(gate.promise)
    const first = model.sync(); await model.sync(); await model.save()
    expect(remote.draftsSync).toHaveBeenCalledTimes(1)
    gate.resolve(ok({ operation: 'drafts.sync', artifactId, revision: 5, bodyHash: 'h', updatedAt: version.savedAt })); await first
  })
  it('exports exact source, refuses dirty draft, and never exports a stale-account blob', async () => {
    const { model, transport } = await opened(), deliver = vi.fn()
    model.edit('local'); await model.export('draft', deliver)
    expect(transport.download).not.toHaveBeenCalled()
    await model.preview(version); await model.export('version', deliver)
    expect(transport.download).toHaveBeenCalledWith({ artifactId, target: 'version', versionId }, expect.any(AbortSignal))
    const gate = deferred<Blob>(); transport.download.mockReturnValue(gate.promise)
    const exporting = model.export('version', deliver)
    transport.identity.mockResolvedValue(null); await model.signOut(); gate.resolve(new Blob(['old private text'])); await exporting
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('paginates independently without losing selected text', async () => {
    const { model, remote } = await opened(); model.edit('kept')
    remote.projectsList.mockResolvedValueOnce(ok({ items: [], nextCursor: 'catalog-cursor' }))
    await model.list(); await model.list(true)
    expect(remote.projectsList.mock.lastCall?.[0]).toEqual({ limit: 30, cursor: 'catalog-cursor' })
    remote.artifactsListVersions.mockResolvedValueOnce(ok({ items: [], nextCursor: 'version-cursor' }))
    await model.versions(); await model.versions(true)
    expect(remote.artifactsListVersions.mock.lastCall?.[0]).toEqual({ artifactId, limit: 30, cursor: 'version-cursor' })
    expect(model.getSnapshot().text).toBe('kept')
  })
})
describe('identity generation and cleanup', () => {
  it('clears all private state immediately and cancels old follow before sign-out resolves', async () => {
    const { model, transport, stream, remote } = await opened()
    model.edit('private unsynced'); await model.preview(version)
    const gate = deferred<UserDTO | null>(); transport.identity.mockReturnValue(gate.promise)
    const signingOut = model.signOut()
    expect(model.getSnapshot()).toMatchObject({ user: null, text: '', project: null, projects: [], versions: [], preview: null })
    expect(stream.dispose).toHaveBeenCalled()
    expect(remote.projectsFollow.mock.calls[0]?.[1]?.aborted).toBe(true)
    gate.resolve(null); await signingOut
  })
  it('drops an old project response after switching to another account', async () => {
    const f = fixture(); models.push(f.model); await f.model.authenticate()
    const gate = deferred<RemoteResult<ProjectState>>(); f.remote.projectsOpen.mockReturnValue(gate.promise)
    const opening = f.model.open(projectId)
    f.transport.identity.mockResolvedValue(other); f.remote.projectsList.mockResolvedValue(ok({ items: [], nextCursor: null }))
    await f.model.authenticate({ username: other.username, password: 'synthetic' })
    gate.resolve(ok(state)); await opening
    expect(f.model.getSnapshot()).toMatchObject({ user: other, project: null, text: '', projects: [], busy: false })
    expect(f.remote.projectsFollow).not.toHaveBeenCalled()
  })
  it('drops late transaction receipt and leaves a new identity untouched', async () => {
    const { model, remote, transport } = await opened(), gate = deferred<RemoteResult<DraftCommitted>>()
    model.edit('old'); remote.draftsSync.mockReturnValue(gate.promise)
    const writing = model.sync()
    transport.identity.mockResolvedValue(other); remote.projectsList.mockResolvedValue(ok({ items: [], nextCursor: null }))
    await model.authenticate({ username: other.username, password: 'synthetic' })
    gate.resolve(ok({ operation: 'drafts.sync', artifactId, revision: 5, bodyHash: 'h', updatedAt: version.savedAt })); await writing
    expect(model.getSnapshot()).toMatchObject({ user: other, text: '', project: null, notice: null })
  })
  it('clears on expiry or changed cookie but retains edits during mere network failure', async () => {
    const { model, transport } = await opened(); model.edit('retained')
    transport.identity.mockRejectedValueOnce(new Error('offline')); await model.checkIdentity()
    expect(model.getSnapshot().text).toBe('retained')
    transport.identity.mockResolvedValue(null); await model.checkIdentity()
    expect(model.getSnapshot()).toMatchObject({ user: null, text: '', project: null, problem: 'signedOut' })
  })
  it('cleans state when an authoritative business response rejects the login', async () => {
    const { model, remote } = await opened(); model.edit('private')
    remote.draftsSync.mockResolvedValue({ ok: false, error: new RemoteError('education/UNAUTHENTICATED', 'safe', {}) })
    await model.sync(); expect(model.getSnapshot()).toMatchObject({ user: null, text: '', project: null })
  })
  it('disposes subscriptions and prevents callbacks or pending results from repopulating data', async () => {
    const { model, stream } = await opened(), listener = vi.fn(), off = model.subscribe(listener)
    model.edit('secret'); expect(listener).toHaveBeenCalledTimes(1)
    off(); model.dispose(); model.dispose(); model.edit('late')
    expect(model.getSnapshot().text).toBe(''); expect(stream.dispose).toHaveBeenCalled()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
