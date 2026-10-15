/** Durable synchronization admission, shared reservations, committed checkpoints and business-authorized daily plans. */
import type { DatabaseSync } from 'node:sqlite'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import {
  EducationError,
  analyticsDay,
  analyticsLocalDate,
  nextAnalyticsDaily,
} from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  ActorContext,
  AnalyticsSchedule,
  AnalyticsScheduleId,
  AnalyticsWriteResult,
  ContentAccountId,
  DataProviderRequest,
  ProviderDelivery,
  NormalizedProviderResult,
  ProviderCallId,
  ProviderCallReservation,
  QuotaLimits,
  RequestId,
  RequestSyncInput,
  SaveAnalyticsScheduleInput,
  SyncAuthority,
  SyncCheckpoint,
  SyncParameters,
  SyncRepository,
  SyncRun,
  SyncRunId,
  SyncWork,
} from '@deepseek-ai/dsh-experimental-education-platform'
import { digest, id, integer, newId, text, timestamp, type Row } from './codec.ts'
import { accountPermissions, analyticsAck, analyticsStored, contentAccount } from './analytics-codec.ts'
import {
  checkedSyncParameters,
  providerResultSchema,
  quotaLimitsSchema,
  syncAuthoritySchema,
  syncCheckpointSchema,
  syncParametersSchema,
} from './sync-codec.ts'
import type { SqliteAnalyticsRepository } from './analytics.ts'

interface Owner {
  transaction<T>(actor: ActorContext, work: () => T, write?: boolean): T
  system<T>(work: () => T): T
  assertActor(actor: ActorContext): void
  readonly maxPageSize: number
}
const unavailable = () => new EducationError('resource-unavailable', 'sync resource is unavailable')
const now = () => new Date().toISOString()
const initialCheckpoint = (): SyncCheckpoint => ({
  phase: 'account',
  nextOffset: 0,
  pages: 0,
  contents: 0,
  coverage: 'unknown',
  detailIds: [],
  detailIndex: 0,
  seenOffsets: [],
  accountAliases: [],
  retry: 0,
})
const runStatus = z.enum([
  'pending',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
])
const callStatus = z.enum(['reserved', 'sent', 'confirmed', 'unknown', 'cancelled'])

