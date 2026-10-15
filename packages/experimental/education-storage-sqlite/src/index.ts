/** Explicit SQLite education provider; no HTTP routes, model calls or original prototype data migration. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-education-platform'
import { SqliteEducationRepository } from './repository.ts'
export { SqliteEducationRepository } from './repository.ts'
import type { Config as StorageConfig, ResolvedConfig } from './types.ts'

export type { JournalMode, ResolvedConfig } from './types.ts'
export { EDUCATION_SCHEMA_VERSION } from './schema.ts'

/** Explicit isolated storage deployment configuration. */
export interface Config extends StorageConfig {}

/** Stable function-plugin name. */
export const name = 'education-storage-sqlite'

/** Configuration is parsed before filesystem setup or database access. */
export const Config: z<StorageConfig> = z.object({
  path: z.string().required(),
  journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
  busyTimeoutMs: z.number().step(1).min(1).max(60_000).default(1_000),
  maxBodyBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1_048_576),
  maxTitleBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(200),
  maxPageSize: z.number().step(1).min(1).max(1_000).default(100),
  maxImportRows: z.number().step(1).min(1).max(100_000).default(10_000),
  maxAnalyticsItems: z.number().step(1).min(1).max(10_000).default(1000),
  maxExternalUrlBytes: z.number().step(1).min(64).max(16_384).default(4096),
})

/**
 * Resolve deployment defaults before opening storage.
 * @param config - external plugin options.
 * @returns all schema defaults applied and validated.
 */
export function resolveConfig(config: StorageConfig): ResolvedConfig {
  return Config(config) as ResolvedConfig
}

/**
 * Provide a validated repository and own its reversible database lifetime.
 * @param ctx - provider-owning context.
 * @param config - explicit isolated storage configuration.
 */
export async function apply(ctx: Context, config: StorageConfig): Promise<void> {
  const repository = await SqliteEducationRepository.open(resolveConfig(config))
  try {
    ctx.effect(
      () => () => {
        repository.close()
      },
      'education-storage-sqlite: close repository',
    )
    ctx.provide('educationRepository', repository)
  } catch (error) {
    repository.close()
    throw error
  }
}
