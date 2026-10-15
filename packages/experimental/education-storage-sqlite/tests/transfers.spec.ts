/** Reference transfers retain immutable observations and independent current view/AI/export grants. */
import type { RequestId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { stageFixture } from './stage-fixture.ts'
import { newId } from '../src/codec.ts'
let f: Awaited<ReturnType<typeof stageFixture>>
beforeEach(async () => {
  f = await stageFixture()
})
afterEach(() => {
  f?.close()
})
function prepare() {
  const accountId = f.repository.analytics.createAccount(f.a, {
    platform: 'xiaohongshu',
    externalId: 'synthetic',
    title: '其他作者',
    requestId: newId<RequestId>(),
  }).accountId
  const permissions = { view: true, sync: false, manage: false, export: false, use_for_ai: true }
  f.repository.analytics.setGrant(f.a, {
    accountId,
    username: 'stage-other',
    permissions,
    expectedRevision: 0,
    requestId: newId<RequestId>(),
  })
  const preview = f.repository.analytics.previewImport(f.a, {
    accountId,
    sourceLabel: '合成来源',
    observedAt: new Date(Date.now() - 1000).toISOString(),
    requestId: newId<RequestId>(),
    content: JSON.stringify({
      kind: 'education-metrics',
      version: 1,
      contents: [
        {
          externalId: 'video',
          kind: 'video',
          title: '其他作者的标题',
          url: 'https://example.com/original',
          publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
          likes: 0,
          comments: null,
        },
      ],
    }),
  })
  f.repository.analytics.commitImport(f.a, {
    importId: preview.id,
    expectedFileHash: preview.fileHash,
    allowPartial: false,
    requestId: newId<RequestId>(),
  })
  const item = f.repository.analytics.query(
    f.b,
    { accountId, source: preview.source, mode: 'latest', keyword: '' },
    5,
    'Asia/Shanghai',
  ).analysis.items[0]!
  const project = f.repository.createProject(f.b, {
    title: '自己的创作项目',
    scenario: 'spoken-script',
    requestId: newId<RequestId>(),
  })
  return { accountId, item, project, permissions }
}
it('requires an actual original for research and never interprets titles or metrics as full text', () => {
  const { item, project } = prepare()
  const input = {
    projectId: project.projectId,
    snapshotId: item.snapshotId,
    target: 'research' as const,
    originalText: '',
    requestId: newId<RequestId>(),
  }
  expect(() => f.repository.transfers.fromAnalytics(f.b, input)).toThrow('not original text')
  const originalText = '这是用户明确提供并获准使用的原始全文。'
  const source = f.repository.transfers.fromAnalytics(f.b, { ...input, originalText, requestId: newId<RequestId>() })
  expect(source).toMatchObject({ body: originalText, purpose: 'reference-method' })
  const read = f.repository.research.readSource(f.b, source.versionId)
  expect(read.origin.videoInfo).toMatchObject({
    snapshotId: item.snapshotId,
    metrics: { likes: { value: 0, state: 'known' }, comments: { value: null, state: 'missing' } },
  })
  expect(f.repository.creation.readProfile(f.b)).toBeNull()
  expect(f.repository.openProject(f.b, project.projectId).draft.body).toBe('')
})
it('preserves the original transfer receipt, keeps export independent and hides every derived version after revocation', () => {
  const { accountId, item, project, permissions } = prepare(),
    request = {
      projectId: project.projectId,
      snapshotId: item.snapshotId,
      target: 'writing' as const,
      originalText: '',
      requestId: newId<RequestId>(),
    }
  const source = f.repository.transfers.fromAnalytics(f.b, request)
  expect(f.repository.transfers.fromAnalytics(f.b, request).versionId).toBe(source.versionId)
  const profile = f.repository.creation.saveProfile(f.b, {
    facts: '这是本人明确确认的合成事实。',
    preferences: '',
    prohibitedPromises: '',
    expectedRevision: 0,
    requestId: newId<RequestId>(),
  })
  const run = f.repository.creation.start(
    f.b,
    {
      artifactId: project.artifactId,
      expectedDraftRevision: 0,
      requestId: newId<RequestId>(),
      profileVersionId: profile.id,
      sourceVersionIds: [source.versionId],
      instruction: '只借鉴选题方法，不使用其他作者经历',
      mode: 'generate',
    },
    'synthetic',
    120_000,
  )
  expect(f.repository.creation.input(f.b, run.id).sources[0]?.purpose).toBe('reference-method')
  f.repository.creation.complete(f.b, run.id, '合成创作正文', '借鉴方法')
  const version = f.repository.saveVersion(f.b, {
    artifactId: project.artifactId,
    expectedDraftRevision: 1,
    expectedLatestVersionId: null,
    requestId: newId<RequestId>(),
  })
  expect(() =>{  f.repository.requireArtifactExport(f.b, project.artifactId, version.versionId) }).toThrow(
    expect.objectContaining({ code: 'forbidden' }),
  )
  expect(() =>{  f.repository.analytics.requireExport(f.b, accountId) }).toThrow('unavailable')
  f.repository.analytics.setGrant(f.a, {
    accountId,
    username: 'stage-other',
    permissions: { ...permissions, use_for_ai: false, view: false },
    expectedRevision: 1,
    requestId: newId<RequestId>(),
  })
  expect(f.repository.readDraft(f.b, project.artifactId)).toMatchObject({ restricted: true, body: '' })
  expect(f.repository.readVersion(f.b, project.artifactId, version.versionId)).toMatchObject({
    restricted: true,
    body: '',
  })
  expect(f.repository.creation.getRun(f.b, run.id)).toMatchObject({ restricted: true, candidate: null })
  expect(() =>
    f.repository.restoreVersion(f.b, {
      artifactId: project.artifactId,
      versionId: version.versionId,
      expectedDraftRevision: 1,
      requestId: newId<RequestId>(),
    }),
  ).toThrow('unavailable')
  f.repository.analytics.setGrant(f.a, {
    accountId,
    username: 'stage-other',
    permissions: { ...permissions, export: true },
    expectedRevision: 2,
    requestId: newId<RequestId>(),
  })
  expect(f.repository.readVersion(f.b, project.artifactId, version.versionId).restricted).toBe(true)
  expect(f.repository.creation.readProfile(f.b)).toEqual(profile)
})
it('rolls back a transferred source and all dependencies if its original receipt cannot commit', () => {
  const { item, project } = prepare()
  f.inspect.exec(
    "CREATE TRIGGER synthetic_transfer_failure BEFORE INSERT ON creation_receipts WHEN NEW.operation='sources.save' BEGIN SELECT RAISE(ABORT,'synthetic transfer failure'); END",
  )
  expect(() =>
    f.repository.transfers.fromAnalytics(f.b, {
      projectId: project.projectId,
      snapshotId: item.snapshotId,
      target: 'writing',
      originalText: '',
      requestId: newId<RequestId>(),
    }),
  ).toThrow('storage')
  expect(f.inspect.prepare('SELECT COUNT(*) AS n FROM sources').get()?.n).toBe(0)
  expect(f.inspect.prepare('SELECT COUNT(*) AS n FROM source_dependencies').get()?.n).toBe(0)
})
