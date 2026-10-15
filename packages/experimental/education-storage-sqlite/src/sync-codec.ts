/** Durable synchronization codecs keep login and offline authority explicitly discriminated. */
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  AnalyticsScheduleId,
  ContentAccountId,
  LoginSessionId,
  OrganizationId,
  QuotaLimits,
  SyncAuthority,
  SyncCheckpoint,
  SyncParameters,
  UserId,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { id } from './codec.ts'
import { metricFieldsSchema, normalizedContentSchema } from './analytics-codec.ts'

const uuid = <T extends Branded<string>>() => z.string().transform(value => id<T>(value))
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const iso = z.iso.datetime({ precision: 3 })
const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return value === 'UTC' || value.includes('/')
  } catch (error) {
    if (error instanceof RangeError) return false
    throw error
  }
})
/** Exact offline/login authority stored by the trusted runtime. */
export const syncAuthoritySchema: z.ZodType<SyncAuthority> = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('login'),
    actor: z.strictObject({
      organizationId: uuid<OrganizationId>(),
      userId: uuid<UserId>(),
      loginSessionId: uuid<LoginSessionId>(),
      authRevision: integer,
    }),
    accountId: uuid<ContentAccountId>(),
    grantRevision: integer.min(1),
    accountRevision: integer.min(1),
  }),
  z.strictObject({
    kind: z.literal('schedule'),
    organizationId: uuid<OrganizationId>(),
    userId: uuid<UserId>(),
    userAuthRevision: integer,
    accountId: uuid<ContentAccountId>(),
    grantRevision: integer.min(1),
    accountRevision: integer.min(1),
    scheduleId: uuid<AnalyticsScheduleId>(),
  }),
])
/** Fixed explicit publication policy and finite operation bounds. */
export const syncParametersSchema: z.ZodType<SyncParameters> = z.strictObject({
  poolId: z.string().min(1).max(200),
  mode: z.enum(['latest', 'seven-days']),
  recentCount: z.union([z.literal(3), z.literal(5)]),
  window: z.strictObject({ from: iso, to: iso, timeZone, mode: z.enum(['complete-days', 'rolling']) }).nullable(),
  maxPages: integer.min(1).max(10_000),
  maxCalls: integer.min(1).max(100_000),
  sortType: z.string().min(1).max(100),
  mappingVersion: z.string().min(1).max(200),
  verifiedOrder: z.boolean(),
  fetchDetails: z.boolean(),
  maxRetries: integer.max(10),
  retryDelayMs: integer.max(60_000),
})
/** Immutable committed page/retry position. */
export const syncCheckpointSchema: z.ZodType<SyncCheckpoint> = z.strictObject({
  phase: z.enum(['account', 'works', 'details', 'done']),
  nextOffset: integer,
  pages: integer,
  contents: integer,
  coverage: z.enum(['complete', 'partial', 'unknown']),
  detailIds: z.array(z.string()),
  detailIndex: integer,
  seenOffsets: z.array(integer),
  accountAliases: z.array(z.string()),
  retry: integer,
})
/** Quota prices are explicit upper reservations, never inferred actual fees. */
export const quotaLimitsSchema: z.ZodType<QuotaLimits> = z
  .strictObject({
    poolId: z.string().min(1).max(200),
    timeZone,
    resumeEpoch: z.string().min(1).max(200),
    maxCalls: integer,
    maxCallsPerDay: integer,
    maxCallsPerAccount: integer,
    maxCostMicros: integer.nullable(),
    accountCostMicros: integer.nullable(),
    worksCostMicros: integer.nullable(),
    contentCostMicros: integer.nullable(),
  })
  .superRefine((value, context) => {
    const prices = [value.accountCostMicros, value.worksCostMicros, value.contentCostMicros].filter(
      (price): price is number => price !== null,
    )
    if (prices.some(price => !Number.isSafeInteger(price * value.maxCalls)))
      context.addIssue({ code: 'custom', message: 'configured monetary reservations exceed exact integer precision' })
  })
/** Stored supplier results are normalized before they join business observations. */
export const providerResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('account'),
    fields: metricFieldsSchema,
    sourceDataAt: iso.nullable(),
    aliases: z.array(z.string()),
    observedFields: z.array(z.string()),
  }),
  z.strictObject({
    kind: z.literal('works'),
    items: z.array(normalizedContentSchema),
    hasMore: z.boolean().nullable(),
    nextOffset: integer.nullable(),
  }),
  z.strictObject({ kind: z.literal('content'), item: normalizedContentSchema }),
])
/**
 * Normalize captured scope and reject a contradictory window before any request can be reserved.
 * @param value - trusted deployment-resolved scope at the admission boundary.
 * @returns complete fixed parameters or an explicit invalid-input failure.
 */
export function checkedSyncParameters(value: SyncParameters): SyncParameters {
  const parsed = syncParametersSchema.safeParse(value)
  if (
    !parsed.success ||
    (value.mode === 'latest' && value.window !== null) ||
    (value.mode === 'seven-days' && (value.window === null || value.window.from >= value.window.to))
  )
    throw new EducationError('validation-failed', 'sync publication window or configured limits are invalid')
  return parsed.data
}