/** Runtime-only execution methods never become employee Remote operations. */
export class SqliteSyncRepository implements SyncRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: Owner,
    private readonly analytics: SqliteAnalyticsRepository,
  ) {}

  configureQuota(input: QuotaLimits): void {
    const limits = quotaLimitsSchema.parse(input)
    this.owner.system(() => {
      const previous = this.db.prepare('SELECT resume_epoch FROM quota_pools WHERE id=?').get(limits.poolId)
      if (previous === undefined)
        this.db
          .prepare('INSERT INTO quota_pools VALUES(?,?,?,?,NULL,?)')
          .run(limits.poolId, digest(JSON.stringify(limits)), JSON.stringify(limits), now(), limits.resumeEpoch)
      else
        this.db
          .prepare(
            'UPDATE quota_pools SET configuration_hash=?,limits_json=?,paused_reason=CASE WHEN resume_epoch<>? THEN NULL ELSE paused_reason END,resume_epoch=? WHERE id=?',
          )
          .run(
            digest(JSON.stringify(limits)),
            JSON.stringify(limits),
            limits.resumeEpoch,
            limits.resumeEpoch,
            limits.poolId,
          )
    })
  }

  request(actor: ActorContext, input: RequestSyncInput, rawParameters: SyncParameters): SyncRun {
    const parameters = checkedSyncParameters(rawParameters)
    return this.owner.transaction(
      actor,
      () => {
        const account = this.analytics.accountInside(actor, input.accountId, 'sync', true),
          hash = digest(JSON.stringify(input))
        const previous = this.db
          .prepare('SELECT * FROM sync_requests WHERE organization_id=? AND owner_id=? AND request_id=?')
          .get(actor.organizationId, actor.userId, input.requestId)
        if (previous !== undefined) {
          if (previous.request_hash !== hash)
            throw new EducationError('idempotency-conflict', 'sync request was used with different parameters')
          return this.runDTO(this.row(id(previous.run_id)))
        }
        if (parameters.mode !== input.mode)
          throw new EducationError('validation-failed', 'resolved sync mode differs from the request')
        this.pool(parameters.poolId)
        const authority: SyncAuthority = {
          kind: 'login',
          actor,
          accountId: input.accountId,
          grantRevision: integer(account.grant_revision),
          accountRevision: integer(account.revision),
        }
        const fingerprint = digest(JSON.stringify(parameters))
        const compatible = this.db
          .prepare(
            "SELECT * FROM sync_runs WHERE account_id=? AND fingerprint=? AND status IN('pending','running','unknown')",
          )
          .get(input.accountId, fingerprint)
        let runId: SyncRunId
        if (compatible !== undefined) {
          const existingId = id<SyncRunId>(compatible.id)
          if (compatible.status === 'unknown') runId = existingId
          else {
            try {
              this.authorityAccount(analyticsStored(syncAuthoritySchema, text(compatible, 'principal_json')))
              runId = existingId
            } catch (error) {
              if (
                !(error instanceof EducationError) ||
                (error.code !== 'forbidden' &&
                  error.code !== 'unauthenticated' &&
                  error.code !== 'resource-unavailable')
              )
                throw error
              const uncertain =
                this.db
                  .prepare("SELECT id FROM provider_calls WHERE run_id=? AND status IN('sent','unknown') LIMIT 1")
                  .get(existingId) !== undefined
              this.db
                .prepare("UPDATE sync_runs SET status=?,error_code='authorization-changed',updated_at=? WHERE id=?")
                .run(uncertain ? 'unknown' : 'cancelled', now(), existingId)
              runId = uncertain ? existingId : this.insertRun(authority, input.requestId, hash, parameters, fingerprint)
            }
          }
        } else runId = this.insertRun(authority, input.requestId, hash, parameters, fingerprint)
        this.db
          .prepare('INSERT INTO sync_requests VALUES(?,?,?,?,?)')
          .run(actor.organizationId, actor.userId, input.requestId, hash, runId)
        return this.runDTO(this.row(runId))
      },
      true,
    )
  }

  find(actor: ActorContext, requestId: RequestId): SyncRun | null {
    return this.owner.transaction(actor, () => {
      const found = this.db
        .prepare('SELECT run_id FROM sync_requests WHERE organization_id=? AND owner_id=? AND request_id=?')
        .get(actor.organizationId, actor.userId, requestId)
      if (found === undefined) return null
      const row = this.row(id(found.run_id))
      this.readAccount(actor, id(row.account_id))
      return this.runDTO(row)
    })
  }
  get(actor: ActorContext, runId: SyncRunId): SyncRun {
    return this.owner.transaction(actor, () => {
      const row = this.row(runId)
      this.readAccount(actor, id(row.account_id))
      return this.runDTO(row)
    })
  }
  list(actor: ActorContext, accountId: ContentAccountId): readonly SyncRun[] {
    return this.owner.transaction(actor, () => {
      this.readAccount(actor, accountId)
      return this.db
        .prepare('SELECT * FROM sync_runs WHERE account_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?')
        .all(accountId, this.owner.maxPageSize)
        .map(row => this.runDTO(row))
    })
  }
  cancel(actor: ActorContext, runId: SyncRunId): SyncRun {
    return this.owner.transaction(
      actor,
      () => {
        const row = this.row(runId),
          account = this.analytics.accountInside(actor, id(row.account_id), null)
        if (row.owner_id !== actor.userId && !accountPermissions(account).manage) throw unavailable()
        if (!['pending', 'running', 'interrupted', 'unknown'].includes(text(row, 'status'))) return this.runDTO(row)
        this.db
          .prepare(
            "UPDATE provider_calls SET status=CASE WHEN status='reserved' THEN 'cancelled' ELSE 'unknown' END,error_code='cancelled',finished_at=? WHERE run_id=? AND status IN('reserved','sent')",
          )
          .run(now(), runId)
        const uncertain =
          this.db.prepare("SELECT id FROM provider_calls WHERE run_id=? AND status='unknown' LIMIT 1").get(runId) !==
          undefined
        this.db
          .prepare('UPDATE sync_runs SET status=?,error_code=?,updated_at=? WHERE id=?')
          .run(uncertain ? 'unknown' : 'cancelled', uncertain ? 'cancelled-result-unknown' : 'cancelled', now(), runId)
        return this.runDTO(this.row(runId))
      },
      true,
    )
  }
  allowUnknownRetry(actor: ActorContext, runId: SyncRunId): SyncRun {
    return this.owner.transaction(
      actor,
      () => {
        const row = this.row(runId)
        this.analytics.accountInside(actor, id(row.account_id), 'manage')
        if (row.status === 'failed' && row.error_code === 'unknown-retry-authorized') return this.runDTO(row)
        if (row.status !== 'unknown')
          throw new EducationError('version-conflict', 'only an explicitly reviewed unknown run can be released')
        this.db
          .prepare("UPDATE sync_runs SET status='failed',error_code='unknown-retry-authorized',updated_at=? WHERE id=?")
          .run(now(), runId)
        return this.runDTO(this.row(runId))
      },
      true,
    )
  }

  claim(runId: SyncRunId): SyncWork | null {
    return this.owner.system(() => {
      const row = this.row(runId)
      if (row.status !== 'pending' && row.status !== 'interrupted') return null
      this.workInside(row)
      if (
        this.db
          .prepare("SELECT id FROM provider_calls WHERE run_id=? AND status IN('sent','unknown') LIMIT 1")
          .get(runId) !== undefined
      )
        throw new EducationError('result-unknown', 'external call must be reconciled before resuming')
      const changed = this.db
        .prepare(
          "UPDATE sync_runs SET status='running',error_code=NULL,updated_at=? WHERE id=? AND status IN('pending','interrupted')",
        )
        .run(now(), runId)
      return changed.changes === 1 ? this.workInside(this.row(runId)) : null
    })
  }
  work(runId: SyncRunId): SyncWork {
    return this.owner.system(() => this.workInside(this.row(runId)))
  }
  attachNative(runId: SyncRunId, jobId: string, sessionId: SessionId): void {
    this.owner.system(() => {
      const row = this.row(runId)
      this.requireRunning(row)
      this.db
        .prepare('UPDATE sync_runs SET job_id=?,session_id=?,updated_at=? WHERE id=?')
        .run(jobId, sessionId, now(), runId)
    })
  }

  reserveCall(runId: SyncRunId, input: DataProviderRequest, retry: number): ProviderCallReservation {
    return this.owner.system(() => {
      const work = this.requireRunning(this.row(runId)),
        pool = this.pool(work.parameters.poolId),
        hash = digest(JSON.stringify({ input, retry, mappingVersion: work.parameters.mappingVersion }))
      if (
        input.platform !== work.account.platform ||
        (input.operation !== 'content' &&
          input.accountId !== work.account.externalId &&
          !work.checkpoint.accountAliases.includes(input.accountId))
      )
        throw new EducationError('validation-failed', 'provider request does not belong to the captured account')
      if (!Number.isSafeInteger(retry) || retry < 0 || retry > work.parameters.maxRetries)
        throw new EducationError('quota-exceeded', 'configured response retry limit reached')
      const prior = this.db.prepare('SELECT * FROM provider_calls WHERE run_id=? AND request_hash=?').get(runId, hash)
      if (prior !== undefined && prior.status !== 'cancelled') return this.callDTO(prior)
      const at = now(),
        day = analyticsDay(Date.parse(at), pool.timeZone)
      const total = this.usage('pool_id=?', [pool.poolId]),
        daily = this.usage('pool_id=? AND reserved_at>=? AND reserved_at<?', [pool.poolId, day.from, day.to])
      const account = this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM provider_calls c JOIN sync_runs r ON r.id=c.run_id WHERE c.pool_id=? AND r.account_id=? AND c.status<>\'cancelled\' AND c.reserved_at>=? AND c.reserved_at<?',
        )
        .get(pool.poolId, work.account.id, day.from, day.to)
      const run = this.usage('run_id=?', [runId])
      const price =
        input.operation === 'account'
          ? pool.accountCostMicros
          : input.operation === 'works'
            ? pool.worksCostMicros
            : pool.contentCostMicros
      if (
        total.n >= pool.maxCalls ||
        daily.n >= pool.maxCallsPerDay ||
        integer(account?.n) >= pool.maxCallsPerAccount ||
        run.n >= work.parameters.maxCalls ||
        (pool.maxCostMicros !== null && (price === null || total.unpriced > 0 || total.cost + price > pool.maxCostMicros))
      )
        throw new EducationError(
          'quota-exceeded',
          'configured pool, account or run budget is exhausted or pricing is unknown',
        )
      const callId = prior === undefined ? newId<ProviderCallId>() : id<ProviderCallId>(prior.id)
      this.db
        .prepare(
          `INSERT INTO provider_calls(id,run_id,pool_id,request_hash,operation,reserved_cost_micros,actual_cost_micros,status,provider_request_id,response_hash,error_code,reserved_at,dispatched_at,finished_at,result_json)
        VALUES(?,?,?,?,?,?,NULL,'reserved',NULL,NULL,NULL,?,NULL,NULL,NULL) ON CONFLICT(id) DO UPDATE SET status='reserved',reserved_cost_micros=excluded.reserved_cost_micros,reserved_at=excluded.reserved_at,error_code=NULL,finished_at=NULL`,
        )
        .run(callId, runId, pool.poolId, hash, input.operation, price, at)
      return { id: callId, status: 'reserved', reservedCostMicros: price }
    })
  }
  markSent(runId: SyncRunId, callId: ProviderCallId): void {
    this.owner.system(() => {
      this.requireRunning(this.row(runId))
      const changed = this.db
        .prepare(
          "UPDATE provider_calls SET status='sent',dispatched_at=? WHERE id=? AND run_id=? AND status='reserved'",
        )
        .run(now(), callId, runId)
      if (changed.changes !== 1)
        throw new EducationError('result-unknown', 'request is already sent or settled; do not repeat it')
    })
  }
  commitCall(
    runId: SyncRunId,
    callId: ProviderCallId,
    rawResult: NormalizedProviderResult,
    rawCheckpoint: SyncCheckpoint,
    providerRequestId: string | null,
    responseHash: string,
  ): void {
    const result = providerResultSchema.parse(rawResult),
      checkpoint = syncCheckpointSchema.parse(rawCheckpoint)
    this.owner.system(() => {
      const work = this.requireRunning(this.row(runId)),
        call = this.db.prepare('SELECT status FROM provider_calls WHERE id=? AND run_id=?').get(callId, runId)
      if (call?.status !== 'sent')
        throw new EducationError('result-unknown', 'provider result does not match a live sent request')
      const at = now()
      if (result.kind === 'account')
        this.db
          .prepare('INSERT INTO account_snapshots VALUES(?,?,?,?,?,?,NULL,?,?)')
          .run(
            newId(),
            work.account.id,
            'redfox',
            JSON.stringify(result.fields),
            result.sourceDataAt,
            at,
            callId,
            JSON.stringify({
              coverage: 'unknown',
              mappingVersion: work.parameters.mappingVersion,
              observedFields: result.observedFields,
              accountAliases: result.aliases,
              origin: 'api',
            }),
          )
      else
        for (const content of result.kind === 'works' ? result.items : [result.item])
          this.analytics.saveContentInside(work.account.id, 'redfox', content, at, null, callId)
      this.db
        .prepare(
          "UPDATE provider_calls SET status='confirmed',provider_request_id=?,response_hash=?,result_json=?,finished_at=? WHERE id=?",
        )
        .run(providerRequestId, responseHash, JSON.stringify(result), at, callId)
      this.db
        .prepare('UPDATE sync_runs SET checkpoint_json=?,phase=?,updated_at=? WHERE id=?')
        .run(JSON.stringify(checkpoint), checkpoint.phase, at, runId)
    })
  }
  failCall(
    runId: SyncRunId,
    callId: ProviderCallId,
    code: string,
    delivery: ProviderDelivery,
    checkpoint?: SyncCheckpoint,
  ): void {
    this.owner.system(() => {
      const row = this.db.prepare('SELECT * FROM provider_calls WHERE id=? AND run_id=?').get(callId, runId)
      if (row === undefined) throw unavailable()
      if (row.status === 'confirmed' || row.status === 'cancelled') return
      const status = delivery === 'not-dispatched' ? 'cancelled' : delivery === 'unknown' ? 'unknown' : 'confirmed'
      this.db
        .prepare('UPDATE provider_calls SET status=?,error_code=?,finished_at=? WHERE id=?')
        .run(status, code, now(), callId)
      if (code === 'authentication' || code === 'quota')
        this.db.prepare('UPDATE quota_pools SET paused_reason=? WHERE id=?').run(code, text(row, 'pool_id'))
      if (checkpoint !== undefined)
        this.db
          .prepare('UPDATE sync_runs SET checkpoint_json=?,phase=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(syncCheckpointSchema.parse(checkpoint)), checkpoint.phase, now(), runId)
    })
  }
  finish(runId: SyncRunId, status: SyncRun['status'], errorCode: string | null): void {
    this.owner.system(() => {
      const row = this.row(runId)
      if (!['pending', 'running', 'interrupted', 'unknown'].includes(text(row, 'status'))) return
      const checkpoint = analyticsStored(syncCheckpointSchema, text(row, 'checkpoint_json'))
      const unknown =
        this.db
          .prepare("SELECT id FROM provider_calls WHERE run_id=? AND status IN('sent','unknown') LIMIT 1")
          .get(runId) !== undefined
      if (status === 'completed' && (checkpoint.phase !== 'done' || unknown))
        throw new EducationError(
          'result-unknown',
          'a registered job or unconfirmed page is not a completed synchronization',
        )
      this.db
        .prepare('UPDATE sync_runs SET status=?,error_code=?,updated_at=? WHERE id=?')
        .run(unknown ? 'unknown' : status, unknown ? 'result-unknown' : errorCode, now(), runId)
    })
  }
  interruptPending(): void {
    this.owner.system(() => {
      this.db
        .prepare(
          "UPDATE provider_calls SET status=CASE WHEN status='reserved' THEN 'cancelled' ELSE 'unknown' END,error_code='process-interrupted',finished_at=? WHERE status IN('reserved','sent')",
        )
        .run(now())
      this.db
        .prepare(
          `UPDATE sync_runs SET status=CASE WHEN EXISTS(SELECT 1 FROM provider_calls c WHERE c.run_id=sync_runs.id AND c.status='unknown') THEN 'unknown' ELSE 'interrupted' END,
        error_code='process-interrupted',job_id=NULL,session_id=NULL,updated_at=? WHERE status IN('pending','running')`,
        )
        .run(now())
    })
  }
  recoverable(): readonly SyncRunId[] {
    return this.owner.system(() =>
      this.db
        .prepare("SELECT id FROM sync_runs WHERE status IN('pending','interrupted') ORDER BY created_at,id LIMIT ?")
        .all(this.owner.maxPageSize)
        .map(row => id<SyncRunId>(row.id)),
    )
  }

  saveSchedule(actor: ActorContext, input: SaveAnalyticsScheduleInput): AnalyticsWriteResult {
    return this.owner.transaction(
      actor,
      () => {
        const account = this.analytics.accountInside(actor, input.accountId, 'manage', input.enabled),
          permissions = accountPermissions(account)
        if (input.enabled && !permissions.sync) throw unavailable()
        if (
          !Number.isSafeInteger(input.hour) ||
          input.hour < 0 ||
          input.hour > 23 ||
          !Number.isSafeInteger(input.minute) ||
          input.minute < 0 ||
          input.minute > 59
        )
          throw new EducationError('validation-failed', 'daily schedule time is invalid')
        const nextAt = nextAnalyticsDaily(Date.now(), input.timeZone, input.hour, input.minute),
          hash = digest(JSON.stringify(input))
        const prior = this.db
          .prepare(
            "SELECT * FROM stage_receipts WHERE organization_id=? AND owner_id=? AND operation='schedules.save' AND request_id=?",
          )
          .get(actor.organizationId, actor.userId, input.requestId)
        if (prior !== undefined) {
          if (prior.request_hash !== hash)
            throw new EducationError('idempotency-conflict', 'daily schedule request changed')
          return analyticsAck(text(prior, 'result_json'))
        }
        const previous = this.db.prepare('SELECT * FROM analytics_schedules WHERE account_id=?').get(input.accountId)
        if ((previous === undefined ? 0 : integer(previous.revision)) !== input.expectedRevision)
          throw new EducationError('version-conflict', 'daily plan changed; refresh before saving')
        const scheduleId = previous === undefined ? newId<AnalyticsScheduleId>() : id<AnalyticsScheduleId>(previous.id),
          revision = integer(input.expectedRevision + 1)
        this.db
          .prepare(
            `INSERT INTO analytics_schedules(id,organization_id,account_id,owner_id,authority_revision,account_revision,user_auth_revision,enabled,hour,minute,time_zone,next_at,last_local_date,revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(account_id) DO UPDATE SET owner_id=excluded.owner_id,authority_revision=excluded.authority_revision,
        account_revision=excluded.account_revision,user_auth_revision=excluded.user_auth_revision,enabled=excluded.enabled,hour=excluded.hour,minute=excluded.minute,time_zone=excluded.time_zone,next_at=excluded.next_at,revision=excluded.revision`,
          )
          .run(
            scheduleId,
            actor.organizationId,
            input.accountId,
            actor.userId,
            integer(account.grant_revision),
            integer(account.revision),
            actor.authRevision,
            Number(input.enabled),
            input.hour,
            input.minute,
            input.timeZone,
            nextAt,
            revision,
          )
        const result: AnalyticsWriteResult = {
          operation: 'schedules.save',
          accountId: input.accountId,
          scheduleId,
          revision,
        }
        this.db
          .prepare("INSERT INTO stage_receipts VALUES(?,?,'schedules.save',?,?,?)")
          .run(actor.organizationId, actor.userId, input.requestId, hash, JSON.stringify(result))
        return result
      },
      true,
    )
  }
  readSchedule(actor: ActorContext, accountId: ContentAccountId): AnalyticsSchedule | null {
    return this.owner.transaction(actor, () => {
      this.readAccount(actor, accountId)
      const row = this.db.prepare('SELECT * FROM analytics_schedules WHERE account_id=?').get(accountId)
      return row === undefined ? null : this.scheduleDTO(row)
    })
  }
  dueSchedules(at: string): readonly AnalyticsScheduleId[] {
    return this.owner.system(() =>
      this.db
        .prepare('SELECT id FROM analytics_schedules WHERE enabled=1 AND next_at<=? ORDER BY next_at,id LIMIT ?')
        .all(at, this.owner.maxPageSize)
        .map(row => id<AnalyticsScheduleId>(row.id)),
    )
  }
  schedulePlatform(scheduleId: AnalyticsScheduleId) {
    return this.owner.system(() => {
      const row = this.db
        .prepare(
          'SELECT a.platform FROM analytics_schedules s JOIN content_accounts a ON a.id=s.account_id WHERE s.id=?',
        )
        .get(scheduleId)
      if (row === undefined) throw unavailable()
      return z.enum(['douyin', 'xiaohongshu']).parse(row.platform)
    })
  }
  claimSchedule(scheduleId: AnalyticsScheduleId, at: string, rawParameters: SyncParameters): SyncRunId | null {
    const parameters = checkedSyncParameters(rawParameters)
    if (parameters.mode !== 'latest')
      throw new EducationError('validation-failed', 'daily synchronization must retain the configured recent-N scope')
    return this.owner.system(() => {
      const schedule = this.db
        .prepare('SELECT * FROM analytics_schedules WHERE id=? AND enabled=1 AND next_at<=?')
        .get(scheduleId, at)
      if (schedule === undefined) return null
      const authority: SyncAuthority = {
        kind: 'schedule',
        organizationId: id(schedule.organization_id),
        userId: id(schedule.owner_id),
        userAuthRevision: integer(schedule.user_auth_revision),
        accountId: id(schedule.account_id),
        grantRevision: integer(schedule.authority_revision),
        accountRevision: integer(schedule.account_revision),
        scheduleId,
      }
      try {
        this.authorityAccount(authority)
      } catch (error) {
        if (
          !(error instanceof EducationError) ||
          !['forbidden', 'unauthenticated', 'resource-unavailable'].includes(error.code)
        )
          throw error
        this.db.prepare('UPDATE analytics_schedules SET enabled=0,revision=revision+1 WHERE id=?').run(scheduleId)
        return null
      }
      this.pool(parameters.poolId)
      // A foreground owner cannot substitute for durable offline authority. Wait for an active run rather than charge twice.
      if (
        this.db
          .prepare(
            "SELECT id FROM sync_runs WHERE account_id=? AND fingerprint=? AND status IN('pending','running','unknown')",
          )
          .get(authority.accountId, digest(JSON.stringify(parameters))) !== undefined
      )
        return null
      const localDate = analyticsLocalDate(Date.parse(at), text(schedule, 'time_zone')),
        nextAt = nextAnalyticsDaily(
          Date.parse(at),
          text(schedule, 'time_zone'),
          integer(schedule.hour),
          integer(schedule.minute),
        )
      if (schedule.last_local_date === localDate) {
        this.db.prepare('UPDATE analytics_schedules SET next_at=? WHERE id=?').run(nextAt, scheduleId)
        return null
      }
      const keyHash = digest(`education-daily:${scheduleId}:${localDate}`)
      const key = id<RequestId>(
        `${keyHash.slice(0, 8)}-${keyHash.slice(8, 12)}-8${keyHash.slice(13, 16)}-${((parseInt(keyHash.slice(16, 17), 16) & 3) | 8).toString(16)}${keyHash.slice(17, 20)}-${keyHash.slice(20, 32)}`,
      )
      const requestHash = digest(
        JSON.stringify({ accountId: authority.accountId, mode: 'latest', localDate, scheduleId }),
      )
      const existing = this.db
        .prepare('SELECT run_id FROM sync_requests WHERE organization_id=? AND owner_id=? AND request_id=?')
        .get(authority.organizationId, authority.userId, key)
      const runId =
        existing === undefined
          ? this.insertRun(authority, key, requestHash, parameters, digest(JSON.stringify(parameters)))
          : id<SyncRunId>(existing.run_id)
      if (existing === undefined)
        this.db
          .prepare('INSERT INTO sync_requests VALUES(?,?,?,?,?)')
          .run(authority.organizationId, authority.userId, key, requestHash, runId)
      this.db
        .prepare('UPDATE analytics_schedules SET next_at=?,last_local_date=? WHERE id=?')
        .run(nextAt, localDate, scheduleId)
      return runId
    })
  }

  private insertRun(
    authority: SyncAuthority,
    requestId: RequestId,
    requestHash: string,
    parameters: SyncParameters,
    fingerprint: string,
  ): SyncRunId {
    const scope = authority.kind === 'login' ? authority.actor : authority,
      runId = newId<SyncRunId>(),
      at = now()
    this.db
      .prepare(
        `INSERT INTO sync_runs(id,organization_id,account_id,owner_id,request_id,request_hash,fingerprint,principal_json,parameters_json,status,phase,checkpoint_json,job_id,session_id,error_code,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'pending','account',?,NULL,NULL,NULL,?,?)`,
      )
      .run(
        runId,
        scope.organizationId,
        authority.accountId,
        scope.userId,
        requestId,
        requestHash,
        fingerprint,
        JSON.stringify(authority),
        JSON.stringify(parameters),
        JSON.stringify(initialCheckpoint()),
        at,
        at,
      )
    return runId
  }
  private row(runId: SyncRunId): Row {
    const row = this.db.prepare('SELECT * FROM sync_runs WHERE id=?').get(runId)
    if (row === undefined) throw unavailable()
    return row
  }
  private workInside(row: Row): SyncWork {
    const authority = analyticsStored(syncAuthoritySchema, text(row, 'principal_json')),
      account = contentAccount(this.authorityAccount(authority))
    return {
      run: this.runDTO(row),
      account,
      authority,
      parameters: analyticsStored(syncParametersSchema, text(row, 'parameters_json')),
      checkpoint: analyticsStored(syncCheckpointSchema, text(row, 'checkpoint_json')),
    }
  }
  private requireRunning(row: Row): SyncWork {
    if (row.status !== 'running')
      throw new EducationError('result-unknown', 'sync run no longer owns its active interval')
    return this.workInside(row)
  }
  private authorityAccount(authority: SyncAuthority): Row {
    const scope = authority.kind === 'login' ? authority.actor : authority
    if (authority.kind === 'login') this.owner.assertActor(authority.actor)
    const account = this.db
      .prepare(
        `SELECT a.*,g.can_view,g.can_sync,g.can_manage,g.can_export,g.can_use_for_ai,g.revision AS grant_revision,u.auth_revision AS user_auth_revision
      FROM content_accounts a JOIN account_grants g ON g.account_id=a.id AND g.organization_id=a.organization_id
      JOIN users u ON u.id=g.user_id AND u.organization_id=g.organization_id JOIN organizations o ON o.id=a.organization_id
      WHERE a.id=? AND a.organization_id=? AND g.user_id=? AND a.enabled=1 AND g.can_sync=1 AND u.status='active' AND o.status='active'`,
      )
      .get(authority.accountId, scope.organizationId, scope.userId)
    if (
      account === undefined ||
      account.revision !== authority.accountRevision ||
      account.grant_revision !== authority.grantRevision
    )
      throw new EducationError('forbidden', 'current business authority no longer permits synchronization')
    if (authority.kind === 'schedule') {
      const schedule = this.db
        .prepare('SELECT owner_id,enabled FROM analytics_schedules WHERE id=? AND account_id=? AND organization_id=?')
        .get(authority.scheduleId, authority.accountId, scope.organizationId)
      if (
        schedule?.enabled !== 1 ||
        schedule.owner_id !== scope.userId ||
        account.user_auth_revision !== authority.userAuthRevision
      )
        throw new EducationError('forbidden', 'offline schedule authority has been revoked')
    }
    return account
  }
  private readAccount(actor: ActorContext, accountId: ContentAccountId): void {
    const account = this.analytics.accountInside(actor, accountId, null),
      permissions = accountPermissions(account)
    if (!permissions.view && !permissions.sync && !permissions.manage) throw unavailable()
  }
  private pool(poolId: string): QuotaLimits {
    const row = this.db.prepare('SELECT * FROM quota_pools WHERE id=?').get(poolId)
    if (row === undefined)
      throw new EducationError('quota-exceeded', 'configure an explicit shared quota before calling a supplier')
    if (row.paused_reason !== null)
      throw new EducationError('provider-paused', 'supplier authorization or quota requires maintainer review')
    const limits = analyticsStored(quotaLimitsSchema, text(row, 'limits_json'))
    if (limits.maxCalls < 1 || limits.maxCallsPerDay < 1 || limits.maxCallsPerAccount < 1)
      throw new EducationError('quota-exceeded', 'metered requests are disabled by the configured budget')
    return limits
  }
  private usage(where: string, values: readonly string[]): { n: number; cost: number; unpriced: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n,COALESCE(SUM(COALESCE(reserved_cost_micros,0)),0) AS cost,COUNT(*) FILTER(WHERE reserved_cost_micros IS NULL) AS unpriced FROM provider_calls WHERE status<>'cancelled' AND ${where}`,
      )
      .get(...values)
    return { n: integer(row?.n), cost: integer(row?.cost), unpriced: integer(row?.unpriced) }
  }
  private callDTO(row: Row): ProviderCallReservation {
    return {
      id: id(row.id),
      status: callStatus.parse(row.status),
      reservedCostMicros: row.reserved_cost_micros === null ? null : integer(row.reserved_cost_micros),
    }
  }
  private runDTO(row: Row): SyncRun {
    const parameters = analyticsStored(syncParametersSchema, text(row, 'parameters_json')),
      checkpoint = analyticsStored(syncCheckpointSchema, text(row, 'checkpoint_json'))
    return {
      id: id(row.id),
      accountId: id(row.account_id),
      mode: parameters.mode,
      status: runStatus.parse(row.status),
      phase: checkpoint.phase,
      completedPages: checkpoint.pages,
      contentCount: checkpoint.contents,
      coverage: checkpoint.coverage,
      errorCode: row.error_code === null ? null : text(row, 'error_code'),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
    }
  }
  private scheduleDTO(row: Row): AnalyticsSchedule {
    if (row.enabled !== 0 && row.enabled !== 1)
      throw new EducationError('storage-unavailable', 'stored schedule state is invalid')
    return {
      id: id(row.id),
      accountId: id(row.account_id),
      enabled: row.enabled === 1,
      hour: integer(row.hour),
      minute: integer(row.minute),
      timeZone: text(row, 'time_zone'),
      nextAt: timestamp(row.next_at),
      lastLocalDate: row.last_local_date === null ? null : text(row, 'last_local_date'),
      revision: integer(row.revision),
    }
  }
}
