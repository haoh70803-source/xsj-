/** Private account grants, immutable source-separated observations and two-step metric import. */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  EducationError,
  analyzeContent,
  measuredCount,
  missingMetrics,
  previousSevenCompleteDays,
} from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  AccountGrantView,
  AccountPermissions,
  ActorContext,
  AnalyticsDataset,
  AnalyticsQuery,
  AnalyticsRepository,
  AnalyticsWriteResult,
  AccountMetricObservation,
  CommitMetricImportInput,
  ContentAccount,
  ContentAccountId,
  ContentObservation,
  CreateContentAccountInput,
  MetricFields,
  MetricImportId,
  MetricImportPreview,
  NormalizedContent,
  PreviewMetricImportInput,
  RequestId,
  SetAccountEnabledInput,
  SetAccountGrantInput,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { digest, id, integer, newId, text, timestamp, type Row } from './codec.ts'
import {
  accountPermissions,
  accountPermissionsSchema,
  analyticsAck,
  analyticsStored,
  contentAccount,
  metricFieldsSchema,
  normalizedContentSchema,
  observationTime,
} from './analytics-codec.ts'

interface Owner {
  transaction<T>(actor: ActorContext, work: () => T, write?: boolean): T
  readonly maxBodyBytes: number
  readonly maxTitleBytes: number
  readonly maxPageSize: number
  readonly maxImportRows: number
  readonly maxAnalyticsItems: number
  readonly maxExternalUrlBytes: number
}
const unavailable = () => new EducationError('resource-unavailable', 'account resource is unavailable')
const conflict = () =>
  new EducationError('version-conflict', 'account or import baseline changed; refresh before continuing')
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional()
const scalarMetrics = {
  likes: count,
  collects: count,
  comments: count,
  shares: count,
  views: count,
  followers: count,
  totalLikes: count,
  workCount: count,
}
const overviewInput = z.strictObject({ followers: count, totalLikes: count, workCount: count })
const previewStored = z.strictObject({
  rows: z.array(normalizedContentSchema),
  accountFields: metricFieldsSchema.nullable(),
  errors: z.array(z.strictObject({ row: z.number().int().nonnegative(), code: z.string() })),
  skipped: z.number().int().nonnegative(),
  baseline: z.string(),
  grantRevision: z.number().int().positive(),
})

