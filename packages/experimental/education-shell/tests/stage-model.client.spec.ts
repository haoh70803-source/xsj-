/** Four-entry state races, original-request recovery and current permission checks without network/model work. */
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AnalyticsDataset,
  ContentAccount,
  ContentAccountId,
  KnowledgeItem,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { StageWorkspace } from '../src/client/stage-model.ts'
import { deferred, fixture, ok, projectId, source, artifactId } from './fixture.client.ts'
const owned: StageWorkspace[] = []
afterEach(() => {
  for (const model of owned.splice(0)) model.dispose()
  vi.unstubAllGlobals()
})
function setup() {
  const f = fixture(),
    useWritingSource = vi.fn(async () => {}),
    changed = vi.fn(),
    model = new StageWorkspace(f.transport, { useWritingSource, changed }, 100)
  model.setOwner('employee-a', projectId)
  owned.push(model)
  return { ...f, model, useWritingSource, changed }
}
const { body: _body, authorized: _authorized, ...metadata } = source
const item: KnowledgeItem = { ...metadata, kind: 'text', canUseForAi: true }
function account(id = 'account-one'): ContentAccount {
  return {
    id: brandString<ContentAccountId>(id),
    title: id,
    externalId: 'synthetic-external',
    platform: 'douyin',
    enabled: true,
    revision: 1,
    grantRevision: 1,
    permissions: { view: true, sync: true, manage: false, export: true, use_for_ai: true },
  }
}
function dataset(saved = account(), sourceLabel = 'redfox'): AnalyticsDataset {
  return {
    account: saved,
    source: sourceLabel,
    sources: [sourceLabel],
    overview: null,
    analysis: {
      items: [],
      images: [],
      undated: [],
      unknownPublicationCount: 0,
      medianLikes: null,
      validSampleCount: 0,
      baselineCount: 0,
      aboveMedian: [],
      window: null,
      recentCount: 5,
    },
    coverage: 'unknown',
    truncated: false,
  }
}
it('discards delayed private search results on employee changes', async () => {
  const { model, remote } = setup(),
    delayed = deferred<Awaited<ReturnType<typeof remote.knowledgeSearch>>>()
  remote.knowledgeSearch.mockReturnValueOnce(delayed.promise)
  const reading = model.search({ query: '', kind: 'all', limit: 20 })
  model.setOwner('employee-b', null)
  delayed.resolve(ok({ items: [item], nextCursor: null }))
  await reading
  expect(model.getSnapshot()).toMatchObject({
    knowledge: [],
    selectedSource: null,
    research: null,
    projectId: null,
    loading: false,
  })
})
it('keeps the latest query when earlier reads return out of order', async () => {
  const { model, remote } = setup(),
    delayed = deferred<Awaited<ReturnType<typeof remote.knowledgeSearch>>>()
  remote.knowledgeSearch
    .mockReturnValueOnce(delayed.promise)
    .mockResolvedValueOnce(ok({ items: [{ ...item, title: 'new-result' }], nextCursor: null }))
  const old = model.search({ query: 'old', kind: 'all', limit: 20 })
  await model.search({ query: 'new', kind: 'text', limit: 20 })
  delayed.resolve(ok({ items: [item], nextCursor: 'obsolete' }))
  await old
  expect(model.getSnapshot().knowledge[0]?.title).toBe('new-result')
  expect(model.getSnapshot().cursor).toBeNull()
})
it('retains the exact original source request after transport uncertainty and retries only explicitly', async () => {
  const { model, remote } = setup()
  remote.researchImportSource.mockRejectedValueOnce(new Error('synthetic transport interruption'))
  await model.importSource({
    format: 'text',
    title: 'original input',
    content: 'authorized text',
    sourceUrl: '',
    edit: false,
  })
  expect(model.getSnapshot().uncertain).toBe(true)
  const original = remote.researchImportSource.mock.calls[0]![0]
  await model.resolve()
  expect(remote.researchImportSource).toHaveBeenCalledTimes(1)
  await model.resolve(true)
  expect(remote.researchImportSource.mock.calls[1]![0]).toEqual(original)
  expect(model.getSnapshot()).toMatchObject({ uncertain: false, selectedSource: source })
})
it('treats known business refusal as a refusal and never turns it into a successful import', async () => {
  const { model, remote, changed } = setup()
  remote.researchImportSource.mockResolvedValueOnce({
    ok: false,
    error: new RemoteError('education/INPUT_INVALID', 'synthetic refused input', {}),
  })
  await model.importSource({ format: 'text', title: 'invalid', content: '', sourceUrl: '', edit: false })
  expect(model.getSnapshot()).toMatchObject({
    uncertain: false,
    selectedSource: null,
    problem: 'education/INPUT_INVALID',
    notice: null,
  })
  expect(changed).not.toHaveBeenCalled()
  await model.resolve(true)
  expect(remote.researchImportSource).toHaveBeenCalledTimes(1)
})
it('rechecks a selected source on transfer, and navigating never starts a model or supplier request', async () => {
  const { model, remote, useWritingSource } = setup()
  await model.navigate('knowledge')
  await model.selectSource(source.versionId)
  await model.useSource(source.versionId)
  expect(remote.knowledgeReadSourceVersion).toHaveBeenCalledTimes(2)
  expect(useWritingSource).toHaveBeenCalledWith(source)
  expect(remote.researchStart).not.toHaveBeenCalled()
  expect(remote.creationStart).not.toHaveBeenCalled()
  expect(remote.analyticsSyncRequest).not.toHaveBeenCalled()
})
it('refreshes source authorization even when an empty research draft has no source basis yet', async () => {
  const { model, remote } = setup()
  await model.selectSource(source.versionId)
  await model.navigate('research')
  remote.knowledgeReadSourceVersion.mockResolvedValueOnce({
    ok: false,
    error: new RemoteError('education/RESOURCE_UNAVAILABLE', 'synthetic revoked source', {}),
  })
  await model.refresh()
  expect(model.getSnapshot()).toMatchObject({
    selectedSource: null,
    research: null,
    reportPreview: null,
    problem: 'education/RESOURCE_UNAVAILABLE',
  })
})
it('discards delayed saved datasets after switching accounts', async () => {
  const { model, remote } = setup(),
    a = account(),
    b = account('account-two')
  remote.analyticsAccountsList.mockResolvedValue(ok([a, b]))
  await model.accounts()
  const delayed = deferred<Awaited<ReturnType<typeof remote.analyticsQuery>>>()
  remote.analyticsQuery.mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(ok(dataset(b)))
  const old = model.selectAccount(a.id)
  await model.selectAccount(b.id)
  delayed.resolve(ok(dataset(a)))
  await old
  expect(model.getSnapshot().accountId).toBe(b.id)
  expect(model.getSnapshot().dataset?.account.id).toBe(b.id)
})
it('removes cached account bodies when current access is withdrawn and performs no paid refresh', async () => {
  const { model, remote } = setup(),
    a = account()
  remote.analyticsAccountsList.mockResolvedValue(ok([a]))
  remote.analyticsQuery.mockResolvedValue(ok(dataset(a)))
  await model.accounts()
  await model.selectAccount(a.id)
  remote.analyticsAccountsList.mockResolvedValueOnce(ok([]))
  await model.accounts()
  expect(model.getSnapshot()).toMatchObject({
    accounts: [],
    accountId: null,
    dataset: null,
    preview: null,
    grants: [],
    runs: [],
  })
  expect(remote.analyticsSyncRequest).not.toHaveBeenCalled()
  expect(remote.researchStart).not.toHaveBeenCalled()
})
it('only displays export success after a fresh server authorization and actual clipboard completion', async () => {
  const { model, transport, remote } = setup()
  await model.navigate('research')
  remote.researchOpen.mockResolvedValue(
    ok({
      projectId,
      primaryArtifactId: artifactId,
      artifact: {
        id: artifactId,
        projectId,
        kind: 'text-analysis',
        latestVersionId: null,
        createdAt: source.createdAt,
        updatedAt: source.createdAt,
      },
      draft: { artifactId, revision: 1, bodyHash: 'synthetic', body: 'synthetic', updatedAt: source.createdAt },
      latestVersion: null,
      document: null,
    }),
  )
  await model.openResearch(false)
  const writeText = vi.fn(async () => {
    throw new Error('synthetic clipboard denial')
  })
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  transport.download.mockResolvedValueOnce(Object.assign(new Blob(), { text: async () => 'synthetic allowed export' }))
  await model.exportResearch(true)
  expect(transport.download).toHaveBeenCalledTimes(1)
  expect(writeText).toHaveBeenCalledWith('synthetic allowed export')
  expect(model.getSnapshot().notice).not.toBe('copied')
  transport.download.mockRejectedValueOnce(
    new RemoteError('education/RESOURCE_UNAVAILABLE', 'synthetic revoked export', {}),
  )
  await model.exportResearch(true)
  expect(writeText).toHaveBeenCalledTimes(1)
})
