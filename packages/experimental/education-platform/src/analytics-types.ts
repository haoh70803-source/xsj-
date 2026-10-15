/** Browser-safe account permissions, observed metrics and durable synchronization summaries. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentPlatform } from './data-provider.ts'
import type { DataProviderRequest, ProviderDelivery } from './data-provider.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ActorContext, OrganizationId, RequestId, UserId, ProjectId } from './types.ts'

/** Stable internal account identity, independent of nicknames and URLs. */
export type ContentAccountId = Branded<'EducationContentAccountId'>
/** Stable platform-content record within an account. */
export type ExternalContentId = Branded<'EducationExternalContentId'>
/** Immutable metric observation. */
export type MetricSnapshotId = Branded<'EducationMetricSnapshotId'>
/** Preview and committed import identity. */
export type MetricImportId = Branded<'EducationMetricImportId'>
/** Stable business run surviving native Job replacement. */
export type SyncRunId = Branded<'EducationSyncRunId'>
/** Durable external call reservation. */
export type ProviderCallId = Branded<'EducationProviderCallId'>
/** Persistent authorized daily schedule. */
export type AnalyticsScheduleId = Branded<'EducationAnalyticsScheduleId'>

/** Privileges are separate: viewing never grants charging, export or model use. */
export interface AccountPermissions {
  readonly view: boolean
  readonly sync: boolean
  readonly manage: boolean
  readonly export: boolean
  readonly use_for_ai: boolean
}
/** Account metadata visible to a currently granted user. */
export interface ContentAccount {
  readonly id: ContentAccountId
  readonly platform: ContentPlatform
  readonly externalId: string
  readonly title: string
  readonly enabled: boolean
  readonly revision: number
  readonly grantRevision: number
  readonly permissions: AccountPermissions
}
/** Distinct supplier metric names, without aggregating account totals from recent videos. */
export type MetricName =
  | 'likes'
  | 'collects'
  | 'comments'
  | 'shares'
  | 'views'
  | 'followers'
  | 'totalLikes'
  | 'workCount'
/** Missing and estimated fields do not masquerade as confirmed zero. */
export interface MetricValue {
  readonly value: number | null
  readonly state: 'known' | 'estimated' | 'missing' | 'not-authorized'
  readonly sourceField: string | null
}
/** Mappers explicitly label every absent metric. */
export type MetricFields = Readonly<Record<MetricName, MetricValue>>
/** Immutable source-specific account observation. */
export interface AccountMetricObservation {
  readonly id: MetricSnapshotId
  readonly accountId: ContentAccountId
  readonly source: string
  readonly fields: MetricFields
  readonly sourceDataAt: string | null
  readonly fetchedAt: string
  readonly coverage: 'complete' | 'partial' | 'unknown'
}
/** A selected content observation in one explicit source; image rows remain distinct from videos. */
export interface ContentObservation {
  readonly id: ExternalContentId
  readonly snapshotId: MetricSnapshotId
  readonly accountId: ContentAccountId
  readonly externalId: string
  readonly kind: 'video' | 'image' | 'article' | 'unknown'
  readonly title: string
  readonly url: string
  readonly publishedAt: string | null
  readonly pinned: boolean | null
  readonly fields: MetricFields
  readonly source: string
  readonly sourceDataAt: string | null
  readonly fetchedAt: string
}
/** Explicit half-open publication window and its calendar zone. */
export interface PublicationWindow {
  readonly from: string
  readonly to: string
  readonly timeZone: string
  readonly mode: 'complete-days' | 'rolling'
}
/** Saved-data query; keywords affect display, never the statistical baseline. */
export interface AnalyticsQuery {
  readonly accountId: ContentAccountId
  readonly mode: 'latest' | 'seven-days'
  readonly source: string
  readonly keyword: string
}
/** Chronological sample, separate images and an unfiltered median baseline. */
export interface ContentAnalysis {
  readonly items: readonly ContentObservation[]
  readonly images: readonly ContentObservation[]
  readonly undated: readonly ContentObservation[]
  readonly unknownPublicationCount: number
  readonly medianLikes: number | null
  readonly validSampleCount: number
  readonly baselineCount: number
  readonly aboveMedian: readonly ContentObservation[]
  readonly window: PublicationWindow | null
  readonly recentCount: number
}
/** Explicit user trigger; no supplier parameters or owner overrides cross this request. */
export interface RequestSyncInput {
  readonly accountId: ContentAccountId
  readonly mode: 'latest' | 'seven-days'
  readonly requestId: RequestId
}
/** Logout revokes only the foreground branch; offline authority still rechecks current business grants. */
export type SyncAuthority =
  | {
    readonly kind: 'login'
    readonly actor: ActorContext
    readonly accountId: ContentAccountId
    readonly grantRevision: number
    readonly accountRevision: number
  }
  | {
    readonly kind: 'schedule'
    readonly organizationId: OrganizationId
    readonly userId: UserId
    readonly userAuthRevision: number
    readonly accountId: ContentAccountId
    readonly grantRevision: number
    readonly accountRevision: number
    readonly scheduleId: AnalyticsScheduleId
  }
