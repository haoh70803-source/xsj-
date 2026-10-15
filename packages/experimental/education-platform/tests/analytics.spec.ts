/** Calendar and sampling rules are independent of supplier calls and display filters. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentAccountId, ContentObservation, ExternalContentId, MetricSnapshotId } from '../src/types.ts'
import { analyzeContent, measuredCount, missingMetrics, previousSevenCompleteDays } from '../src/analytics.ts'

function row(index: number, likes: number | null, overrides: Partial<ContentObservation> = {}): ContentObservation {
  return {
    id: brandString<ExternalContentId>(`content-${index}`),
    snapshotId: brandString<MetricSnapshotId>(`snapshot-${index}`),
    accountId: brandString<ContentAccountId>('account'),
    externalId: String(index),
    kind: 'video',
    title: `作品${index}`,
    url: '',
    publishedAt: `2026-10-${String(14 - index).padStart(2, '0')}T00:00:00.000Z`,
    pinned: false,
    source: 'explicit-test-import',
    sourceDataAt: null,
    fetchedAt: '2026-10-15T00:00:00.000Z',
    fields: {
      ...missingMetrics(),
      likes: { value: likes, state: likes === null ? 'missing' : 'known', sourceField: 'likes' },
    },
    ...overrides,
  }
}

it('uses the previous seven complete Shanghai calendar dates and excludes the incomplete current day', () => {
  expect(previousSevenCompleteDays(Date.parse('2026-10-15T04:35:00.000Z'), 'Asia/Shanghai')).toEqual({
    from: '2026-10-07T16:00:00.000Z',
    to: '2026-10-14T16:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    mode: 'complete-days',
  })
})
it('uses calendar boundaries across daylight saving instead of subtracting a fixed 168 hours', () => {
  const window = previousSevenCompleteDays(Date.parse('2026-03-11T16:00:00.000Z'), 'America/New_York')
  expect(window.from).toBe('2026-03-04T05:00:00.000Z')
  expect(window.to).toBe('2026-03-11T04:00:00.000Z')
  expect((Date.parse(window.to) - Date.parse(window.from)) / 3_600_000).toBe(167)
})
it('selects the latest five videos by publication time, with images separate and pinning ignored', () => {
  const rows = Array.from({ length: 6 }, (_, index) => row(index, index))
  rows.push(row(7, 1000, { pinned: true }), row(8, 2000, { kind: 'image' }), row(9, 3000, { publishedAt: null }))
  const result = analyzeContent(rows.reverse(), 5, null, '')
  expect(result.items.map(item => item.externalId)).toEqual(['0', '1', '2', '3', '4'])
  expect(result.images.map(item => item.externalId)).toEqual(['8'])
  expect(result.unknownPublicationCount).toBe(1)
})
it('includes known zero, excludes missing and estimated counts, and requires strictly above the median', () => {
  const estimated = row(4, 100)
  const rows = [
    row(0, 0),
    row(1, 10),
    row(2, null),
    row(3, 20),
    {
      ...estimated,
      fields: { ...estimated.fields, likes: { value: 100, state: 'estimated', sourceField: 'estimate' } as const },
    },
  ]
  const result = analyzeContent(rows, 5, null, '')
  expect(result).toMatchObject({ medianLikes: 10, validSampleCount: 3, baselineCount: 5 })
  expect(result.aboveMedian.map(item => item.externalId)).toEqual(['3'])
})
it('computes even medians and preserves the same baseline when a keyword filters displayed rows', () => {
  const rows = [row(0, 0), row(1, 2), row(2, 4), row(3, 6, { title: '关键词作品' })]
  const result = analyzeContent(rows, 5, null, '关键词')
  expect(result).toMatchObject({ medianLikes: 3, validSampleCount: 4, baselineCount: 4 })
  expect(result.items.map(item => item.externalId)).toEqual(['3'])
})
it('deduplicates one source and keeps a later lower cumulative count without inventing a positive delta', () => {
  const older = row(0, 1000, { fetchedAt: '2026-10-14T00:00:00.000Z' }),
    newer = row(0, 0)
  expect(analyzeContent([older, newer], 5, null, '')).toMatchObject({ medianLikes: 0, baselineCount: 1 })
})
it('applies a half-open seven-day publication interval without changing the configured recent count', () => {
  const window = previousSevenCompleteDays(Date.parse('2026-10-15T04:35:00.000Z'), 'Asia/Shanghai')
  const result = analyzeContent(
    [
      row(0, 1, { publishedAt: window.from }),
      row(1, 2, { publishedAt: window.to }),
      row(2, 3, { publishedAt: '2026-10-14T15:59:59.999Z' }),
    ],
    5,
    window,
    '',
  )
  expect(result.items.map(item => item.externalId)).toEqual(['2', '0'])
  expect(result.recentCount).toBe(5)
})
it.each([0, '0', 7, '7'])('retains the known supplier count %s', (value) => {
  expect(measuredCount(value, 'reported')).toMatchObject({ value: Number(value), state: 'known' })
})
it.each([null, undefined, false, '', '1.2万', -1, Infinity, '9007199254740992'])(
  'does not coerce missing or unsupported count %s to zero',
  (value) => {
    expect(measuredCount(value, 'reported')).toMatchObject({ value: null, state: 'missing' })
  },
)
