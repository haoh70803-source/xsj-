/** Endpoint mappings reject invalid structures instead of silently accepting an empty dataset. */
import { z } from 'zod'
import { analyticsTimestamp, measuredCount, missingMetrics } from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  DataProviderRequest,
  MetricFields,
  MetricName,
  NormalizedContent,
  NormalizedProviderResult,
} from '@deepseek-ai/dsh-experimental-education-platform'
import { RedFoxError } from './redfox.ts'

const object = z.record(z.string(), z.unknown())
type RecordValue = z.infer<typeof object>
const countNames: Record<MetricName, readonly string[]> = {
  likes: ['likes', 'likeCount', 'diggCount', 'digg_count', 'likedCount'],
  collects: ['collects', 'collectCount', 'collect_count', 'favorites', 'favoriteCount'],
  comments: ['comments', 'commentCount', 'comment_count'],
  shares: ['shares', 'shareCount', 'share_count'],
  views: ['views', 'viewCount', 'playCount', 'play_count'],
  followers: ['followers', 'followerCount', 'fansCount', 'fans', 'follower_count'],
  totalLikes: ['totalLikes', 'totalFavorited', 'total_favorited', 'likedCount'],
  workCount: ['workCount', 'awemeCount', 'aweme_count', 'noteCount'],
}
function record(value: unknown): RecordValue {
  const result = object.safeParse(value)
  if (!result.success) throw new RedFoxError('invalid-response', 'response-received')
  return result.data
}
function field(source: RecordValue, names: readonly string[]): { value: unknown; name: string | null } {
  for (const name of names) if (Object.hasOwn(source, name)) return { value: source[name], name }
  return { value: undefined, name: null }
}
function string(value: unknown, max = 1000): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value)
  return typeof value === 'string' && value.trim() && value.isWellFormed() && value.length <= max ? value.trim() : null
}
function nested(source: RecordValue, keys: readonly string[]): RecordValue {
  for (const key of keys) if (object.safeParse(source[key]).success) return record(source[key])
  return source
}
function metrics(source: RecordValue, account: boolean): MetricFields {
  const values = missingMetrics(),
    allowed: readonly MetricName[] = account
      ? ['followers', 'totalLikes', 'workCount']
      : ['likes', 'collects', 'comments', 'shares', 'views']
  return Object.fromEntries(
    Object.entries(values).map(([name, absent]) => {
      const key = z
        .enum(['likes', 'collects', 'comments', 'shares', 'views', 'followers', 'totalLikes', 'workCount'])
        .parse(name)
      if (!allowed.includes(key)) return [key, absent]
      const picked = field(source, countNames[key])
      return [key, picked.name === null ? absent : measuredCount(picked.value, picked.name)]
    }),
  ) as MetricFields
}
function content(
  value: unknown,
  request: DataProviderRequest,
  sourceTimeZone: string | null,
  expectedAccount: readonly string[],
): NormalizedContent {
  const row = record(value),
    author = nested(row, ['author', 'authorInfo', 'userInfo']),
    authorId = string(field(author, ['accountId', 'uid', 'userId', 'redId', 'secUid', 'sec_uid']).value)
  if (author !== row && authorId !== null && expectedAccount.length > 0 && !expectedAccount.includes(authorId))
    throw new RedFoxError('invalid-response', 'response-received')
  const externalId = string(
    field(row, ['awemeId', 'aweme_id', 'videoId', 'workId', 'noteId', 'note_id', 'opusId', 'id']).value,
    200,
  )
  if (externalId === null || (request.operation === 'content' && externalId !== request.externalId))
    throw new RedFoxError('invalid-response', 'response-received')
  const rawKind = string(field(row, ['awemeType', 'aweme_type', 'type', 'noteType', 'mediaType']).value)?.toLowerCase()
  const kind =
    rawKind === 'video' || (rawKind === '0' && request.platform === 'douyin')
      ? 'video'
      : rawKind === 'image' ||
          (rawKind === 'normal' && request.platform === 'xiaohongshu') ||
          (rawKind === '68' && request.platform === 'douyin') ||
          rawKind === 'photo'
        ? 'image'
        : rawKind === 'article'
          ? 'article'
          : 'unknown'
  let url =
    string(field(row, ['originalUrl', 'shareUrl', 'share_url', 'workUrl', 'noteUrl', 'url', 'link']).value, 4096) ?? ''
  if (url) {
    try {
      const parsed = new URL(url)
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) url = ''
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      url = ''
    }
  }
  const pin = field(row, ['isTop', 'is_top', 'pinned']).value
  return {
    externalId,
    kind,
    title: string(field(row, ['title', 'noteTitle', 'desc', 'description', 'content']).value, 10_000) ?? '',
    url,
    publishedAt: analyticsTimestamp(
      field(row, ['publishedAt', 'publishTime', 'createTime', 'create_time', 'time']).value,
      sourceTimeZone,
    ),
    pinned: typeof pin === 'boolean' ? pin : pin === 0 || pin === 1 ? pin === 1 : null,
    fields: metrics(nested(row, ['statistics', 'stats', 'metrics', 'interactInfo']), false),
    sourceDataAt: analyticsTimestamp(field(row, ['sourceDataAt', 'dataTime', 'updateTime']).value, sourceTimeZone),
  }
}

