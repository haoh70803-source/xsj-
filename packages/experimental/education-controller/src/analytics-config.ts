/** One strict deployment boundary for metered provider capabilities and durable pool limits. */
import { z } from 'zod'
import { previousSevenCompleteDays } from '@deepseek-ai/dsh-experimental-education-platform'
import type { ContentPlatform, SyncParameters } from '@deepseek-ai/dsh-experimental-education-platform'

const nonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return value === 'UTC' || value.includes('/')
  } catch (error) {
    if (error instanceof RangeError) return false
    throw error
  }
})
const quota = z.strictObject({
  poolId: z.string().min(1).max(200).default('redfox-default'),
  timeZone: timeZone.default('Asia/Shanghai'),
  resumeEpoch: z.string().min(1).max(200).default('initial'),
  maxCalls: nonnegative.default(0),
  maxCallsPerDay: nonnegative.default(0),
  maxCallsPerAccount: nonnegative.default(0),
  maxCostMicros: nonnegative.nullable().default(null),
  accountCostMicros: nonnegative.nullable().default(null),
  worksCostMicros: nonnegative.nullable().default(null),
  contentCostMicros: nonnegative.nullable().default(null),
})
const config = z.strictObject({
  enabled: z.boolean().default(false),
  baseUrl: z.url().default('https://redfox.hk/'),
  credentialRef: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .default('REDFOX_API_KEY'),
  allowLoopback: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
  maxResponseBytes: z.number().int().min(1024).max(33_554_432).default(2_000_000),
  maxItemsPerPage: z.number().int().min(1).max(10_000).default(200),
  recentCount: z.union([z.literal(3), z.literal(5)]).default(5),
  timeZone: timeZone.default('Asia/Shanghai'),
  sourceTimeZone: timeZone.nullable().default(null),
  sortTypes: z
    .strictObject({
      douyin: z.string().min(1).max(100).nullable().default(null),
      xiaohongshu: z.string().min(1).max(100).nullable().default(null),
    })
    .prefault({}),
  verifiedOrder: z.boolean().default(false),
  fetchDetails: z.boolean().default(false),
  maxPages: z.number().int().min(1).max(1000).default(10),
  maxCallsPerRun: z.number().int().min(1).max(10_000).default(20),
  maxRetries: z.number().int().min(0).max(5).default(0),
  retryDelayMs: z.number().int().min(0).max(60_000).default(1000),
  maxConcurrentRuns: z.number().int().min(1).max(16).default(2),
  schedulerIntervalMs: z.number().int().min(100).max(300_000).default(15_000),
  runTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
  quota: quota.prefault({}),
})
/** Fixed validated deployment policy; no employee request can enlarge it. */
export type AnalyticsConfig = z.infer<typeof config>
/**
 * Return validated defaults with paid calls disabled.
 * @param value - deployment configuration, never employee input.
 * @returns validated defaults with paid calls disabled.
 */
export function resolveAnalyticsConfig(value: unknown): AnalyticsConfig {
  return config.parse(value ?? {})
}
/**
 * Fix a requested scope before it joins an existing run.
 * @param config - deployment-selected caps and verified capabilities.
 * @param mode - explicit employee or daily scope.
 * @param platform - saved account platform, never a requested endpoint.
 * @returns immutable parameters; missing sort capability prevents any paid admission.
 */
export function analyticsParameters(
  config: AnalyticsConfig,
  mode: SyncParameters['mode'],
  platform: ContentPlatform,
): SyncParameters {
  const sortType = config.sortTypes[platform]
  if (sortType === null)
    throw new Error('Configure the verified platform sortType before enabling metered synchronization')
  return {
    poolId: config.quota.poolId,
    mode,
    recentCount: config.recentCount,
    window: mode === 'latest' ? null : previousSevenCompleteDays(Date.now(), config.timeZone),
    maxPages: config.maxPages,
    maxCalls: config.maxCallsPerRun,
    sortType,
    mappingVersion: `redfox-field-map-v1:${config.sourceTimeZone ?? 'unknown-zone'}`,
    verifiedOrder: config.verifiedOrder,
    fetchDetails: config.fetchDetails,
    maxRetries: config.maxRetries,
    retryDelayMs: config.retryDelayMs,
  }
}
