/** Strict durable metric decoding and canonical imported timestamps; unknown fields never become zero. */
import { z } from 'zod'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  AccountPermissions,
  AnalyticsWriteResult,
  ContentAccount,
  ContentAccountId,
  MetricFields,
  MetricImportId,
  AnalyticsScheduleId,
  UserId,
  NormalizedContent,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { id, integer, text, type Row } from './codec.ts'

/** All independent account permissions, parsed before mutation. */
export const accountPermissionsSchema = z.strictObject({
  view: z.boolean(),
  sync: z.boolean(),
  manage: z.boolean(),
  export: z.boolean(),
  use_for_ai: z.boolean(),
})
const metric = z
  .strictObject({
    value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    state: z.enum(['known', 'estimated', 'missing', 'not-authorized']),
    sourceField: z.string().nullable(),
  })
  .refine(value =>
    value.state === 'known' || value.state === 'estimated' ? value.value !== null : value.value === null,
  )
/** One complete observed metric dictionary, including explicit missing entries. */
export const metricFieldsSchema: z.ZodType<MetricFields> = z.strictObject({
  likes: metric,
  collects: metric,
  comments: metric,
  shares: metric,
  views: metric,
  followers: metric,
  totalLikes: metric,
  workCount: metric,
})
/** Normalized saved row used by import previews and externally validated provider pages. */
export const normalizedContentSchema: z.ZodType<NormalizedContent> = z.strictObject({
  externalId: z.string().min(1),
  kind: z.enum(['video', 'image', 'article', 'unknown']),
  title: z.string(),
  url: z.string(),
  publishedAt: z.iso.datetime({ precision: 3 }).nullable(),
  pinned: z.boolean().nullable(),
  fields: metricFieldsSchema,
  sourceDataAt: z.iso.datetime({ precision: 3 }).nullable(),
})

const accountId = z.string().transform(value => id<ContentAccountId>(value)),
  revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const ackSchema: z.ZodType<AnalyticsWriteResult> = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.enum(['accounts.create', 'accounts.enable']), accountId, revision }),
  z.strictObject({
    operation: z.literal('accounts.grant'),
    accountId,
    userId: z.string().transform(value => id<UserId>(value)),
    revision,
  }),
  z.strictObject({
    operation: z.literal('imports.commit'),
    accountId,
    importId: z.string().transform(value => id<MetricImportId>(value)),
    accepted: revision,
    rejected: revision,
    skipped: revision,
  }),
  z.strictObject({
    operation: z.literal('schedules.save'),
    accountId,
    scheduleId: z.string().transform(value => id<AnalyticsScheduleId>(value)),
    revision,
  }),
])

/**
 * Decode stored JSON without returning corrupt data or hiding an invalid state.
 * @param schema - owning durable schema.
 * @param serialized - private database JSON.
 * @returns checked record, or a contained storage failure.
 */
export function analyticsStored<T>(schema: z.ZodType<T>, serialized: string): T {
  try {
    return schema.parse(JSON.parse(serialized))
  } catch (error) {
    throw new EducationError('storage-unavailable', 'stored analytics record is invalid', { cause: error })
  }
}
/**
 * Decode an immutable mutation acknowledgement.
 * @param serialized - original receipt.
 * @returns the original revision/count result, never a frozen authorization grant.
 */
export function analyticsAck(serialized: string): AnalyticsWriteResult {
  return analyticsStored(ackSchema, serialized)
}

function flag(row: Row, column: string): boolean {
  if (row[column] !== 0 && row[column] !== 1)
    throw new EducationError('storage-unavailable', 'stored account permission is invalid')
  return row[column] === 1
}
/**
 * Decode independent grants from the fixed account-scoped query.
 * @param row - joined current account/user grant.
 * @returns five independent privileges.
 */
export function accountPermissions(row: Row): AccountPermissions {
  return {
    view: flag(row, 'can_view'),
    sync: flag(row, 'can_sync'),
    manage: flag(row, 'can_manage'),
    export: flag(row, 'can_export'),
    use_for_ai: flag(row, 'can_use_for_ai'),
  }
}
/**
 * Return current safe account metadata, excluding org, owner credentials and shared budget state.
 * @param row - authorized account/grant row.
 * @returns current metadata and grant revision.
 */
export function contentAccount(row: Row): ContentAccount {
  if (row.platform !== 'douyin' && row.platform !== 'xiaohongshu')
    throw new EducationError('storage-unavailable', 'stored content platform is invalid')
  return {
    id: id(row.id),
    platform: row.platform,
    externalId: text(row, 'external_id'),
    title: text(row, 'title'),
    enabled: flag(row, 'enabled'),
    revision: integer(row.revision),
    grantRevision: integer(row.grant_revision),
    permissions: accountPermissions(row),
  }
}
/**
 * Parse an explicitly offset timestamp, keeping missing source time distinct from collection time.
 * @param value - supplied ISO timestamp.
 * @returns canonical UTC milliseconds.
 */
export function observationTime(value: string): string {
  const valid = z.iso.datetime({ offset: true }).safeParse(value)
  if (!valid.success || !Number.isFinite(Date.parse(value)))
    throw new EducationError('validation-failed', 'analytics time requires a valid explicit UTC offset')
  return new Date(value).toISOString()
}
