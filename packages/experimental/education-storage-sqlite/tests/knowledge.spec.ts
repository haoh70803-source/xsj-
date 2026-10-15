/** Real SQL filtering; revoked text is excluded before keyword matching and cursor generation. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { stageFixture } from './stage-fixture.ts'
import { newId } from '../src/codec.ts'
import type { ActorContext } from '@deepseek-ai/dsh-experimental-education-platform/types'

let f: Awaited<ReturnType<typeof stageFixture>>
beforeEach(async () => {
  f = await stageFixture()
})
afterEach(() => {
  f?.close()
})
const save = (actor: ActorContext, body: string, title = '合成资料') =>
  f.repository.creation.saveSource(actor, { title, body, sourceUrl: '', expectedRevision: 0, requestId: newId() })

it('filters owner and authorization in SQL before matching private bodies', () => {
  const own = save(f.a, 'A_PRIVATE_MARKER'),
    foreign = save(f.b, 'B_PRIVATE_MARKER')
  expect(
    f.repository.knowledge.search(f.a, { query: 'PRIVATE', kind: 'all', limit: 10 }).items.map(row => row.id),
  ).toEqual([own.id])
  expect(f.repository.knowledge.search(f.a, { query: 'B_PRIVATE', kind: 'all', limit: 10 }).items).toEqual([])
  expect(() => f.repository.knowledge.readSourceVersion(f.a, foreign.versionId)).toThrow('unavailable')
  f.repository.creation.authorizeSource(f.a, {
    sourceId: own.id,
    authorized: false,
    expectedAuthorizationRevision: 1,
    requestId: newId(),
  })
  expect(f.repository.knowledge.search(f.a, { query: 'A_PRIVATE', kind: 'all', limit: 1 })).toEqual({
    items: [],
    nextCursor: null,
  })
  expect(() => f.repository.knowledge.readSourceVersion(f.a, own.versionId)).toThrow('unavailable')
})

it('treats SQL wildcard characters literally and keeps selected historical revision metadata accurate', () => {
  const original = save(f.a, '原文50%_\\不可替换')
  save(f.a, '另一份50abcd资料')
  expect(
    f.repository.knowledge.search(f.a, { query: '%_\\', kind: 'text', limit: 10 }).items.map(row => row.id),
  ).toEqual([original.id])
  const next = f.repository.creation.saveSource(f.a, {
    sourceId: original.id,
    title: '资料新版',
    body: '更新后的正文',
    sourceUrl: '',
    expectedRevision: 1,
    requestId: newId(),
  })
  expect(f.repository.knowledge.readSourceVersion(f.a, original.versionId)).toMatchObject({
    body: original.body,
    revision: 1,
    versionId: original.versionId,
  })
  expect(f.repository.knowledge.readSourceVersion(f.a, next.versionId)).toMatchObject({
    revision: 2,
    body: '更新后的正文',
  })
})

it('binds pagination to the user and exact literal query without returning bodies', () => {
  for (let i = 0; i < 3; i++) save(f.a, '有共同关键词', `资料${i}`)
  const first = f.repository.knowledge.search(f.a, { query: '共同', kind: 'all', limit: 1 })
  expect(first.items).toHaveLength(1)
  expect(first.items[0]).not.toHaveProperty('body')
  if (first.nextCursor === null) throw new Error('expected another authorized page')
  const second = f.repository.knowledge.search(f.a, { query: '共同', kind: 'all', limit: 1, cursor: first.nextCursor })
  expect(second.items[0]?.id).not.toBe(first.items[0]?.id)
  expect(() =>
    f.repository.knowledge.search(f.b, { query: '共同', kind: 'all', limit: 1, cursor: first.nextCursor ?? '' }),
  ).toThrow('cursor')
  expect(() =>
    f.repository.knowledge.search(f.a, { query: '不同', kind: 'all', limit: 1, cursor: first.nextCursor ?? '' }),
  ).toThrow('cursor')
})

it('propagates a revoked account grant through copied source versions and cannot revive old grants', () => {
  const account = newId(),
    at = new Date().toISOString()
  f.inspect
    .prepare('INSERT INTO content_accounts VALUES(?,?,?,?,?,?,1,1,?)')
    .run(account, f.organizationId, f.a.userId, 'douyin', 'synthetic-account', '合成账号', at)
  f.inspect
    .prepare('INSERT INTO account_grants VALUES(?,?,?,?,?,?,?,?,1)')
    .run(account, f.organizationId, f.a.userId, 1, 1, 1, 1, 1)
  const original = save(f.a, 'ACCOUNT_PRIVATE'),
    copied = save(f.a, 'ACCOUNT_PRIVATE copied')
  f.inspect.prepare('INSERT INTO source_dependencies VALUES(?,?,?,?)').run(original.versionId, 'account', account, 1)
  f.inspect
    .prepare('INSERT INTO source_dependencies VALUES(?,?,?,?)')
    .run(copied.versionId, 'source', original.versionId, 1)
  expect(f.repository.knowledge.search(f.a, { query: 'ACCOUNT_PRIVATE', kind: 'all', limit: 10 }).items).toHaveLength(2)
  f.inspect.prepare('UPDATE account_grants SET can_use_for_ai=0,revision=2 WHERE account_id=?').run(account)
  expect(f.repository.knowledge.search(f.a, { query: 'ACCOUNT_PRIVATE', kind: 'all', limit: 1 })).toEqual({
    items: [],
    nextCursor: null,
  })
  expect(f.repository.creation.listSources(f.a).every(row => !row.authorized && row.body === '')).toBe(true)
  f.inspect.prepare('UPDATE account_grants SET can_use_for_ai=1,revision=3 WHERE account_id=?').run(account)
  expect(() => f.repository.knowledge.readSourceVersion(f.a, copied.versionId)).toThrow('unavailable')
  const edited = f.repository.creation.saveSource(f.a, {
    sourceId: copied.id,
    title: '直接编辑后的版本',
    body: '不能通过新版本洗掉原账号授权',
    sourceUrl: '',
    expectedRevision: 1,
    requestId: newId(),
  })
  expect(edited).toMatchObject({ authorized: false, body: '' })
  expect(() => f.repository.knowledge.readSourceVersion(f.a, edited.versionId)).toThrow('unavailable')
})
