/** SQLite deployment options, resolved before the database is opened. */

/** Durable journal modes; memory and off cannot be selected. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/** Explicit storage location and finite lock waiting. */
export interface Config {
  /** Absolute isolated database path, or :memory: for tests. */
  readonly path: string
  /** Local disk uses WAL; network storage requires separate qualification. @default wal */
  readonly journalMode?: JournalMode
  /** Maximum SQLite lock wait in milliseconds, from 1 through 60000. @default 1000 */
  readonly busyTimeoutMs?: number
  /** Maximum UTF-8 bytes in one normalized draft. @default 1048576 */
  readonly maxBodyBytes?: number
  /** Maximum UTF-8 bytes in one trimmed project title or organization name. @default 200 */
  readonly maxTitleBytes?: number
  /** Largest page accepted by project and version queries. @default 100 */
  readonly maxPageSize?: number
  /** Maximum rows parsed from one bounded metric import. @default 10000 */
  readonly maxImportRows?: number
  /** Maximum saved content observations returned by one analytical query. @default 1000 */
  readonly maxAnalyticsItems?: number
  /** Maximum UTF-8 bytes in a stored external display URL. @default 4096 */
  readonly maxExternalUrlBytes?: number
}

/** All defaults are applied once at the configuration parser. */
export type ResolvedConfig = Required<Config>