/** Employee-safe run status excludes native handles and private output rings. */
export interface SyncRun {
  readonly id: SyncRunId
  readonly accountId: ContentAccountId
  readonly mode: 'latest' | 'seven-days'
  readonly status: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'
  readonly phase: string
  readonly completedPages: number
  readonly contentCount: number
  readonly coverage: 'complete' | 'partial' | 'unknown'
  readonly errorCode: string | null
  readonly createdAt: string
  readonly updatedAt: string
}
/** Host-selected limits and mapping choices fixed with a run. */
export interface SyncParameters {
  readonly poolId: string
  readonly mode: 'latest' | 'seven-days'
  readonly recentCount: 3 | 5
  readonly window: PublicationWindow | null
  readonly maxPages: number
  readonly maxCalls: number
  readonly sortType: string
  readonly mappingVersion: string
  readonly verifiedOrder: boolean
  readonly fetchDetails: boolean
  readonly maxRetries: number
  readonly retryDelayMs: number
}
/** Shared-pool reservations, including unknown calls, survive restarts. */
export interface QuotaLimits {
  readonly poolId: string
  readonly timeZone: string
  readonly resumeEpoch: string
  readonly maxCalls: number
  readonly maxCallsPerDay: number
  readonly maxCallsPerAccount: number
  readonly maxCostMicros: number | null
  readonly accountCostMicros: number | null
  readonly worksCostMicros: number | null
  readonly contentCostMicros: number | null
}

/** Committed page position; native Job ids do not replace this cross-restart state. */
export interface SyncCheckpoint {
  readonly phase: 'account' | 'works' | 'details' | 'done'
  readonly nextOffset: number
  readonly pages: number
  readonly contents: number
  readonly coverage: 'complete' | 'partial' | 'unknown'
  readonly detailIds: readonly string[]
  readonly detailIndex: number
  readonly seenOffsets: readonly number[]
  readonly accountAliases: readonly string[]
  readonly retry: number
}
/** One endpoint-specific validated page; suppliers never choose authority or a spending limit. */
export type NormalizedProviderResult =
  | {
    readonly kind: 'account'
    readonly fields: MetricFields
    readonly sourceDataAt: string | null
    readonly aliases: readonly string[]
    readonly observedFields: readonly string[]
  }
  | {
    readonly kind: 'works'
    readonly items: readonly NormalizedContent[]
    readonly hasMore: boolean | null
    readonly nextOffset: number | null
  }
  | { readonly kind: 'content'; readonly item: NormalizedContent }
