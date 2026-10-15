/** Publication windows and statistics use only already authorized, normalized observations. */
import { Temporal } from '@js-temporal/polyfill'
import type {
  ContentAnalysis,
  ContentObservation,
  MetricFields,
  MetricName,
  PublicationWindow,
} from './analytics-types.ts'

/**
 * Interpret provider time only with an explicit offset, positive epoch or configured source zone.
 * @param value - untrusted provider field; zero placeholders remain unknown.
 * @param sourceTimeZone - documented provider zone, or null when not verified.
 * @returns canonical instant, or null without inventing publication/freshness time.
 */
export function analyticsTimestamp(value: unknown, sourceTimeZone: string | null): string | null {
  try {
    if (typeof value === 'number' || (typeof value === 'string' && /^\d{9,16}$/.test(value))) {
      const epoch = Number(value)
      if (!Number.isSafeInteger(epoch) || epoch <= 0) return null
      return new Date(epoch < 10_000_000_000 ? epoch * 1000 : epoch).toISOString()
    }
    if (typeof value !== 'string' || !value.trim()) return null
    if (/(?:Z|[+-]\d\d:\d\d)$/i.test(value))
      return new Date(Temporal.Instant.from(value).epochMilliseconds).toISOString()
    if (sourceTimeZone !== null && /^\d{4}-\d{2}-\d{2}[ T]\d\d:\d\d/.test(value))
      return new Date(
        Temporal.PlainDateTime.from(value.replace(' ', 'T')).toZonedDateTime(sourceTimeZone, {
          disambiguation: 'reject',
        }).epochMilliseconds,
      ).toISOString()
    return null
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

/**
 * Resolve the current calendar date in a validated zone.
 * @param now - trusted epoch milliseconds.
 * @param timeZone - calendar zone.
 * @returns ISO local date, independent of the host timezone.
 */
export function analyticsLocalDate(now: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).toPlainDate().toString()
}
/**
 * Resolve one local day for durable quota accounting.
 * @param now - trusted epoch milliseconds.
 * @param timeZone - explicitly configured billing day zone.
 * @returns half-open UTC day boundaries.
 */
export function analyticsDay(now: number, timeZone: string): { from: string; to: string } {
  const date = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).toPlainDate()
  return {
    from: new Date(date.toZonedDateTime(timeZone).epochMilliseconds).toISOString(),
    to: new Date(date.add({ days: 1 }).toZonedDateTime(timeZone).epochMilliseconds).toISOString(),
  }
}
/**
 * Find the next actual daily occurrence without replaying one run for every missed date.
 * @param now - trusted epoch milliseconds.
 * @param timeZone - selected calendar zone.
 * @param hour - validated local hour.
 * @param minute - validated local minute.
 * @returns next future UTC occurrence, using the zone's calendar transitions.
 */
export function nextAnalyticsDaily(now: number, timeZone: string, hour: number, minute: number): string {
  const current = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone)
  let target = current.with({ hour, minute, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
  if (target.epochMilliseconds <= now) target = target.add({ days: 1 })
  return new Date(target.epochMilliseconds).toISOString()
}

/**
 * Select seven complete local publication days, excluding the incomplete current day.
 * @param now - trusted current instant in epoch milliseconds.
 * @param timeZone - validated IANA calendar zone.
 * @returns exact half-open UTC boundaries, including daylight-saving transitions.
 */
export function previousSevenCompleteDays(now: number, timeZone: string): PublicationWindow {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).toPlainDate()
  return {
    from: new Date(today.subtract({ days: 7 }).toZonedDateTime(timeZone).epochMilliseconds).toISOString(),
    to: new Date(today.toZonedDateTime(timeZone).epochMilliseconds).toISOString(),
    timeZone,
    mode: 'complete-days',
  }
}

/**
 * Initialize all metric fields as missing, never as invented zero.
 * @returns independent missing entries for each supported metric.
 */
export function missingMetrics(): MetricFields {
  const missing = () => ({ value: null, state: 'missing', sourceField: null }) as const
  return {
    likes: missing(),
    collects: missing(),
    comments: missing(),
    shares: missing(),
    views: missing(),
    followers: missing(),
    totalLikes: missing(),
    workCount: missing(),
  }
}

/**
 * Calculate a source-specific median before display-only keyword filtering.
 * @param rows - one authorized source's observations, including duplicates.
 * @param recentCount - explicitly selected 3 or 5 video sample size.
 * @param window - publication interval, or null for recent videos.
 * @param keyword - display-only title keyword.
 * @returns chronological videos, separate image rows and the strict-above-median subset.
 */
export function analyzeContent(
  rows: readonly ContentObservation[],
  recentCount: 3 | 5,
  window: PublicationWindow | null,
  keyword: string,
): ContentAnalysis {
  const unique = new Map<string, ContentObservation>()
  for (const row of rows) {
    const key = JSON.stringify([row.accountId, row.externalId, row.source]),
      previous = unique.get(key)
    if (
      previous === undefined ||
      row.fetchedAt > previous.fetchedAt ||
      (row.fetchedAt === previous.fetchedAt && row.snapshotId > previous.snapshotId)
    )
      unique.set(key, row)
  }
  const all = [...unique.values()]
  const eligible = all
    .filter(
      row =>
        row.publishedAt !== null &&
        (window === null || (row.publishedAt >= window.from && row.publishedAt < window.to)),
    )
    .sort(
      (a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || a.externalId.localeCompare(b.externalId),
    )
  const videos = eligible.filter(row => row.kind === 'video'),
    sample = window === null ? videos.slice(0, recentCount) : videos
  const knownLikes = (row: ContentObservation): number | null =>
    row.fields.likes.state === 'known' ? row.fields.likes.value : null
  const likes = sample
    .flatMap((row) => {
      const value = knownLikes(row)
      return value === null ? [] : [value]
    })
    .sort((a, b) => a - b)
  const middle = Math.floor(likes.length / 2),
    center = likes[middle],
    lower = likes[middle - 1]
  const median =
    center === undefined ? null : likes.length % 2 === 1 ? center : lower === undefined ? null : lower / 2 + center / 2
  const needle = keyword.trim().toLocaleLowerCase('zh-CN')
  const shown = (row: ContentObservation) => needle === '' || row.title.toLocaleLowerCase('zh-CN').includes(needle)
  return {
    items: sample.filter(shown),
    images: eligible.filter(row => row.kind === 'image').filter(shown),
    undated: all.filter(row => row.publishedAt === null).filter(shown),
    unknownPublicationCount: all.filter(row => row.publishedAt === null).length,
    medianLikes: median,
    validSampleCount: likes.length,
    baselineCount: sample.length,
    aboveMedian:
      median === null
        ? []
        : sample
          .filter((row) => {
            const value = knownLikes(row)
            return value !== null && value > median
          })
          .filter(shown),
    window,
    recentCount,
  }
}

/**
 * Parse a supplier count while preserving known zero and explicit missing values.
 * @param value - raw supplier field.
 * @param sourceField - mapped supplier field name.
 * @returns a measured integer or a missing state; formatted unit strings are not guessed.
 */
export function measuredCount(value: unknown, sourceField: string): MetricFields[MetricName] {
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0
    ? { value: parsed, state: 'known', sourceField }
    : { value: null, state: 'missing', sourceField }
}