/**
 * Map a single complete response without alternate endpoints, local clock assumptions or synthesized totals.
 * @param request - the server-fixed endpoint identity.
 * @param value - bounded supplier data envelope contents.
 * @param sourceTimeZone - verified source zone, or null.
 * @param maxItems - configured per-response observation bound.
 * @param accountAliases - identity aliases from an already validated account response.
 * @returns explicit normalized endpoint result; unknown time/pagination remain unknown.
 */
export function normalizeRedFox(
  request: DataProviderRequest,
  value: unknown,
  sourceTimeZone: string | null,
  maxItems: number,
  accountAliases: readonly string[] = [],
): NormalizedProviderResult {
  if (request.operation === 'account') {
    const row = nested(record(value), ['user', 'account', 'userInfo']),
      aliases = ['accountId', 'uniqueId', 'unique_id', 'redId', 'userId', 'userid', 'secUid', 'sec_uid', 'uid', 'id']
        .map(key => string(row[key], 200))
        .filter((item): item is string => item !== null)
    if (!aliases.includes(request.accountId)) throw new RedFoxError('invalid-response', 'response-received')
    const fields = metrics(nested(row, ['statistics', 'stats', 'metrics']), true)
    return {
      kind: 'account',
      fields,
      aliases,
      sourceDataAt: analyticsTimestamp(field(row, ['sourceDataAt', 'dataTime', 'updateTime']).value, sourceTimeZone),
      observedFields: Object.values(fields).flatMap(metric =>
        metric.sourceField === null ? [] : [metric.sourceField],
      ),
    }
  }
  if (request.operation === 'content')
    return {
      kind: 'content',
      item: content(
        nested(record(value), ['work', 'note', 'awemeDetail', 'aweme_detail']),
        request,
        sourceTimeZone,
        accountAliases,
      ),
    }
  const row = Array.isArray(value) ? { items: value } : nested(record(value), ['result', 'page', 'data'])
  const list = field(row, ['list', 'items', 'records', 'works', 'notes', 'awemeList', 'aweme_list']).value
  if (!Array.isArray(list) || list.length > maxItems) throw new RedFoxError('invalid-response', 'response-received')
  const rawMore = field(row, ['hasMore', 'has_more']).value,
    next = field(row, ['nextOffset', 'next_offset', 'max_cursor', 'cursor']).value
  const offset = typeof next === 'string' && /^\d+$/.test(next) ? Number(next) : next
  const items = list.map(item => content(item, request, sourceTimeZone, [request.accountId, ...accountAliases]))
  if (new Set(items.map(item => item.externalId)).size !== items.length)
    throw new RedFoxError('invalid-response', 'response-received')
  return {
    kind: 'works',
    items,
    hasMore: typeof rawMore === 'boolean' ? rawMore : rawMore === 0 || rawMore === 1 ? rawMore === 1 : null,
    nextOffset: typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : null,
  }
}