/** Host-only execution specification, not an employee RPC response. */
export interface SyncWork {
  readonly run: SyncRun
  readonly account: ContentAccount
  readonly authority: SyncAuthority
  readonly parameters: SyncParameters
  readonly checkpoint: SyncCheckpoint
}
/** A reservation distinguishes sent/unknown cost from a request proved not dispatched. */
export interface ProviderCallReservation {
  readonly id: ProviderCallId
  readonly status: 'reserved' | 'sent' | 'confirmed' | 'unknown' | 'cancelled'
  readonly reservedCostMicros: number | null
}
/** User-visible schedule summary contains no login cookie or private Agent/Job identity. */
export interface AnalyticsSchedule {
  readonly id: AnalyticsScheduleId
  readonly accountId: ContentAccountId
  readonly enabled: boolean
  readonly hour: number
  readonly minute: number
  readonly timeZone: string
  readonly nextAt: string
  readonly lastLocalDate: string | null
  readonly revision: number
}
/** Creating a daily plan is explicit, grant-scoped and separately revisioned. */
export interface SaveAnalyticsScheduleInput {
  readonly accountId: ContentAccountId
  readonly enabled: boolean
  readonly hour: number
  readonly minute: number
  readonly timeZone: string
  readonly expectedRevision: number
  readonly requestId: RequestId
}
/** Durable data synchronization; Host lifecycle methods are never registered as employee Remote methods. */
export interface SyncRepository {
  /**
 * Persist reviewed pool limits without resetting reserved usage.
 * @param input - trusted configured pool and explicit resume epoch. Persisted usage is never reset.
 */
  configureQuota(input: QuotaLimits): void
  /**
 * Return one original or compatible merged run.
 * @param actor - current employee.
 * @param input - explicit metered trigger.
 * @param rawParameters - Host-fixed policy/range.
 * @returns one original or compatible merged run.
 */
  request(actor: ActorContext, input: RequestSyncInput, rawParameters: SyncParameters): SyncRun
  /**
 * Return original safe run or null, without starting another request.
 * @param actor - current employee.
 * @param requestId - original request.
 * @returns original safe run or null, without starting another request.
 */
  find(actor: ActorContext, requestId: RequestId): SyncRun | null
  /**
 * Return safe current summary under view/sync grants.
 * @param actor - current employee.
 * @param runId - account-scoped run.
 * @returns safe current summary under view/sync grants.
 */
  get(actor: ActorContext, runId: SyncRunId): SyncRun
  /**
 * Return bounded safe summaries without other users' private outputs.
 * @param actor - current employee.
 * @param accountId - granted account.
 * @returns bounded safe summaries without other users' private outputs.
 */
  list(actor: ActorContext, accountId: ContentAccountId): readonly SyncRun[]
  /**
 * Stop the owned generation and preserve the last committed draft.
 * @param actor - current employee.
 * @param runId - own or management-authorized run.
 * @returns cancelled summary; possible charged calls retain their reservations.
 */
  cancel(actor: ActorContext, runId: SyncRunId): SyncRun
  /**
 * Return safe old summary; unknown spending stays occupied and a subsequent trigger requires a new key.
 * @param actor - current account manager.
 * @param runId - unknown run acknowledged after manual review.
 * @returns safe old summary; unknown spending stays occupied and a subsequent trigger requires a new key.
 */
  allowUnknownRetry(actor: ActorContext, runId: SyncRunId): SyncRun
  /**
 * Return uniquely claimed work, or null if another worker already owns it.
 * @param runId - durable pending/interrupted run.
 * @returns uniquely claimed work, or null if another worker already owns it.
 */
  claim(runId: SyncRunId): SyncWork | null
  /**
 * Return reauthorized Host-only execution specification.
 * @param runId - claimed original run.
 * @returns reauthorized Host-only execution specification.
 */
  work(runId: SyncRunId): SyncWork
  /**
 * Associate a durable sync run with its current private native owner.
 * @param runId - claimed run.
 * @param jobId - process-local native Job.
 * @param sessionId - private dedicated native owner.
 */
  attachNative(runId: SyncRunId, jobId: string, sessionId: SessionId): void
  /**
 * Return persisted pool/account/run reservation before sending.
 * @param runId - claimed run.
 * @param input - exact selected provider operation.
 * @param retry - bounded known-response retry ordinal.
 * @returns persisted pool/account/run reservation before sending.
 */
  reserveCall(runId: SyncRunId, input: DataProviderRequest, retry: number): ProviderCallReservation
  /**
 * Reauthorize and persist dispatch before executing the provider request.
 * @param runId - claimed run.
 * @param callId - reserved request. Rechecks authority immediately before dispatch.
 */
  markSent(runId: SyncRunId, callId: ProviderCallId): void
  /**
 * Commit normalized observations and their next checkpoint in one transaction.
 * @param runId - claimed run.
 * @param callId - sent request.
 * @param rawResult - validated endpoint result.
 * @param rawCheckpoint - next committed position.
 * @param providerRequestId - bounded vendor correlation.
 * @param responseHash - received-data digest. Commits observations, result and checkpoint together.
 */
  commitCall(
    runId: SyncRunId,
    callId: ProviderCallId,
    rawResult: NormalizedProviderResult,
    rawCheckpoint: SyncCheckpoint,
    providerRequestId: string | null,
    responseHash: string,
  ): void
  /**
 * Settle dispatch knowledge while retaining possible external charges.
 * @param runId - owning run.
 * @param callId - existing reservation.
 * @param code - safe failure code.
 * @param delivery - whether dispatch/result is known.
 * @param checkpoint - persisted retry position, if applicable.
 */
  failCall(
    runId: SyncRunId,
    callId: ProviderCallId,
    code: string,
    delivery: ProviderDelivery,
    checkpoint?: SyncCheckpoint,
  ): void
  /**
 * Settle a durable run only after its committed progress is known.
 * @param runId - runtime-owned original run.
 * @param status - terminal state.
 * @param errorCode - safe reason; successful completion requires a committed done checkpoint.
 */
  finish(runId: SyncRunId, status: SyncRun['status'], errorCode: string | null): void
  /** Mark process-local work interrupted and sent-unconfirmed calls unknown, without clearing usage or sending requests. */
  interruptPending(): void
  /**
 * Return bounded interrupted runs that may be reauthorized and resumed from committed checkpoints.
 * @returns bounded interrupted runs that may be reauthorized and resumed from committed checkpoints.
 */
  recoverable(): readonly SyncRunId[]
  /**
 * Return original safe schedule acknowledgement.
 * @param actor - current account manager with sync privilege.
 * @param input - explicit daily plan and baseline.
 * @returns original safe schedule acknowledgement.
 */
  saveSchedule(actor: ActorContext, input: SaveAnalyticsScheduleInput): AnalyticsWriteResult
  /**
 * Return safe saved plan or null.
 * @param actor - current account user.
 * @param accountId - granted account.
 * @returns safe saved plan or null.
 */
  readSchedule(actor: ActorContext, accountId: ContentAccountId): AnalyticsSchedule | null
  /**
 * Return bounded due plan ids without creating unowned work.
 * @param at - actual current UTC time.
 * @returns bounded due plan ids without creating unowned work.
 */
  dueSchedules(at: string): readonly AnalyticsScheduleId[]
  /**
 * Return saved platform for deployment-selected capabilities.
 * @param scheduleId - Host-only due plan.
 * @returns saved platform for deployment-selected capabilities.
 */
  schedulePlatform(scheduleId: AnalyticsScheduleId): ContentPlatform
  /**
 * Return one atomically registered daily run, or null if already claimed/not due.
 * @param scheduleId - due persistent plan.
 * @param at - actual current time.
 * @param rawParameters - current Host policy for a latest-N run.
 * @returns one atomically registered daily run, or null if already claimed/not due.
 */
  claimSchedule(scheduleId: AnalyticsScheduleId, at: string, rawParameters: SyncParameters): SyncRunId | null
}

