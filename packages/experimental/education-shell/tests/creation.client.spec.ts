/** Client races use a controlled carrier; authorization and model execution stay in Profile tests. */
import { afterEach, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { DraftCommitted, RunDTO } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { fixture, projectId, deferred, ok, run, state, profile, other } from './fixture.client.ts'
import type { EducationWorkspace } from '../src/client/model.ts'

const models: EducationWorkspace[] = []
afterEach(() => {
  models.splice(0).forEach((model) => {
    model.dispose()
  })
  vi.useRealTimers()
})
async function opened(options?: Parameters<typeof fixture>[0]) {
  const f = fixture(options)
  models.push(f.model)
  await f.model.authenticate()
  await f.model.open(projectId)
  await f.model.refreshContext()
  return f
}
it('serializes debounced edits and preserves text typed while the previous synchronization is awaiting confirmation', async () => {
  vi.useFakeTimers()
  const { model, remote } = await opened({ autoSyncDelayMs: 100 })
  const pending = deferred<RemoteResult<DraftCommitted>>()
  remote.draftsSync.mockReturnValueOnce(pending.promise)
  model.edit('first body')
  await vi.advanceTimersByTimeAsync(100)
  expect(remote.draftsSync).toHaveBeenCalledTimes(1)
  model.edit('newer body')
  pending.resolve(
    ok({
      operation: 'drafts.sync',
      artifactId: state.artifact.id,
      revision: 5,
      bodyHash: 'first',
      updatedAt: state.draft.updatedAt,
    }),
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(model.getSnapshot()).toMatchObject({
    text: 'newer body',
    dirty: true,
    project: { draft: { body: 'first body', revision: 5 } },
  })
  remote.draftsSync.mockResolvedValueOnce(
    ok({
      operation: 'drafts.sync',
      artifactId: state.artifact.id,
      revision: 6,
      bodyHash: 'newer',
      updatedAt: state.draft.updatedAt,
    }),
  )
  await vi.advanceTimersByTimeAsync(100)
  expect(remote.draftsSync.mock.calls[1]?.[0]).toMatchObject({ body: 'newer body', expectedDraftRevision: 5 })
  expect(model.getSnapshot()).toMatchObject({ text: 'newer body', dirty: false, project: { draft: { revision: 6 } } })
})
it('does not sync unfinished IME text or retry a failed background sync in a loop', async () => {
  vi.useFakeTimers()
  const { model, remote } = await opened({ autoSyncDelayMs: 100 })
  model.setComposing(true)
  model.edit('中文输入中')
  await vi.advanceTimersByTimeAsync(1000)
  expect(remote.draftsSync).not.toHaveBeenCalled()
  remote.draftsSync.mockRejectedValueOnce(new Error('lost transport'))
  model.setComposing(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(model.getSnapshot()).toMatchObject({ text: '中文输入中', dirty: true, uncertain: true })
  await vi.advanceTimersByTimeAsync(5000)
  expect(remote.draftsSync).toHaveBeenCalledTimes(1)
})
it('keeps the original generation key after an unknown transport result and queries before any retry', async () => {
  vi.useFakeTimers()
  const { model, remote } = await opened()
  remote.creationStart.mockRejectedValueOnce(new Error('response lost'))
  await model.generate('modify confirmed text', [], 'modify')
  const original = remote.creationStart.mock.calls[0]?.[0]
  expect(original?.profileVersionId).toBe(profile.id)
  expect(model.getSnapshot().uncertain).toBe(true)
  await model.resolve()
  expect(remote.creationStart).toHaveBeenCalledTimes(1)
  expect(remote.creationFindRun).toHaveBeenCalledWith({ requestId: original?.requestId })
  remote.creationFindRun.mockResolvedValueOnce(ok(run))
  await model.resolve(true)
  expect(remote.creationStart).toHaveBeenCalledTimes(1)
  expect(model.getSnapshot()).toMatchObject({ uncertain: false, run })
})
it('retains unknown gateway outcomes and resends exactly the original request only after explicit retry', async () => {
  vi.useFakeTimers()
  const { model, remote } = await opened()
  remote.creationStart.mockResolvedValueOnce({
    ok: false,
    error: new RemoteError('education/OPERATION_INTERRUPTED', 'synthetic interruption', {}),
  })
  await model.generate('original modification', [], 'modify')
  const original = remote.creationStart.mock.calls[0]?.[0]
  await model.resolve(true)
  expect(remote.creationStart.mock.calls[1]?.[0]).toEqual(original)
})
it('drops a late generation response after identity switching and retains no former private context', async () => {
  const { model, remote, transport } = await opened(),
    pending = deferred<RemoteResult<RunDTO>>()
  remote.creationStart.mockReturnValueOnce(pending.promise)
  const submitted = model.generate('private A request', [], 'modify')
  await vi.waitFor(() => {
    expect(remote.creationStart).toHaveBeenCalledTimes(1)
  })
  model.invalidate()
  transport.identity.mockResolvedValue(other)
  remote.projectsList.mockResolvedValue(ok({ items: [], nextCursor: null }))
  await model.authenticate()
  pending.resolve(ok(run))
  await submitted
  expect(model.getSnapshot()).toMatchObject({
    user: other,
    profile: null,
    sources: [],
    text: '',
    creation: null,
    run: null,
  })
})
it('blocks edits during generation and clears already displayed history when context is revoked', async () => {
  vi.useFakeTimers()
  const { model, remote } = await opened()
  await model.generate('request', [], 'modify')
  model.edit('cannot change an occupied draft')
  expect(model.getSnapshot().text).toBe(state.draft.body)
  remote.creationReadState.mockResolvedValueOnce(
    ok({
      run: { ...run, status: 'completed', restricted: true },
      dialogue: [],
      restricted: true,
      basis: { source: 'foundation-validation', profileVersionIds: [], materialVersionIds: [] },
    }),
  )
  await model.refreshCreation()
  expect(model.getSnapshot()).toMatchObject({ text: '', dirty: false, preview: null })
})
