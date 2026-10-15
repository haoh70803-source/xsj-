/** Explicit synthetic RedFox vectors; no API call is made. */
import { expect, it } from 'vitest'
import { analyticsTimestamp } from '@deepseek-ai/dsh-experimental-education-platform'
import { normalizeRedFox } from '../src/redfox-normalize.ts'
const works = { operation: 'works', platform: 'douyin', accountId: 'synthetic', offset: 0, sortType: 'test' } as const
it('preserves known zero, missing null, distinct metrics and unknown freshness', () => {
  const result = normalizeRedFox(
    works,
    {
      list: [
        {
          awemeId: 'one',
          awemeType: 0,
          create_time: 0,
          statistics: { digg_count: 0, comment_count: null, play_count: '1.2万' },
        },
      ],
      hasMore: false,
    },
    null,
    100,
  )
  expect(result).toMatchObject({
    kind: 'works',
    hasMore: false,
    nextOffset: null,
    items: [
      {
        kind: 'video',
        publishedAt: null,
        sourceDataAt: null,
        fields: {
          likes: { value: 0, state: 'known' },
          comments: { value: null, state: 'missing' },
          views: { value: null, state: 'missing' },
        },
      },
    ],
  })
})
it.each([
  {},
  { data: {} },
  { list: [null] },
  { list: [{ id: 'one' }, { id: 'one' }] },
  { list: [{ id: 'one', author: { uid: 'foreign' } }] },
])('rejects malformed lists and foreign author identities: %j', (data) => {
  expect(() => normalizeRedFox(works, data, null, 100)).toThrow('invalid-response')
})
it('keeps image/unknown types distinct and never fabricates URLs or cursors', () => {
  const result = normalizeRedFox(
    { ...works, platform: 'xiaohongshu' },
    { notes: [{ noteId: 'image', type: 'normal', title: '合成图文' }, { noteId: 'unknown' }], has_more: 1 },
    null,
    100,
  )
  expect(result).toMatchObject({
    items: [{ kind: 'image', url: '' }, { kind: 'unknown' }],
    hasMore: true,
    nextOffset: null,
  })
})
it('accepts account overview only for the selected account and does not substitute recent-video totals', () => {
  expect(
    normalizeRedFox(
      { operation: 'account', platform: 'douyin', accountId: 'synthetic' },
      { uid: 'synthetic', followers: 0, totalLikes: 900, workCount: null },
      null,
      100,
    ),
  ).toMatchObject({
    kind: 'account',
    fields: { followers: { value: 0 }, totalLikes: { value: 900 }, workCount: { value: null }, likes: { value: null } },
  })
  expect(() =>
    normalizeRedFox({ operation: 'account', platform: 'douyin', accountId: 'synthetic' }, { uid: 'other' }, null, 100),
  ).toThrow('invalid-response')
})
it('requires matching content-detail identity and bounded complete pages', () => {
  expect(() =>
    normalizeRedFox({ operation: 'content', platform: 'douyin', externalId: 'one' }, { id: 'other' }, null, 10),
  ).toThrow('invalid-response')
  expect(() => normalizeRedFox(works, { list: [{ id: 'one' }, { id: 'two' }] }, null, 1)).toThrow('invalid-response')
})
it.each([
  [0, null, null],
  ['2026-10-15 09:00:00', null, null],
  ['2026-10-15 09:00:00', 'Asia/Shanghai', '2026-10-15T01:00:00.000Z'],
  ['2026-10-15T09:00:00+08:00', null, '2026-10-15T01:00:00.000Z'],
  ['2026-03-08 02:30:00', 'America/New_York', null],
])('interprets provider time only with actual epoch/offset/verified zone: %s', (raw, zone, expected) => {
  expect(analyticsTimestamp(raw, zone)).toBe(expected)
})