/** Source-specific saved data; opening this view never starts an external request. */
export interface AnalyticsDataset {
  readonly account: ContentAccount
  readonly source: string
  readonly sources: readonly string[]
  readonly overview: AccountMetricObservation | null
  readonly analysis: ContentAnalysis
  readonly coverage: 'complete' | 'partial' | 'unknown'
  readonly truncated: boolean
}
/** Explicit controlled account creation. */
export interface CreateContentAccountInput {
  readonly platform: ContentPlatform
  readonly externalId: string
  readonly title: string
  readonly requestId: RequestId
}
/** Management never derives a user's authority from an external platform identifier. */
export interface SetAccountGrantInput {
  readonly accountId: ContentAccountId
  readonly username: string
  readonly permissions: AccountPermissions
  readonly expectedRevision: number
  readonly requestId: RequestId
}
/** Account enablement is separate from per-user grants. */
export interface SetAccountEnabledInput {
  readonly accountId: ContentAccountId
  readonly enabled: boolean
  readonly expectedRevision: number
  readonly requestId: RequestId
}
/** Safe account-scoped access-management view, not an organization-wide employee directory. */
export interface AccountGrantView {
  readonly userId: UserId
  readonly username: string
  readonly permissions: AccountPermissions
  readonly revision: number
}
/** Mutation acknowledgements retain original revisions without freezing an old permission grant. */
export type AnalyticsWriteResult =
  | {
    readonly operation: 'accounts.create' | 'accounts.enable'
    readonly accountId: ContentAccountId
    readonly revision: number
  }
  | {
    readonly operation: 'accounts.grant'
    readonly accountId: ContentAccountId
    readonly userId: UserId
    readonly revision: number
  }
  | {
    readonly operation: 'imports.commit'
    readonly accountId: ContentAccountId
    readonly importId: MetricImportId
    readonly accepted: number
    readonly rejected: number
    readonly skipped: number
  }
  | {
    readonly operation: 'schedules.save'
    readonly accountId: ContentAccountId
    readonly scheduleId: AnalyticsScheduleId
    readonly revision: number
  }