/** Same-medium analytics; no method in this class contacts an external service. */
export class SqliteAnalyticsRepository implements AnalyticsRepository {
  private readonly observers = new Set<(accountId: ContentAccountId) => void>()
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: Owner,
  ) {}

  onAccountCommit(listener: (accountId: ContentAccountId) => void): () => void {
    this.observers.add(listener)
    return () => {
      this.observers.delete(listener)
    }
  }
  /** Withdraw Host observers before the owning medium closes. */
  dispose(): void {
    this.observers.clear()
  }
  requireAccess(actor: ActorContext, accountId: ContentAccountId): void {
    this.owner.transaction(actor, () => {
      this.accountInside(actor, accountId, null)
    })
  }
  requireExport(actor: ActorContext, accountId: ContentAccountId): void {
    this.owner.transaction(actor, () => {
      this.accountInside(actor, accountId, 'view')
      this.accountInside(actor, accountId, 'export', true)
    })
  }

  /**
   * Check one current account grant inside the caller's already authorized transaction.
   * @param actor - current trusted employee.
   * @param accountId - internal account, never an external ID.
   * @param permission - specific privilege or null for safe metadata access.
   * @param requireEnabled - refuse active processing for a disabled account.
   * @returns current joined row, without selecting user credentials.
   */
  accountInside(
    actor: ActorContext,
    accountId: ContentAccountId,
    permission: keyof AccountPermissions | null,
    requireEnabled = false,
  ): Row {
    const row = this.db
      .prepare(
        `SELECT a.*,g.can_view,g.can_sync,g.can_manage,g.can_export,g.can_use_for_ai,g.revision AS grant_revision
      FROM content_accounts a JOIN account_grants g ON g.account_id=a.id AND g.organization_id=a.organization_id
      WHERE a.id=? AND a.organization_id=? AND g.user_id=?`,
      )
      .get(accountId, actor.organizationId, actor.userId)
    if (row === undefined || (requireEnabled && row.enabled !== 1)) throw unavailable()
    const permissions = accountPermissions(row)
    if (permission === null ? !Object.values(permissions).some(Boolean) : !permissions[permission]) throw unavailable()
    return row
  }

  createAccount(actor: ActorContext, input: CreateContentAccountInput): AnalyticsWriteResult {
    const title = this.label(input.title),
      externalId = this.label(input.externalId)
    if (!['douyin', 'xiaohongshu'].includes(input.platform) || /^https?:/i.test(externalId))
      throw new EducationError('validation-failed', 'content account needs an explicit supported platform identifier')
    return this.mutation(
      actor,
      'accounts.create',
      input.requestId,
      { platform: input.platform, title, externalId },
      () => {
        const existing = this.db
          .prepare(
            'SELECT id FROM content_accounts WHERE organization_id=? AND owner_id=? AND platform=? AND external_id=?',
          )
          .get(actor.organizationId, actor.userId, input.platform, externalId)
        if (existing !== undefined) throw new EducationError('version-conflict', 'this private account already exists')
        const accountId = newId<ContentAccountId>()
        this.db
          .prepare('INSERT INTO content_accounts VALUES(?,?,?,?,?,?,1,1,?)')
          .run(
            accountId,
            actor.organizationId,
            actor.userId,
            input.platform,
            externalId,
            title,
            new Date().toISOString(),
          )
        this.db
          .prepare('INSERT INTO account_grants VALUES(?,?,?,?,?,?,?,?,1)')
          .run(accountId, actor.organizationId, actor.userId, 1, 1, 1, 1, 1)
        return { operation: 'accounts.create', accountId, revision: 1 }
      },
    )
  }

  listAccounts(actor: ActorContext): readonly ContentAccount[] {
    return this.owner.transaction(actor, () =>
      this.db
        .prepare(
          `SELECT a.*,g.can_view,g.can_sync,g.can_manage,g.can_export,g.can_use_for_ai,g.revision AS grant_revision
      FROM content_accounts a JOIN account_grants g ON g.account_id=a.id AND g.organization_id=a.organization_id
      WHERE a.organization_id=? AND g.user_id=? AND (g.can_view=1 OR g.can_sync=1 OR g.can_manage=1 OR g.can_export=1 OR g.can_use_for_ai=1)
      ORDER BY a.created_at DESC,a.id LIMIT ?`,
        )
        .all(actor.organizationId, actor.userId, this.owner.maxPageSize)
        .map(contentAccount),
    )
  }

  listGrants(actor: ActorContext, accountId: ContentAccountId): readonly AccountGrantView[] {
    return this.owner.transaction(actor, () => {
      this.accountInside(actor, accountId, 'manage')
      return this.db
        .prepare(
          `SELECT g.*,u.username_normalized FROM account_grants g JOIN users u ON u.id=g.user_id AND u.organization_id=g.organization_id
        WHERE g.account_id=? ORDER BY u.username_normalized LIMIT ?`,
        )
        .all(accountId, this.owner.maxPageSize)
        .map(row => ({
          userId: id(row.user_id),
          username: text(row, 'username_normalized'),
          permissions: accountPermissions(row),
          revision: integer(row.revision),
        }))
    })
  }

  setGrant(actor: ActorContext, input: SetAccountGrantInput): AnalyticsWriteResult {
    const username = input.username.normalize('NFKC').trim().toLowerCase(),
      permissions = accountPermissionsSchema.parse(input.permissions)
    return this.mutation(
      actor,
      'accounts.grant',
      input.requestId,
      { accountId: input.accountId, username, permissions, expectedRevision: input.expectedRevision },
      () => {
        const account = this.accountInside(actor, input.accountId, 'manage')
        const user = this.db
          .prepare("SELECT id FROM users WHERE organization_id=? AND username_normalized=? AND status='active'")
          .get(actor.organizationId, username)
        if (user === undefined) throw unavailable()
        if (user.id === account.owner_id && !permissions.manage)
          throw new EducationError('forbidden', 'the controlled owner retains account recovery management')
        const previous = this.db
          .prepare('SELECT revision FROM account_grants WHERE account_id=? AND user_id=?')
          .get(input.accountId, text(user, 'id'))
        if ((previous === undefined ? 0 : integer(previous.revision)) !== input.expectedRevision) throw conflict()
        const revision = integer(input.expectedRevision + 1)
        this.db
          .prepare(
            `INSERT INTO account_grants VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,user_id) DO UPDATE SET
        can_view=excluded.can_view,can_sync=excluded.can_sync,can_manage=excluded.can_manage,can_export=excluded.can_export,can_use_for_ai=excluded.can_use_for_ai,revision=excluded.revision`,
          )
          .run(
            input.accountId,
            actor.organizationId,
            text(user, 'id'),
            Number(permissions.view),
            Number(permissions.sync),
            Number(permissions.manage),
            Number(permissions.export),
            Number(permissions.use_for_ai),
            revision,
          )
        this.invalidateSchedulesInside(input.accountId, text(user, 'id'))
        return { operation: 'accounts.grant', accountId: input.accountId, userId: id(user.id), revision }
      },
    )
  }

  setEnabled(actor: ActorContext, input: SetAccountEnabledInput): AnalyticsWriteResult {
    return this.mutation(actor, 'accounts.enable', input.requestId, input, () => {
      const account = this.accountInside(actor, input.accountId, 'manage')
      if (account.revision !== input.expectedRevision) throw conflict()
      const revision = integer(input.expectedRevision + 1)
      this.db
        .prepare('UPDATE content_accounts SET enabled=?,revision=? WHERE id=?')
        .run(Number(input.enabled), revision, input.accountId)
      if (
        this.db
          .prepare('SELECT account_id FROM account_grants WHERE account_id=? AND revision>=? LIMIT 1')
          .get(input.accountId, Number.MAX_SAFE_INTEGER) !== undefined
      )
        throw new EducationError('validation-failed', 'account grant revision cannot advance safely')
      this.db.prepare('UPDATE account_grants SET revision=revision+1 WHERE account_id=?').run(input.accountId)
      this.invalidateSchedulesInside(input.accountId)
      return { operation: 'accounts.enable', accountId: input.accountId, revision }
    })
  }

  query(actor: ActorContext, input: AnalyticsQuery, recentCount: 3 | 5, timeZone: string, forExport = false): AnalyticsDataset {
    return this.owner.transaction(actor, () => {
      if (forExport) this.accountInside(actor, input.accountId, 'export', true)
      const account = contentAccount(this.accountInside(actor, input.accountId, 'view'))
      const sources = this.db
        .prepare(
          'SELECT source FROM account_snapshots WHERE account_id=? UNION SELECT source FROM content_snapshots WHERE account_id=? ORDER BY source',
        )
        .all(input.accountId, input.accountId)
        .map(row => text(row, 'source'))
      const snapshot = this.db
        .prepare(
          'SELECT * FROM account_snapshots WHERE account_id=? AND source=? ORDER BY fetched_at DESC,rowid DESC LIMIT 1',
        )
        .get(input.accountId, input.source)
      const overview: AccountMetricObservation | null =
        snapshot === undefined
          ? null
          : {
            id: id(snapshot.id),
            accountId: input.accountId,
            source: text(snapshot, 'source'),
            fields: analyticsStored(metricFieldsSchema, text(snapshot, 'fields_json')),
            sourceDataAt: snapshot.source_data_at === null ? null : timestamp(snapshot.source_data_at),
            fetchedAt: timestamp(snapshot.fetched_at),
            coverage: analyticsStored(
              z.object({ coverage: z.enum(['complete', 'partial', 'unknown']) }),
              text(snapshot, 'capability_json'),
            ).coverage,
          }
      const window = input.mode === 'seven-days' ? previousSevenCompleteDays(Date.now(), timeZone) : null
      const rows = this.db
        .prepare(
          `WITH latest AS(SELECT s.*,ROW_NUMBER() OVER(PARTITION BY content_id ORDER BY fetched_at DESC,rowid DESC) AS ordinal
        FROM content_snapshots s WHERE account_id=? AND source=?) SELECT * FROM latest WHERE ordinal=1
        AND (? IS NULL OR json_extract(content_json,'$.publishedAt') IS NULL OR (json_extract(content_json,'$.publishedAt')>=? AND json_extract(content_json,'$.publishedAt')<?))
        ORDER BY json_extract(content_json,'$.publishedAt') DESC,id LIMIT ?`,
        )
        .all(
          input.accountId,
          input.source,
          window?.from ?? null,
          window?.from ?? null,
          window?.to ?? null,
          this.owner.maxAnalyticsItems + 1,
        )
      const observations: ContentObservation[] = rows.slice(0, this.owner.maxAnalyticsItems).map((row) => {
        const content = analyticsStored(normalizedContentSchema, text(row, 'content_json')),
          fields = analyticsStored(metricFieldsSchema, text(row, 'fields_json'))
        if (JSON.stringify(content.fields) !== JSON.stringify(fields) || content.sourceDataAt !== row.source_data_at)
          throw new EducationError('storage-unavailable', 'stored content observation metadata disagrees')
        return {
          ...content,
          fields,
          id: id(row.content_id),
          snapshotId: id(row.id),
          accountId: input.accountId,
          source: text(row, 'source'),
          fetchedAt: timestamp(row.fetched_at),
        }
      })
      return {
        account,
        source: input.source,
        sources,
        overview,
        analysis: analyzeContent(observations, recentCount, window, input.keyword),
        coverage: overview?.coverage ?? 'unknown',
        truncated: rows.length > this.owner.maxAnalyticsItems,
      }
    })
  }

  previewImport(actor: ActorContext, input: PreviewMetricImportInput): MetricImportPreview {
    this.owner.transaction(actor, () => {
      this.accountInside(actor, input.accountId, 'sync', true)
    })
    if (!input.content.isWellFormed() || Buffer.byteLength(input.content) > this.owner.maxBodyBytes)
      throw new EducationError('validation-failed', 'metric import exceeds its configured byte limit')
    const observedAt = observationTime(input.observedAt)
    if (Date.parse(observedAt) > Date.now())
      throw new EducationError('validation-failed', 'metric observation time cannot be in the future')
    const source = 'import:' + this.label(input.sourceLabel),
      fileHash = digest(input.content),
      requestHash = digest(JSON.stringify(input))
    const parsed = this.parseImport(input.content, fileHash, observedAt)
    return this.owner.transaction(
      actor,
      () => {
        const account = this.accountInside(actor, input.accountId, 'sync', true)
        const prior = this.db
          .prepare('SELECT * FROM import_previews WHERE organization_id=? AND owner_id=? AND request_id=?')
          .get(actor.organizationId, actor.userId, input.requestId)
        if (prior !== undefined) {
          if (prior.request_hash !== requestHash)
            throw new EducationError('idempotency-conflict', 'import preview request changed')
          return this.previewDTO(prior)
        }
        const importId = newId<MetricImportId>()
        const preview = {
          ...parsed,
          baseline: this.baseline(input.accountId, source),
          grantRevision: integer(account.grant_revision),
        }
        this.db
          .prepare("INSERT INTO import_previews VALUES(?,?,?,?,?,?,?,?,?,?,?,'preview',?)")
          .run(
            importId,
            actor.organizationId,
            actor.userId,
            input.accountId,
            fileHash,
            input.requestId,
            requestHash,
            integer(account.revision),
            source,
            observedAt,
            JSON.stringify(preview),
            new Date().toISOString(),
          )
        const row = this.db.prepare('SELECT * FROM import_previews WHERE id=?').get(importId)
        if (row === undefined) throw new EducationError('storage-unavailable', 'import preview was not recorded')
        return this.previewDTO(row)
      },
      true,
    )
  }

  commitImport(actor: ActorContext, input: CommitMetricImportInput): AnalyticsWriteResult {
    return this.mutation(actor, 'imports.commit', input.requestId, input, () => {
      const preview = this.db
        .prepare('SELECT * FROM import_previews WHERE id=? AND organization_id=? AND owner_id=?')
        .get(input.importId, actor.organizationId, actor.userId)
      if (preview === undefined) throw unavailable()
      const accountId = id<ContentAccountId>(preview.account_id),
        account = this.accountInside(actor, accountId, 'sync', true)
      if (preview.file_hash !== input.expectedFileHash) throw conflict()
      const record = analyticsStored(previewStored, text(preview, 'preview_json')),
        valid = record.rows.length + Number(record.accountFields !== null)
      const duplicate = this.db
        .prepare(
          "SELECT id FROM import_previews WHERE account_id=? AND source=? AND file_hash=? AND observed_at=? AND status='committed' LIMIT 1",
        )
        .get(accountId, text(preview, 'source'), text(preview, 'file_hash'), text(preview, 'observed_at'))
      if (duplicate !== undefined || preview.status === 'committed') {
        this.db.prepare("UPDATE import_previews SET status='committed' WHERE id=?").run(input.importId)
        return {
          operation: 'imports.commit',
          accountId,
          importId: input.importId,
          accepted: 0,
          rejected: record.errors.length,
          skipped: valid + record.skipped,
        }
      }
      if (
        account.revision !== preview.baseline_revision ||
        account.grant_revision !== record.grantRevision ||
        this.baseline(accountId, text(preview, 'source')) !== record.baseline
      )
        throw conflict()
      if ((!input.allowPartial && record.errors.length !== 0) || valid === 0)
        throw new EducationError(
          'validation-failed',
          'confirm valid-only import explicitly or provide a valid new preview',
        )
      const fetchedAt = new Date().toISOString(),
        source = text(preview, 'source')
      if (record.accountFields !== null)
        this.db
          .prepare('INSERT INTO account_snapshots VALUES(?,?,?,?,?,?,?,NULL,?)')
          .run(
            newId(),
            accountId,
            source,
            JSON.stringify(record.accountFields),
            text(preview, 'observed_at'),
            fetchedAt,
            input.importId,
            JSON.stringify({ coverage: 'partial', mappingVersion: 'education-metrics-v1', origin: 'import' }),
          )
      for (const content of record.rows)
        this.saveContentInside(accountId, source, content, fetchedAt, input.importId, null)
      this.db.prepare("UPDATE import_previews SET status='committed' WHERE id=?").run(input.importId)
      return {
        operation: 'imports.commit',
        accountId,
        importId: input.importId,
        accepted: valid,
        rejected: record.errors.length,
        skipped: record.skipped,
      }
    })
  }

  mutationResult(
    actor: ActorContext,
    operation: AnalyticsWriteResult['operation'],
    requestId: RequestId,
  ): AnalyticsWriteResult | null {
    return this.owner.transaction(actor, () => {
      const row = this.db
        .prepare(
          'SELECT result_json FROM stage_receipts WHERE organization_id=? AND owner_id=? AND operation=? AND request_id=?',
        )
        .get(actor.organizationId, actor.userId, operation, requestId)
      if (row === undefined) return null
      const ack = analyticsAck(text(row, 'result_json'))
      this.accountInside(
        actor,
        ack.accountId,
        operation === 'imports.commit' ? 'sync' : operation === 'accounts.create' ? null : 'manage',
      )
      return ack
    })
  }

  /**
   * Commit one immutable content observation inside the caller's authenticated page transaction.
   * @param accountId - validated account.
   * @param source - explicit API or import dataset.
   * @param content - normalized bounded supplier/import item.
   * @param fetchedAt - actual local completion time.
   * @param importId - confirmed import batch, or null.
   * @param callId - validated provider call, or null.
   * @returns the immutable new observation identifier.
   */
  saveContentInside(
    accountId: ContentAccountId,
    source: string,
    content: NormalizedContent,
    fetchedAt: string,
    importId: string | null,
    callId: string | null,
  ): string {
    const existing = this.db
      .prepare('SELECT id FROM external_contents WHERE account_id=? AND external_id=?')
      .get(accountId, content.externalId)
    const contentId = existing === undefined ? newId() : id(existing.id)
    if (existing === undefined)
      this.db
        .prepare('INSERT INTO external_contents VALUES(?,?,?,?,?,?,?,?)')
        .run(
          contentId,
          accountId,
          content.externalId,
          content.kind,
          content.title,
          content.url,
          content.publishedAt,
          content.pinned === null ? null : Number(content.pinned),
        )
    const snapshotId = newId()
    this.db
      .prepare('INSERT INTO content_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        snapshotId,
        accountId,
        contentId,
        source,
        JSON.stringify(content.fields),
        content.sourceDataAt,
        fetchedAt,
        importId,
        callId,
        JSON.stringify(content),
      )
    return snapshotId
  }

  private mutation(
    actor: ActorContext,
    operation: AnalyticsWriteResult['operation'],
    requestId: RequestId,
    parameters: object,
    perform: () => AnalyticsWriteResult,
  ): AnalyticsWriteResult {
    const observation = { changed: false }
    const ack = this.owner.transaction(
      actor,
      () => {
        const requestHash = digest(JSON.stringify(parameters)),
          prior = this.db
            .prepare(
              'SELECT * FROM stage_receipts WHERE organization_id=? AND owner_id=? AND operation=? AND request_id=?',
            )
            .get(actor.organizationId, actor.userId, operation, requestId)
        if (prior !== undefined) {
          if (prior.request_hash !== requestHash)
            throw new EducationError(
              'idempotency-conflict',
              'analytics request identity was reused with different parameters',
            )
          const result = analyticsAck(text(prior, 'result_json'))
          this.accountInside(
            actor,
            result.accountId,
            operation === 'imports.commit' ? 'sync' : operation === 'accounts.create' ? null : 'manage',
          )
          return result
        }
        const result = perform()
        this.db
          .prepare('INSERT INTO stage_receipts VALUES(?,?,?,?,?,?)')
          .run(actor.organizationId, actor.userId, operation, requestId, requestHash, JSON.stringify(result))
        observation.changed = true
        return result
      },
      true,
    )
    if (observation.changed)
      for (const listener of [...this.observers]) {
        try {
          listener(ack.accountId)
        } catch (error) {
          console.warn(
            'Account change committed; an observer failed. Refresh current account state.',
            error instanceof Error ? error.name : 'unknown',
          )
        }
      }
    return ack
  }

  private parseImport(
    raw: string,
    fileHash: string,
    observedAt: string,
  ): {
    rows: NormalizedContent[]
    accountFields: MetricFields | null
    errors: { row: number; code: string }[]
    skipped: number
  } {
    let value: unknown
    try {
      value = JSON.parse(raw.replace(/^\uFEFF/, ''))
    } catch (error) {
      throw new EducationError('validation-failed', 'metric import must be canonical education-metrics JSON', {
        cause: error,
      })
    }
    const root = z
      .strictObject({
        kind: z.literal('education-metrics'),
        version: z.literal(1),
        overview: z.unknown().optional(),
        contents: z.array(z.unknown()).max(this.owner.maxImportRows),
      })
      .safeParse(value)
    if (!root.success)
      throw new EducationError('validation-failed', 'metric import format or row bound is invalid', {
        cause: root.error,
      })
    const rowSchema = z.strictObject({
      externalId: z.string().min(1).optional(),
      kind: z.enum(['video', 'image', 'article', 'unknown']),
      title: z.string().refine(title => title.isWellFormed() && Buffer.byteLength(title) <= this.owner.maxTitleBytes),
      url: z.string().optional(),
      publishedAt: z.string().nullable().optional(),
      sourceDataAt: z.string().nullable().optional(),
      pinned: z.boolean().nullable().optional(),
      ...scalarMetrics,
    })
    const rows: NormalizedContent[] = [],
      errors: { row: number; code: string }[] = [],
      ids = new Map<string, string>()
    let skipped = 0,
      accountFields: MetricFields | null = null
    if (root.data.overview !== undefined) {
      const account = overviewInput.safeParse(root.data.overview)
      if (!account.success) errors.push({ row: 0, code: 'account-fields-invalid' })
      else
        accountFields = {
          ...missingMetrics(),
          followers: measuredCount(account.data.followers, 'followers'),
          totalLikes: measuredCount(account.data.totalLikes, 'totalLikes'),
          workCount: measuredCount(account.data.workCount, 'workCount'),
        }
    }
    for (const [index, rawRow] of root.data.contents.entries()) {
      const parsed = rowSchema.safeParse(rawRow)
      if (!parsed.success) {
        errors.push({ row: index + 1, code: 'fields-invalid' })
        continue
      }
      try {
        const row = parsed.data,
          externalId = row.externalId ?? `import:${fileHash}:${index + 1}`
        if (row.externalId?.startsWith('import:') || Buffer.byteLength(externalId) > this.owner.maxTitleBytes)
          throw new Error('reserved or oversized identifier')
        const url = row.url ?? ''
        if (url !== '') {
          const parsedUrl = new URL(url)
          if (
            !['http:', 'https:'].includes(parsedUrl.protocol) ||
            parsedUrl.username ||
            parsedUrl.password ||
            Buffer.byteLength(url) > this.owner.maxExternalUrlBytes
          )
            throw new Error('invalid display URL')
        }
        const fields = {
          likes: measuredCount(row.likes, 'likes'),
          collects: measuredCount(row.collects, 'collects'),
          comments: measuredCount(row.comments, 'comments'),
          shares: measuredCount(row.shares, 'shares'),
          views: measuredCount(row.views, 'views'),
          followers: measuredCount(row.followers, 'followers'),
          totalLikes: measuredCount(row.totalLikes, 'totalLikes'),
          workCount: measuredCount(row.workCount, 'workCount'),
        }
        const content: NormalizedContent = {
          externalId,
          kind: row.kind,
          title: row.title,
          url,
          publishedAt:
            row.publishedAt === undefined || row.publishedAt === null ? null : observationTime(row.publishedAt),
          pinned: row.pinned ?? null,
          fields,
          sourceDataAt:
            row.sourceDataAt === null
              ? null
              : row.sourceDataAt === undefined
                ? observedAt
                : observationTime(row.sourceDataAt),
        }
        if (
          (content.publishedAt !== null && Date.parse(content.publishedAt) > Date.now()) ||
          (content.sourceDataAt !== null && Date.parse(content.sourceDataAt) > Date.now())
        )
          throw new Error('future source time')
        const fingerprint = digest(JSON.stringify(content)),
          previous = ids.get(externalId)
        if (previous !== undefined) {
          if (previous === fingerprint) skipped++
          else errors.push({ row: index + 1, code: 'duplicate-id-conflict' })
          continue
        }
        ids.set(externalId, fingerprint)
        rows.push(content)
      } catch (error) {
        // One invalid imported row remains rejected; no metric data is committed by this preview.
        if (!(error instanceof Error)) throw error
        errors.push({ row: index + 1, code: 'identity-url-or-time-invalid' })
      }
    }
    return { rows, accountFields, errors, skipped }
  }

  private previewDTO(row: Row): MetricImportPreview {
    const record = analyticsStored(previewStored, text(row, 'preview_json'))
    if (row.status !== 'preview' && row.status !== 'committed')
      throw new EducationError('storage-unavailable', 'stored import status is invalid')
    return {
      id: id(row.id),
      accountId: id(row.account_id),
      source: text(row, 'source'),
      observedAt: timestamp(row.observed_at),
      fileHash: text(row, 'file_hash'),
      validRows: record.rows.length + Number(record.accountFields !== null),
      rejectedRows: record.errors.length,
      skippedRows: record.skipped,
      sample: record.rows.slice(0, this.owner.maxPageSize),
      errors: record.errors.slice(0, this.owner.maxPageSize),
      accountFields: record.accountFields,
      truncated: record.rows.length > this.owner.maxPageSize || record.errors.length > this.owner.maxPageSize,
      status: row.status,
    }
  }
  private baseline(accountId: ContentAccountId, source: string): string {
    const rows = this.db
      .prepare(
        'SELECT id FROM account_snapshots WHERE account_id=? AND source=? UNION ALL SELECT id FROM content_snapshots WHERE account_id=? AND source=? ORDER BY id',
      )
      .all(accountId, source, accountId, source)
    return digest(JSON.stringify(rows))
  }
  private invalidateSchedulesInside(accountId: ContentAccountId, ownerId?: string): void {
    const where = `account_id=? AND enabled=1${ownerId === undefined ? '' : ' AND owner_id=?'}`
    const values = ownerId === undefined ? [accountId] : [accountId, ownerId]
    if (this.db.prepare(`SELECT id FROM analytics_schedules WHERE ${where} AND revision>=? LIMIT 1`).get(...values, Number.MAX_SAFE_INTEGER) !== undefined)
      throw new EducationError('validation-failed', 'daily authorization revision cannot advance safely')
    this.db.prepare(`UPDATE analytics_schedules SET enabled=0,revision=revision+1 WHERE ${where}`).run(...values)
  }
  private label(value: string): string {
    const clean = value.trim()
    if (clean === '' || !clean.isWellFormed() || Buffer.byteLength(clean) > this.owner.maxTitleBytes)
      throw new EducationError('validation-failed', 'analytics label exceeds its configured bounds')
    return clean
  }
}
