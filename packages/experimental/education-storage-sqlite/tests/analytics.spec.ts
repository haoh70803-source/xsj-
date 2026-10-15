/** Account grants and import transactions use actual SQLite; datasets are explicitly synthetic fixtures. */
import type { RequestId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stageFixture } from './stage-fixture.ts'
import { newId } from '../src/codec.ts'

let f: Awaited<ReturnType<typeof stageFixture>>
beforeEach(async () => {
  f = await stageFixture()
})
afterEach(() => {
  f?.close()
})
const full = { view: true, sync: true, manage: true, export: true, use_for_ai: true }
const viewOnly = { view: true, sync: false, manage: false, export: false, use_for_ai: false }
const time = () => new Date(Date.now() - 3_600_000).toISOString()
const published = (days = 2) => new Date(Date.now() - days * 86_400_000).toISOString()
function account() {
  return f.repository.analytics.createAccount(f.a, {
    platform: 'douyin',
    externalId: 'synthetic-public-id',
    title: '合成试验账号',
    requestId: newId<RequestId>(),
  }).accountId
}
function file(title = '合成作品', likes: number | null = 0) {
  return JSON.stringify({
    kind: 'education-metrics',
    version: 1,
    overview: { followers: 0, totalLikes: 500 },
    contents: [{ externalId: 'synthetic-video-one', kind: 'video', title, publishedAt: published(), likes }],
  })
}

it('defaults accounts to private and keeps view, sync, manage, export and AI privileges independent', () => {
  const id = account()
  expect(f.repository.analytics.listAccounts(f.b)).toEqual([])
  expect(() =>
    f.repository.analytics.query(
      f.b,
      { accountId: id, mode: 'latest', source: 'redfox', keyword: '' },
      5,
      'Asia/Shanghai',
    ),
  ).toThrow('unavailable')
  f.repository.analytics.setGrant(f.a, {
    accountId: id,
    username: 'stage-other',
    permissions: viewOnly,
    expectedRevision: 0,
    requestId: newId<RequestId>(),
  })
  expect(f.repository.analytics.listAccounts(f.b)[0]?.permissions).toEqual(viewOnly)
  expect(
    f.repository.analytics.query(
      f.b,
      { accountId: id, mode: 'latest', source: 'redfox', keyword: '' },
      5,
      'Asia/Shanghai',
    ).overview,
  ).toBeNull()
  expect(() =>
    f.repository.analytics.previewImport(f.b, {
      accountId: id,
      sourceLabel: '合成',
      observedAt: time(),
      content: file(),
      requestId: newId<RequestId>(),
    }),
  ).toThrow('unavailable')
  expect(() => f.repository.analytics.listGrants(f.b, id)).toThrow('unavailable')
  expect(() =>
    f.repository.analytics.setEnabled(f.b, { accountId: id, enabled: false, expectedRevision: 1, requestId: newId<RequestId>() }),
  ).toThrow('unavailable')
})

it('checks grant revisions, current employee status and original mutation parameters', () => {
  const id = account(),
    request = { accountId: id, username: 'stage-other', permissions: viewOnly, expectedRevision: 0, requestId: newId<RequestId>() }
  const ack = f.repository.analytics.setGrant(f.a, request)
  expect(f.repository.analytics.setGrant(f.a, request)).toEqual(ack)
  expect(() => f.repository.analytics.setGrant(f.a, { ...request, permissions: full })).toThrow('different parameters')
  expect(() => f.repository.analytics.setGrant(f.a, { ...request, requestId: newId<RequestId>() })).toThrow('baseline changed')
  f.repository.setUserStatus(f.organizationId, f.b.userId, 'disabled')
  expect(() => f.repository.analytics.listAccounts(f.b)).toThrow('login is expired')
})