/** Immutable normalized row prepared for account-scoped import or API observation. */
export interface NormalizedContent {
  readonly externalId: string
  readonly kind: ContentObservation['kind']
  readonly title: string
  readonly url: string
  readonly publishedAt: string | null
  readonly pinned: boolean | null
  readonly fields: MetricFields
  readonly sourceDataAt: string | null
}
/** Import parsing and consent are explicit; a source label cannot masquerade as an API dataset. */
export interface PreviewMetricImportInput {
  readonly accountId: ContentAccountId
  readonly sourceLabel: string
  readonly observedAt: string
  readonly content: string
  readonly requestId: RequestId
}
/** Bounded preview distinguishes rejected and skipped rows from successfully prepared records. */
export interface MetricImportPreview {
  readonly id: MetricImportId
  readonly accountId: ContentAccountId
  readonly source: string
  readonly observedAt: string
  readonly fileHash: string
  readonly validRows: number
  readonly rejectedRows: number
  readonly skippedRows: number
  readonly errors: readonly { readonly row: number; readonly code: string }[]
  readonly sample: readonly NormalizedContent[]
  readonly accountFields: MetricFields | null
  readonly truncated: boolean
  readonly status: 'preview' | 'committed'
}
/** Confirmation cannot replace the preview's rows, time, source or authority. */
export interface CommitMetricImportInput {
  readonly importId: MetricImportId
  readonly expectedFileHash: string
  readonly allowPartial: boolean
  readonly requestId: RequestId
}
/** Saved observations transfer as references; research additionally requires supplied original text. */
export interface AnalyticsTransferInput {
  readonly projectId: ProjectId
  readonly snapshotId: MetricSnapshotId
  readonly target: 'writing' | 'research'
  readonly originalText: string
  readonly requestId: RequestId
}
/** Public account/import operations; all fields are resolved under the current Actor. */
export interface AnalyticsRepository {
  /**
 * Require a current explicit account grant before transport admission.
 * @param actor - current employee.
 * @param accountId - account-scoped request. Require a current explicit nonempty grant before transport admission.
 */
  requireAccess(actor: ActorContext, accountId: ContentAccountId): void
  /**
 * Recheck independent current view and export privileges.
 * @param actor - current employee.
 * @param accountId - explicit account. Recheck the separate export grant immediately before download/copy.
 */
  requireExport(actor: ActorContext, accountId: ContentAccountId): void
  /**
 * Create a default-private account through an original request.
 * @param actor - current employee.
 * @param input - explicit private-account creation.
 * @returns original mutation acknowledgement.
 */
  createAccount(actor: ActorContext, input: CreateContentAccountInput): AnalyticsWriteResult
  /**
 * Return only accounts with an explicit nonempty grant.
 * @param actor - current employee.
 * @returns only accounts with an explicit nonempty grant.
 */
  listAccounts(actor: ActorContext): readonly ContentAccount[]
  /**
 * Return account-scoped grants; management is required.
 * @param actor - current employee.
 * @param accountId - account being managed.
 * @returns account-scoped grants; management is required.
 */
  listGrants(actor: ActorContext, accountId: ContentAccountId): readonly AccountGrantView[]
  /**
 * Return original grant acknowledgement.
 * @param actor - current employee.
 * @param input - management-authorized grant and revision.
 * @returns original grant acknowledgement.
 */
  setGrant(actor: ActorContext, input: SetAccountGrantInput): AnalyticsWriteResult
  /**
 * Return original mutation acknowledgement.
 * @param actor - current employee.
 * @param input - enablement baseline.
 * @returns original mutation acknowledgement.
 */
  setEnabled(actor: ActorContext, input: SetAccountEnabledInput): AnalyticsWriteResult
  /**
 * Return saved observations and the unfiltered statistical baseline.
 * @param actor - current employee.
 * @param input - saved-source query.
 * @param recentCount - confirmed video sample size.
 * @param timeZone - confirmed calendar zone.
 * @param forExport - also require the current separate export grant inside this read transaction.
 * @returns saved observations and the unfiltered statistical baseline.
 */
  query(actor: ActorContext, input: AnalyticsQuery, recentCount: 3 | 5, timeZone: string, forExport?: boolean): AnalyticsDataset
  /**
 * Prepare a bounded immutable import preview without committing metric rows.
 * @param actor - current employee.
 * @param input - exact file/source/time and original preview request.
 * @returns immutable bounded preview without committing metric rows.
 */
  previewImport(actor: ActorContext, input: PreviewMetricImportInput): MetricImportPreview
  /**
 * Return real accepted, rejected and skipped counts.
 * @param actor - current employee.
 * @param input - explicit unchanged preview confirmation.
 * @returns real accepted, rejected and skipped counts.
 */
  commitImport(actor: ActorContext, input: CommitMetricImportInput): AnalyticsWriteResult
  /**
 * Return original acknowledgement or null, reauthorized against current grants.
 * @param actor - current employee.
 * @param operation - original mutation kind.
 * @param requestId - original key.
 * @returns original acknowledgement or null, reauthorized against current grants.
 */
  mutationResult(
    actor: ActorContext,
    operation: AnalyticsWriteResult['operation'],
    requestId: RequestId,
  ): AnalyticsWriteResult | null
  /**
 * Return exact listener disposer.
 * @param listener - Host-only grant/enablement observer with no private payload.
 * @returns exact listener disposer.
 */
  onAccountCommit(listener: (accountId: ContentAccountId) => void): () => void
}