it('previews without committing, preserves zero/null and rejects partial confirmation unless explicitly selected', () => {
  const id = account(),
    content = JSON.stringify({
      kind: 'education-metrics',
      version: 1,
      overview: { followers: 0, totalLikes: 500 },
      contents: [
        { externalId: 'video-zero', kind: 'video', title: '合成零值', publishedAt: published(), likes: 0 },
        { externalId: 'video-missing', kind: 'video', title: '合成缺失', publishedAt: published(3), likes: null },
        { externalId: 'image', kind: 'image', title: '图文单列', publishedAt: published(), likes: 100 },
        { externalId: 'invalid', kind: 'video', title: '非法字段', likes: 'not-a-number' },
      ],
    })
  const preview = f.repository.analytics.previewImport(f.a, {
    accountId: id,
    sourceLabel: '合成报表',
    observedAt: time(),
    content,
    requestId: newId<RequestId>(),
  })
  expect(preview).toMatchObject({ validRows: 4, rejectedRows: 1, status: 'preview' })
  expect(f.inspect.prepare('SELECT COUNT(*) AS n FROM content_snapshots').get()?.n).toBe(0)
  expect(() =>
    f.repository.analytics.commitImport(f.a, {
      importId: preview.id,
      expectedFileHash: preview.fileHash,
      allowPartial: false,
      requestId: newId<RequestId>(),
    }),
  ).toThrow('valid-only')
  const request = { importId: preview.id, expectedFileHash: preview.fileHash, allowPartial: true, requestId: newId<RequestId>() }
  expect(f.repository.analytics.commitImport(f.a, request)).toMatchObject({ accepted: 4, rejected: 1, skipped: 0 })
  expect(f.repository.analytics.commitImport(f.a, request)).toMatchObject({ accepted: 4, rejected: 1 })
  const data = f.repository.analytics.query(
    f.a,
    { accountId: id, source: preview.source, mode: 'latest', keyword: '' },
    5,
    'Asia/Shanghai',
  )
  expect(data.overview?.fields.followers).toMatchObject({ value: 0, state: 'known' })
  expect(data.analysis).toMatchObject({ medianLikes: 0, validSampleCount: 1, baselineCount: 2 })
  expect(data.analysis.images).toHaveLength(1)
})

it('records duplicate-file skips rather than adding identical observations twice', () => {
  const id = account(),
    content = file(),
    observedAt = time()
  const first = f.repository.analytics.previewImport(f.a, {
    accountId: id,
    sourceLabel: '合成报表',
    observedAt,
    content,
    requestId: newId<RequestId>(),
  })
  f.repository.analytics.commitImport(f.a, {
    importId: first.id,
    expectedFileHash: first.fileHash,
    allowPartial: false,
    requestId: newId<RequestId>(),
  })
  const second = f.repository.analytics.previewImport(f.a, {
    accountId: id,
    sourceLabel: '合成报表',
    observedAt,
    content,
    requestId: newId<RequestId>(),
  })
  expect(
    f.repository.analytics.commitImport(f.a, {
      importId: second.id,
      expectedFileHash: second.fileHash,
      allowPartial: false,
      requestId: newId<RequestId>(),
    }),
  ).toMatchObject({ accepted: 0, skipped: 2 })
  expect(f.inspect.prepare('SELECT COUNT(*) AS n FROM content_snapshots').get()?.n).toBe(1)
})

it('rejects stale previews and foreign confirmation without replacing saved data', () => {
  const id = account(),
    original = f.repository.analytics.previewImport(f.a, {
      accountId: id,
      sourceLabel: '合成报表',
      observedAt: time(),
      content: file('旧预览'),
      requestId: newId<RequestId>(),
    })
  const newer = f.repository.analytics.previewImport(f.a, {
    accountId: id,
    sourceLabel: '合成报表',
    observedAt: time(),
    content: file('新数据'),
    requestId: newId<RequestId>(),
  })
  f.repository.analytics.commitImport(f.a, {
    importId: newer.id,
    expectedFileHash: newer.fileHash,
    allowPartial: false,
    requestId: newId<RequestId>(),
  })
  expect(() =>
    f.repository.analytics.commitImport(f.a, {
      importId: original.id,
      expectedFileHash: original.fileHash,
      allowPartial: false,
      requestId: newId<RequestId>(),
    }),
  ).toThrow('baseline changed')
  expect(() =>
    f.repository.analytics.commitImport(f.b, {
      importId: original.id,
      expectedFileHash: original.fileHash,
      allowPartial: false,
      requestId: newId<RequestId>(),
    }),
  ).toThrow('unavailable')
  expect(
    f.repository.analytics.query(
      f.a,
      { accountId: id, source: newer.source, mode: 'latest', keyword: '' },
      5,
      'Asia/Shanghai',
    ).analysis.items[0]?.title,
  ).toBe('新数据')
})

it('keeps source-specific metadata and account totals separate from per-video values', () => {
  const id = account()
  for (const [sourceLabel, title, likes] of [
    ['甲来源', '甲标题', 1],
    ['乙来源', '乙标题', 999],
  ] as const) {
    const preview = f.repository.analytics.previewImport(f.a, {
      accountId: id,
      sourceLabel,
      observedAt: time(),
      content: file(title, likes),
      requestId: newId<RequestId>(),
    })
    f.repository.analytics.commitImport(f.a, {
      importId: preview.id,
      expectedFileHash: preview.fileHash,
      allowPartial: false,
      requestId: newId<RequestId>(),
    })
  }
  const a = f.repository.analytics.query(
    f.a,
    { accountId: id, source: 'import:甲来源', mode: 'latest', keyword: '' },
    5,
    'Asia/Shanghai',
  )
  const b = f.repository.analytics.query(
    f.a,
    { accountId: id, source: 'import:乙来源', mode: 'latest', keyword: '' },
    5,
    'Asia/Shanghai',
  )
  expect(a.analysis.items[0]?.title).toBe('甲标题')
  expect(b.analysis.items[0]?.title).toBe('乙标题')
  expect(a.overview?.fields.totalLikes.value).toBe(500)
  expect(b.overview?.fields.totalLikes.value).toBe(500)
})

it('rolls back snapshots and preview state if the original-request receipt cannot commit', () => {
  const id = account(),
    preview = f.repository.analytics.previewImport(f.a, {
      accountId: id,
      sourceLabel: '合成',
      observedAt: time(),
      content: file(),
      requestId: newId<RequestId>(),
    })
  f.inspect.exec(
    "CREATE TRIGGER fail_import_receipt BEFORE INSERT ON stage_receipts WHEN NEW.operation='imports.commit' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  )
  expect(() =>
    f.repository.analytics.commitImport(f.a, {
      importId: preview.id,
      expectedFileHash: preview.fileHash,
      allowPartial: false,
      requestId: newId<RequestId>(),
    }),
  ).toThrow()
  expect(f.inspect.prepare('SELECT COUNT(*) AS n FROM content_snapshots').get()?.n).toBe(0)
  expect(f.inspect.prepare('SELECT status FROM import_previews WHERE id=?').get(preview.id)?.status).toBe('preview')
})

it('uses explicit import-local identities and leaves unknown publication time out of recent ranking', () => {
  const id = account(),
    content = JSON.stringify({
      kind: 'education-metrics',
      version: 1,
      contents: [{ kind: 'video', title: '人工记录，没有平台ID或发布时间', likes: 0, sourceDataAt: null }],
    })
  const preview = f.repository.analytics.previewImport(f.a, {
    accountId: id,
    sourceLabel: '人工记录',
    observedAt: time(),
    content,
    requestId: newId<RequestId>(),
  })
  f.repository.analytics.commitImport(f.a, {
    importId: preview.id,
    expectedFileHash: preview.fileHash,
    allowPartial: false,
    requestId: newId<RequestId>(),
  })
  const result = f.repository.analytics.query(
    f.a,
    { accountId: id, source: preview.source, mode: 'latest', keyword: '' },
    5,
    'Asia/Shanghai',
  )
  expect(result.overview).toBeNull()
  expect(result.analysis).toMatchObject({ baselineCount: 0, unknownPublicationCount: 1 })
  expect(result.analysis.undated[0]?.externalId).toMatch(/^import:/)
  expect(result.analysis.undated[0]?.sourceDataAt).toBeNull()
})

it('contains observer failure after a successful account mutation', () => {
  const report = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const dispose = f.repository.analytics.onAccountCommit(() => {
    throw new Error('synthetic observer failure')
  })
  try {
    const id = account()
    expect(f.repository.analytics.listAccounts(f.a)[0]?.id).toBe(id)
    expect(report).toHaveBeenCalledOnce()
  } finally {
    dispose()
    report.mockRestore()
  }
})
