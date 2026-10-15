/** Authorized education Remote methods and bounded project observation. */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-experimental-education-identity'
import { EducationError, decodeResearchDocument } from '@deepseek-ai/dsh-experimental-education-platform'
import type { ConnectionAccess, PeerScope } from '@deepseek-ai/dsh-client-connection'
import { ConnectionRpcError } from '@deepseek-ai/dsh-client-connection'
import type { z } from 'zod'
import type {
  ActorContext,
  ArtifactId,
  ArtifactVersionDTO,
  ArtifactVersionSummary,
  CreateProjectInput,
  DraftCommitted,
  EducationProjectCommit,
  Page,
  PageInput,
  ProjectCreated,
  ProjectDTO,
  ProjectId,
  ProjectState,
  RestoreVersionInput,
  SaveVersionInput,
  SyncDraftInput,
  VersionSaved,
  WriteResult,
  ProfileVersion,
  SaveProfileInput,
  SaveSourceInput,
  SourceDTO,
  AuthorizeSourceInput,
  StartCreationInput,
  RunDTO,
  RunId,
  RequestId,
  CreationState,
  CreationMutation,
  CreationMutationResult,
  KnowledgeSearch,
  KnowledgeItem,
  SourceVersionId,
  EnsureResearchInput,
  ResearchArtifactCreated,
  ResearchSource,
  ResearchState,
  ResearchVersion,
  StartResearchInput,
  ContentAccount,
  ContentAccountId,
  AccountGrantView,
  CreateContentAccountInput,
  SetAccountGrantInput,
  SetAccountEnabledInput,
  AnalyticsQuery,
  AnalyticsDataset,
  PreviewMetricImportInput,
  MetricImportPreview,
  CommitMetricImportInput,
  AnalyticsWriteResult,
  RequestSyncInput,
  SyncRun,
  SyncRunId,
  AnalyticsSchedule,
  SaveAnalyticsScheduleInput,
  ResearchTransferInput,
  AnalyticsTransferInput,
  ImportLegacyResearchInput,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import type {
  Config,
  ProjectFollowFrame,
  ProjectRequest,
  ResultRequest,
  VersionPageRequest,
  VersionRequest,
  ResearchImportRequest,
} from './types.ts'
import { parse, requestSchemas } from './validation.ts'
import { wireFailure } from './errors.ts'
import { GenerationRuntime } from './generation.ts'
import { resolveAnalyticsConfig, type AnalyticsConfig } from './analytics-config.ts'
import { SynchronizationRuntime } from './synchronization.ts'
import { RedFoxProvider } from './redfox.ts'

export type * from './types.ts'

/** Controlled UTF-8 draft or version download; no filesystem path is accepted. */
export const EXPORT_TEXT_PATH = '/api/education/artifacts.exportText'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host education Remote namespace requiring an employee invocation. */
    educationController: EducationController
  }
}

interface Follower {
  readonly actor: ActorContext
  readonly projectId: ProjectId
  pending: EducationProjectCommit | undefined
  wake: () => void
}

/** Host-only business Controller with generated Remote types and exact resource grants. */
export class EducationController extends TypertRemoteService {
  static inject = [
    'educationRepository',
    'educationPeers',
    'educationAuthorization',
    'connection',
    'sessionQuery',
    'typert',
  ]
  static Config: Schema<Config> = Schema.object({
    analytics: Schema.any().default({}),
    maxFollowers: Schema.number().step(1).min(1).max(10_000).default(100),
    creationEnabled: Schema.boolean().default(false),
    researchEnabled: Schema.boolean().default(false),
    researchMaxTokens: Schema.number().step(1).min(512).max(32_768).default(8192),
    researchMaxAttempts: Schema.number().step(1).min(1).max(3).default(2),
    researchTimeoutMs: Schema.number().step(1).min(1000).max(600_000).default(300_000),
    provider: Schema.string().default('deepseek-official'),
    model: Schema.string().default('deepseek-flash'),
    credentialRef: Schema.string()
      .pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .default('DEEPSEEK_API_KEY'),
    maxInputBytes: Schema.number().step(1).min(4096).max(2_000_000).default(120_000),
    maxConcurrentGenerations: Schema.number().step(1).min(1).max(32).default(4),
    generationTimeoutMs: Schema.number().step(1).min(1000).max(600_000).default(120_000),
    maxTokens: Schema.number().step(1).min(256).max(16_000).default(4096),
    policyVersion: Schema.string().min(1).default('education-content-v3'),
  })
  private readonly schemas: ReturnType<typeof requestSchemas>
  private readonly remoteSchemas: ReadonlyMap<string, z.ZodType>
  private readonly followers = new Set<Follower>()
  private readonly lifetime = new AbortController()
  private readonly maxFollowers: number
  private readonly report: (error: unknown) => void
  private generation: GenerationRuntime | undefined
  private synchronization: SynchronizationRuntime | undefined
  private readonly analyticsPolicy: AnalyticsConfig

  /**
   * Install employee-owned business endpoints and their reversible observations.
   * @param ctx - selected repository and native transport dependencies.
   * @param config - bounded subscription capacity.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'educationController', { namespace: 'education' })
    const resolved = EducationController.Config(config) as Required<Config>
    this.maxFollowers = resolved.maxFollowers
    this.analyticsPolicy = resolveAnalyticsConfig(resolved.analytics)
    ctx.inject(['agents', 'sessions', 'jobs', 'credentials'], (runtime) => {
      const { baseUrl, credentialRef, timeoutMs, maxResponseBytes, allowLoopback } = this.analyticsPolicy
      this.synchronization = new SynchronizationRuntime(
        runtime,
        this.analyticsPolicy,
        new RedFoxProvider({ baseUrl, credentialRef, timeoutMs, maxResponseBytes, allowLoopback }, runtime.credentials),
      )
      runtime.effect(
        () => () => {
          this.synchronization = undefined
        },
        'education: sync availability',
      )
    })
    if (resolved.creationEnabled || resolved.researchEnabled)
      ctx.inject(['agents', 'sessions', 'credentials', 'tools', 'systemPrompt'], (runtime) => {
        this.generation = new GenerationRuntime(runtime, resolved)
        runtime.effect(
          () => () => {
            this.generation = undefined
          },
          'education: creation availability',
        )
      })
    this.schemas = requestSchemas(ctx.educationRepository.limits)
    this.remoteSchemas = new Map(Object.entries(this.schemas).filter(([method]) => method !== 'exportText'))
    const logger = ctx.logger
    this.report = (error) => {
      logger.warn('Education request failed: %s', error instanceof EducationError ? error.code : 'internal')
    }
    ctx.effect(
      () => () => {
        this.lifetime.abort()
      },
      'education-controller: lifetime',
    )
    ctx.effect(
      () =>
        ctx.educationRepository.onProjectCommit((commit) => {
          for (const follower of this.followers) {
            if (
              follower.actor.organizationId !== commit.organizationId ||
              follower.actor.userId !== commit.userId ||
              follower.projectId !== commit.projectId
            )
              continue
            follower.pending = commit
            follower.wake()
          }
        }),
      'education-controller: commit observation',
    )
    ctx.educationAuthorization.register({
      matches: access => this.claims(access),
      allows: (actor, access) => this.authorize(actor, access),
    })
    ctx.connection.fetch.register({
      path: EXPORT_TEXT_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request, peer) => Promise.resolve(this.exportText(request, peer)),
    })
  }

  /**
 * Return configuration availability with no external request.
 * @param request - empty current-employee read.
 * @returns configuration availability with no external request.
 */
  @Remote
  analyticsAvailability(
    request: Record<string, never>,
  ): Promise<{ enabled: boolean; configured: boolean; platforms: readonly ('douyin' | 'xiaohongshu')[] }> {
    return this.runAsync(async () => {
      parse(this.schemas.analyticsAvailability, request)
      this.actor()
      return this.synchronization?.availability() ?? { enabled: false, configured: false, platforms: [] }
    })
  }
  /**
 * Return explicitly granted accounts.
 * @param request - empty private account query.
 * @returns explicitly granted accounts.
 */
  @Remote
  analyticsAccountsList(request: Record<string, never>): readonly ContentAccount[] {
    return this.run(() => {
      parse(this.schemas.analyticsAccountsList, request)
      return this.ctx.educationRepository.analytics.listAccounts(this.actor())
    })
  }
  /**
 * Return original creation acknowledgement.
 * @param request - confirmed private account identity.
 * @returns original creation acknowledgement.
 */
  @Remote
  analyticsAccountCreate(request: CreateContentAccountInput): AnalyticsWriteResult {
    return this.run(() =>
      this.ctx.educationRepository.analytics.createAccount(
        this.actor(),
        parse(this.schemas.analyticsAccountCreate, request),
      ),
    )
  }
  /**
 * Return original current-authorized grant acknowledgement.
 * @param request - five separate privileges and grant revision.
 * @returns original current-authorized grant acknowledgement.
 */
  @Remote
  analyticsAccountSetGrant(request: SetAccountGrantInput): AnalyticsWriteResult {
    return this.run(() =>
      this.ctx.educationRepository.analytics.setGrant(
        this.actor(),
        parse(this.schemas.analyticsAccountSetGrant, request),
      ),
    )
  }
  /**
 * Return original safe acknowledgement.
 * @param request - account revision and explicit enablement.
 * @returns original safe acknowledgement.
 */
  @Remote
  analyticsAccountSetEnabled(request: SetAccountEnabledInput): AnalyticsWriteResult {
    return this.run(() =>
      this.ctx.educationRepository.analytics.setEnabled(
        this.actor(),
        parse(this.schemas.analyticsAccountSetEnabled, request),
      ),
    )
  }
  /**
 * Return account-only grants without credential or unrelated employee records.
 * @param request - managed account.
 * @returns account-only grants without credential or unrelated employee records.
 */
  @Remote
  analyticsAccountGrants(request: { readonly accountId: ContentAccountId }): readonly AccountGrantView[] {
    return this.run(() =>
      this.ctx.educationRepository.analytics.listGrants(
        this.actor(),
        parse(this.schemas.analyticsAccountGrants, request).accountId,
      ),
    )
  }
  /**
 * Return observed cumulative values; reading starts no paid work.
 * @param request - saved-source display query.
 * @returns observed cumulative values; reading starts no paid work.
 */
  @Remote
  analyticsQuery(request: AnalyticsQuery): AnalyticsDataset {
    return this.run(() =>
      this.ctx.educationRepository.analytics.query(
        this.actor(),
        parse(this.schemas.analyticsQuery, request),
        this.analyticsPolicy.recentCount,
        this.analyticsPolicy.timeZone,
      ),
    )
  }
  /**
 * Return fresh authorized data under both view and export grants.
 * @param request - explicit saved-source export.
 * @returns fresh authorized data under both view and export grants.
 */
  @Remote
  analyticsExport(request: AnalyticsQuery): AnalyticsDataset {
    return this.run(() => {
      const actor = this.actor(),
        input = parse(this.schemas.analyticsExport, request)
      return this.ctx.educationRepository.analytics.query(
        actor,
        input,
        this.analyticsPolicy.recentCount,
        this.analyticsPolicy.timeZone,
        true,
      )
    })
  }
  /**
 * Return preview without metric writes.
 * @param request - bounded file and explicit source observation time.
 * @returns preview without metric writes.
 */
  @Remote
  analyticsImportPreview(request: PreviewMetricImportInput): MetricImportPreview {
    return this.run(() =>
      this.ctx.educationRepository.analytics.previewImport(
        this.actor(),
        parse(this.schemas.analyticsImportPreview, request),
      ),
    )
  }
  /**
 * Return real accepted/rejected/skipped counts.
 * @param request - exact immutable preview and explicit partial-import choice.
 * @returns real accepted/rejected/skipped counts.
 */
  @Remote
  analyticsImportCommit(request: CommitMetricImportInput): AnalyticsWriteResult {
    return this.run(() =>
      this.ctx.educationRepository.analytics.commitImport(
        this.actor(),
        parse(this.schemas.analyticsImportCommit, request),
      ),
    )
  }
  /**
 * Return reauthorized original acknowledgement or null without replay.
 * @param request - original mutation identity.
 * @returns reauthorized original acknowledgement or null without replay.
 */
  @Remote
  analyticsMutationResult(request: {
    readonly operation: AnalyticsWriteResult['operation']
    readonly requestId: RequestId
  }): AnalyticsWriteResult | null {
    return this.run(() => {
      const input = parse(this.schemas.analyticsMutationResult, request)
      return this.ctx.educationRepository.analytics.mutationResult(this.actor(), input.operation, input.requestId)
    })
  }
  /**
 * Return one durable merged run.
 * @param request - explicit metered scope with original request key.
 * @returns one durable merged run.
 */
  @Remote
  analyticsSyncRequest(request: RequestSyncInput): Promise<SyncRun> {
    return this.runAsync(async () =>
      this.syncRuntime().request(this.actor(), parse(this.schemas.analyticsSyncRequest, request)),
    )
  }
  /**
 * Return prior safe result or null, without charging.
 * @param request - original request key.
 * @returns prior safe result or null, without charging.
 */
  @Remote
  analyticsSyncFind(request: { readonly requestId: RequestId }): SyncRun | null {
    return this.run(() =>
      this.ctx.educationRepository.sync.find(this.actor(), parse(this.schemas.analyticsSyncFind, request).requestId),
    )
  }
  /**
 * Return current safe status.
 * @param request - granted run identity.
 * @returns current safe status.
 */
  @Remote
  analyticsSyncGet(request: { readonly runId: SyncRunId }): SyncRun {
    return this.run(() =>
      this.ctx.educationRepository.sync.get(this.actor(), parse(this.schemas.analyticsSyncGet, request).runId),
    )
  }
  /**
 * Return bounded run history without native owner handles.
 * @param request - granted account.
 * @returns bounded run history without native owner handles.
 */
  @Remote
  analyticsSyncList(request: { readonly accountId: ContentAccountId }): readonly SyncRun[] {
    return this.run(() =>
      this.ctx.educationRepository.sync.list(this.actor(), parse(this.schemas.analyticsSyncList, request).accountId),
    )
  }
  /**
 * Return cancellation retaining sent/unknown spending.
 * @param request - own or managed run.
 * @returns cancellation retaining sent/unknown spending.
 */
  @Remote
  analyticsSyncCancel(request: { readonly runId: SyncRunId }): SyncRun {
    return this.run(() =>
      this.syncRuntime().cancel(this.actor(), parse(this.schemas.analyticsSyncCancel, request).runId),
    )
  }
  /**
 * Return old failed summary; another trigger requires a new key and its own budget.
 * @param request - management acknowledgement after manual supplier reconciliation.
 * @returns old failed summary; another trigger requires a new key and its own budget.
 */
  @Remote
  analyticsSyncReviewUnknown(request: { readonly runId: SyncRunId; readonly confirmed: true }): SyncRun {
    return this.run(() =>
      this.ctx.educationRepository.sync.allowUnknownRetry(
        this.actor(),
        parse(this.schemas.analyticsSyncReviewUnknown, request).runId,
      ),
    )
  }
  /**
 * Return persisted offline business plan or null.
 * @param request - granted account.
 * @returns persisted offline business plan or null.
 */
  @Remote
  analyticsScheduleRead(request: { readonly accountId: ContentAccountId }): AnalyticsSchedule | null {
    return this.run(() =>
      this.ctx.educationRepository.sync.readSchedule(
        this.actor(),
        parse(this.schemas.analyticsScheduleRead, request).accountId,
      ),
    )
  }
  /**
 * Return original plan acknowledgement; disabling immediately cancels active unauthorized work.
 * @param request - explicit durable authority and baseline.
 * @returns original plan acknowledgement; disabling immediately cancels active unauthorized work.
 */
  @Remote
  analyticsScheduleSave(request: SaveAnalyticsScheduleInput): AnalyticsWriteResult {
    return this.run(() => {
      const result = this.ctx.educationRepository.sync.saveSchedule(
        this.actor(),
        parse(this.schemas.analyticsScheduleSave, request),
      )
      this.synchronization?.recheck()
      return result
    })
  }
  /**
 * Return reference-method source without modifying a profile or starting generation.
 * @param request - saved report version and selected creative direction.
 * @returns reference-method source without modifying a profile or starting generation.
 */
  @Remote
  researchTransfer(request: ResearchTransferInput): SourceDTO {
    return this.run(() =>
      this.ctx.educationRepository.transfers.fromResearch(this.actor(), parse(this.schemas.researchTransfer, request)),
    )
  }
  /**
 * Return account-authorized reference source.
 * @param request - immutable observation and explicit original text when needed.
 * @returns account-authorized reference source.
 */
  @Remote
  analyticsTransfer(request: AnalyticsTransferInput): SourceDTO {
    return this.run(() =>
      this.ctx.educationRepository.transfers.fromAnalytics(
        this.actor(),
        parse(this.schemas.analyticsTransfer, request),
      ),
    )
  }

  private syncRuntime(): SynchronizationRuntime {
    if (this.synchronization === undefined)
      throw new EducationError('identity-unavailable', 'native data execution services are unavailable')
    return this.synchronization
  }

  /**
   * Search current authorized source versions with literal keywords.
   * @param request - bounded, identity-bound knowledge query.
   * @returns source metadata without bodies or unauthorized counts.
   */
  @Remote
  knowledgeSearch(request: KnowledgeSearch): Page<KnowledgeItem> {
    return this.run(() => {
      const { cursor, ...input } = parse(this.schemas.knowledgeSearch, request)
      return this.ctx.educationRepository.knowledge.search(this.actor(), {
        ...input,
        ...(cursor === undefined ? {} : { cursor }),
      })
    })
  }
  /**
   * Read an immutable selected source version with current upstream permissions.
   * @param request - exact source version, without an owner override.
   * @returns currently authorized text or a uniform unavailable failure.
   */
  @Remote
  knowledgeReadSourceVersion(request: { readonly versionId: SourceVersionId }): SourceDTO {
    return this.run(() =>
      this.ctx.educationRepository.knowledge.readSourceVersion(
        this.actor(),
        parse(this.schemas.knowledgeReadSourceVersion, request).versionId,
      ),
    )
  }
  /**
   * Read the current employee profile without accepting an owner override.
   * @param request - empty owner-scoped read.
   * @returns current profile or null.
   */
  @Remote
  profilesReadSelf(request: Record<string, never>): ProfileVersion | null {
    return this.run(() => {
      parse(this.schemas.profilesReadSelf, request)
      return this.ctx.educationRepository.creation.readProfile(this.actor())
    })
  }
  /**
   * Import confirmed original text or a media-free V1 transcript without running a model.
   * @param request - explicit consent, source revision and complete bounded input.
   * @returns original source-write outcome under current grants.
   */
  @Remote
  researchImportSource(request: ResearchImportRequest): SourceDTO {
    return this.run(() => {
      const { sourceId, ...input } = parse(this.schemas.researchImportSource, request)
      return this.ctx.educationRepository.research.importSource(this.actor(), {
        ...input,
        ...(sourceId === undefined ? {} : { sourceId }),
      })
    })
  }
  /**
 * Return original acknowledgement, explicitly tagged legacy text rather than a structured report.
 * @param request - confirmed old text with both current draft/formal baselines.
 * @returns original acknowledgement, explicitly tagged legacy text rather than a structured report.
 */
  @Remote
  researchImportLegacy(request: ImportLegacyResearchInput): DraftCommitted {
    return this.run(() =>
      this.ctx.educationRepository.research.importLegacy(
        this.actor(),
        parse(this.schemas.researchImportLegacy, request),
      ),
    )
  }
  /**
   * Read exact original evidence under current source and upstream view grants.
   * @param request - immutable selected source version.
   * @returns original text and evidence, without a creator profile.
   */
  @Remote
  researchReadSource(request: { readonly versionId: SourceVersionId }): ResearchSource {
    return this.run(() =>
      this.ctx.educationRepository.research.readSource(
        this.actor(),
        parse(this.schemas.researchReadSource, request).versionId,
      ),
    )
  }
  /**
   * Ensure a private analysis artifact in the existing project.
   * @param request - project and original write identity.
   * @returns same-project artifact receipt; the primary writing artifact is retained.
   */
  @Remote
  researchEnsureArtifact(request: EnsureResearchInput): ResearchArtifactCreated {
    return this.run(() =>
      this.ctx.educationRepository.research.ensureArtifact(
        this.actor(),
        parse(this.schemas.researchEnsureArtifact, request),
      ),
    )
  }
  /**
   * Open current structured research without issuing any supplier or model request.
   * @param request - same-owner analysis artifact.
   * @returns current report or restricted metadata.
   */
  @Remote
  researchOpen(request: { readonly artifactId: ArtifactId }): ResearchState {
    return this.run(() =>
      this.ctx.educationRepository.research.open(this.actor(), parse(this.schemas.researchOpen, request).artifactId),
    )
  }
  /**
   * Preview one immutable report version without replacing the draft.
   * @param request - explicit artifact and saved version.
   * @returns structured preview with current revocation applied.
   */
  @Remote
  researchReadVersion(request: VersionRequest): ResearchVersion {
    return this.run(() => {
      const actor = this.actor(),
        input = parse(this.schemas.researchReadVersion, request)
      if (this.ctx.educationRepository.readArtifact(actor, input.artifactId).kind !== 'text-analysis')
        throw new EducationError('resource-unavailable', 'analysis artifact is unavailable')
      const selected = this.ctx.educationRepository.readVersion(actor, input.artifactId, input.versionId)
      const { body, basisSnapshot, restricted, ...version } = selected
      if (basisSnapshot.source === 'creation-context')
        throw new EducationError('storage-unavailable', 'analysis version has writing evidence')
      return { version, restricted: restricted === true, document: restricted ? null : decodeResearchDocument(body) }
    })
  }
  /**
   * Start a source-only native research run after fixed-input and both-baseline admission.
   * @param request - source version and original explicit analysis request.
   * @returns durable run; each actual attempt is separately logged and bounded.
   */
  @Remote
  async researchStart(request: StartResearchInput): Promise<RunDTO> {
    return this.runAsync(async () => {
      const actor = this.actor(),
        input = parse(this.schemas.researchStart, request),
        invocation = this.ctx.invocation
      if (invocation === undefined) throw new EducationError('unauthenticated', 'employee invocation is missing')
      return this.runtime().startResearch(actor, input, this.ctx.educationPeers.signal(invocation.peer))
    })
  }
  /**
   * Append an immutable version of the employee-confirmed profile.
   * @param request - confirmed facts and revision.
   * @returns immutable newly saved profile.
   */
  @Remote
  profilesSaveVersion(request: SaveProfileInput): ProfileVersion {
    return this.run(() =>
      this.ctx.educationRepository.creation.saveProfile(this.actor(), parse(this.schemas.profilesSaveVersion, request)),
    )
  }
  /**
   * Read only the current employee sources and hide revoked text.
   * @param request - empty owner-scoped read.
   * @returns this employee's text sources, with revoked text hidden.
   */
  @Remote
  sourcesList(request: Record<string, never>): readonly SourceDTO[] {
    return this.run(() => {
      parse(this.schemas.sourcesList, request)
      return this.ctx.educationRepository.creation.listSources(this.actor())
    })
  }
  /**
   * Append a private source text version against its optimistic revision.
   * @param request - private text and its revision baseline.
   * @returns immutable source version.
   */
  @Remote
  sourcesSaveVersion(request: SaveSourceInput): SourceDTO {
    return this.run(() => {
      const { sourceId, ...input } = parse(this.schemas.sourcesSaveVersion, request)
      return this.ctx.educationRepository.creation.saveSource(this.actor(), {
        ...input,
        ...(sourceId === undefined ? {} : { sourceId }),
      })
    })
  }
  /**
   * Change the source grant independently of immutable text versions.
   * @param request - explicit current grant and revision.
   * @returns source after the grant changes.
   */
  @Remote
  sourcesSetAuthorization(request: AuthorizeSourceInput): SourceDTO {
    return this.run(() =>
      this.ctx.educationRepository.creation.authorizeSource(
        this.actor(),
        parse(this.schemas.sourcesSetAuthorization, request),
      ),
    )
  }
  /**
   * Report availability of the explicitly selected model route.
   * @param request - empty authenticated read.
   * @returns only availability of the configured model route.
   */
  @Remote
  async creationAvailability(
    request: Record<string, never>,
  ): Promise<{ configured: boolean; provider: string; model: string }> {
    return this.runAsync(async () => {
      parse(this.schemas.creationAvailability, request)
      this.actor()
      return this.runtime().availability()
    })
  }
  /**
   * Reserve an idempotent run before starting its native Agent.
   * @param request - original creation request and confirmed editor baseline.
   * @returns durable run; output is committed separately.
   */
  @Remote
  async creationStart(request: StartCreationInput): Promise<RunDTO> {
    return this.runAsync(async () => {
      const actor = this.actor(),
        { selection, ...input } = parse(this.schemas.creationStart, request)
      const invocation = this.ctx.invocation
      if (invocation === undefined) throw new EducationError('unauthenticated', 'employee invocation is missing')
      return this.runtime().start(
        actor,
        { ...input, ...(selection === undefined ? {} : { selection }) },
        this.ctx.educationPeers.signal(invocation.peer),
      )
    })
  }
  /**
   * Read the durable run with current source authorization applied.
   * @param request - private original run.
   * @returns current authorized run state.
   */
  @Remote
  creationGetRun(request: { readonly runId: RunId }): RunDTO {
    return this.run(() =>
      this.ctx.educationRepository.creation.getRun(this.actor(), parse(this.schemas.creationGetRun, request).runId),
    )
  }
  /**
   * Look up the original request without replaying model work.
   * @param request - original request identity.
   * @returns the original run or an unsettled absence.
   */
  @Remote
  creationFindRun(request: { readonly requestId: RequestId }): RunDTO | null {
    return this.run(() =>
      this.ctx.educationRepository.creation.findRun(
        this.actor(),
        parse(this.schemas.creationFindRun, request).requestId,
      ),
    )
  }
  /**
   * Cancel the owner-scoped run and wait for runtime cleanup.
   * @param request - private original run.
   * @returns after cancellation and owned Agent cleanup.
   */
  @Remote
  async creationCancel(request: { readonly runId: RunId }): Promise<RunDTO> {
    return this.runAsync(async () =>
      this.runtime().cancel(this.actor(), parse(this.schemas.creationCancel, request).runId),
    )
  }
  /**
   * Read the authorized conversation and fixed draft evidence.
   * @param request - private artifact.
   * @returns conversation, version basis and current run.
   */
  @Remote
  creationReadState(request: { readonly artifactId: ArtifactId }): CreationState {
    return this.run(() =>
      this.ctx.educationRepository.creation.readState(
        this.actor(),
        parse(this.schemas.creationReadState, request).artifactId,
      ),
    )
  }
  /**
   * Clear a confirmed draft while preserving immutable history.
   * @param request - explicit empty-context reset against the current draft.
   * @returns committed empty draft without altering formal history.
   */
  @Remote
  creationResetContext(request: {
    readonly artifactId: ArtifactId
    readonly expectedDraftRevision: number
    readonly requestId: RequestId
  }): DraftCommitted {
    return this.run(() => {
      const input = parse(this.schemas.creationResetContext, request)
      return this.ctx.educationRepository.creation.resetContext(
        this.actor(),
        input.artifactId,
        input.expectedDraftRevision,
        input.requestId,
      )
    })
  }
  /**
   * Resolve the original owner-scoped mutation receipt.
   * @param request - original non-model write identity.
   * @returns original authorized receipt or an unsettled absence.
   */
  @Remote
  creationMutationResult(request: {
    readonly operation: CreationMutation
    readonly requestId: RequestId
  }): CreationMutationResult | null {
    return this.run(() => {
      const input = parse(this.schemas.creationMutationResult, request)
      return this.ctx.educationRepository.creation.mutationResult(this.actor(), input.operation, input.requestId)
    })
  }
  /**
   * Apply an authorized candidate against a confirmed baseline.
   * @param request - explicit authorized candidate and new draft baseline.
   * @returns a committed run without another model call.
   */
  @Remote
  creationApplyCandidate(request: {
    readonly runId: RunId
    readonly expectedDraftRevision: number
    readonly requestId: RequestId
  }): RunDTO {
    return this.run(() => {
      const input = parse(this.schemas.creationApplyCandidate, request)
      return this.ctx.educationRepository.creation.applyCandidate(
        this.actor(),
        input.runId,
        input.expectedDraftRevision,
        input.requestId,
      )
    })
  }
  private runtime(): GenerationRuntime {
    if (this.generation === undefined)
      throw new EducationError('identity-unavailable', 'creation is not enabled or its dependencies are unavailable')
    return this.generation
  }
  private async runAsync<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      this.report(error)
      throw wireFailure(error)
    }
  }

  /**
   * Create a private project with one empty draft atomically.
   * @param request - title, scenario and original write identity.
   * @returns committed project and empty draft references.
   */
  @Remote
  projectsCreate(request: CreateProjectInput): ProjectCreated {
    return this.run(() =>
      this.ctx.educationRepository.createProject(this.actor(), parse(this.schemas.projectsCreate, request)),
    )
  }

  /**
   * List only the current employee's project summaries.
   * @param request - bounded pagination.
   * @returns this employee's project summaries.
   */
  @Remote
  projectsList(request: PageInput): Page<ProjectDTO> {
    return this.run(() => {
      const input = parse(this.schemas.projectsList, request)
      return this.ctx.educationRepository.listProjects(this.actor(), {
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      })
    })
  }

  /**
   * Reopen current business state without creating or resuming a native Agent.
   * @param request - private project.
   * @param signal - invocation cancellation.
   * @returns authoritative state and checked native bindings.
   */
  @Remote
  async projectsOpen(request: ProjectRequest, signal: AbortSignal): Promise<ProjectState> {
    try {
      return await this.open(this.actor(), parse(this.schemas.projectsOpen, request).projectId, signal)
    } catch (error) {
      this.report(error)
      throw wireFailure(error)
    }
  }

  /**
   * Commit editable text against its current revision.
   * @param request - draft and revision baseline.
   * @returns committed metadata without appending a formal version.
   */
  @Remote
  draftsSync(request: SyncDraftInput): DraftCommitted {
    return this.run(() => this.ctx.educationRepository.syncDraft(this.actor(), parse(this.schemas.draftsSync, request)))
  }

  /**
   * Append one immutable version after checking both baselines.
   * @param request - draft and formal pointer baselines.
   * @returns an immutable version reference.
   */
  @Remote
  artifactsSaveVersion(request: SaveVersionInput): VersionSaved {
    return this.run(() =>
      this.ctx.educationRepository.saveVersion(this.actor(), parse(this.schemas.artifactsSaveVersion, request)),
    )
  }

  /**
   * Page immutable version metadata for one authorized artifact.
   * @param request - artifact and bounded page.
   * @returns version summaries without full text.
   */
  @Remote
  artifactsListVersions(request: VersionPageRequest): Page<ArtifactVersionSummary> {
    return this.run(() => {
      const input = parse(this.schemas.artifactsListVersions, request)
      return this.ctx.educationRepository.listVersions(this.actor(), input.artifactId, {
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      })
    })
  }

  /**
   * Read an immutable version without changing the current draft.
   * @param request - artifact and historical version.
   * @returns that authorized immutable version.
   */
  @Remote
  artifactsReadVersion(request: VersionRequest): ArtifactVersionDTO {
    return this.run(() => {
      const input = parse(this.schemas.artifactsReadVersion, request)
      return this.ctx.educationRepository.readVersion(this.actor(), input.artifactId, input.versionId)
    })
  }

  /**
   * Restore historical text into the editable draft.
   * @param request - historical source and draft baseline.
   * @returns restored draft metadata without changing formal history.
   */
  @Remote
  draftsRestoreVersion(request: RestoreVersionInput): DraftCommitted {
    return this.run(() =>
      this.ctx.educationRepository.restoreVersion(this.actor(), parse(this.schemas.draftsRestoreVersion, request)),
    )
  }

  /**
   * Resolve an uncertain write using its original actor-bound receipt.
   * @param request - original operation and request identity.
   * @returns original authorized result or null, which does not settle a concurrent write.
   */
  @Remote
  requestsGetResult(request: ResultRequest): WriteResult | null {
    return this.run(() => {
      const input = parse(this.schemas.requestsGetResult, request)
      return this.ctx.educationRepository.getResult(this.actor(), input.operation, input.requestId)
    })
  }

  /**
   * Observe an authorized project from a baseline established after subscription.
   * @param request - private project.
   * @param signal - invocation lifetime.
   * @returns initial state then coalescible commit notifications.
   */
  @Remote({ mode: 'stream' })
  projectsFollow(request: ProjectRequest, signal: AbortSignal): AsyncIterable<ProjectFollowFrame> {
    return this.run(() => this.follow(this.actor(), parse(this.schemas.projectsFollow, request).projectId, signal))
  }

  private actor(): ActorContext {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new EducationError('unauthenticated', 'an employee invocation is required')
    return this.ctx.educationPeers.actor(invocation.peer)
  }

  private run<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      this.report(error)
      throw wireFailure(error)
    }
  }

  private async open(actor: ActorContext, projectId: ProjectId, signal: AbortSignal): Promise<ProjectState> {
    signal.throwIfAborted()
    const state = this.ctx.educationRepository.openProject(actor, projectId)
    const sessionBindings = await Promise.all(
      state.sessionBindings.map(async (binding) => {
        if (binding.status === 'invalid') return binding
        try {
          using native = await this.ctx.sessionQuery.observeSession(binding.harnessSessionId, {
            signal,
            projectionMode: 'none',
          })
          return native.header.id === binding.harnessSessionId ? binding : { ...binding, status: 'invalid' as const }
        } catch (error) {
          if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND')
            return { ...binding, status: 'invalid' as const }
          throw error
        }
      }),
    )
    signal.throwIfAborted()
    this.ctx.educationRepository.readSelf(actor)
    return { ...state, sessionBindings }
  }

  private async *follow(
    actor: ActorContext,
    projectId: ProjectId,
    signal: AbortSignal,
  ): AsyncGenerator<ProjectFollowFrame> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    const follower: Follower = { actor, projectId, pending: undefined, wake: () => {} }
    if (this.followers.size >= this.maxFollowers)
      throw wireFailure(new EducationError('rate-limited', 'project subscription limit reached'))
    this.followers.add(follower)
    const wake = () => {
      follower.wake()
    }
    lifetime.addEventListener('abort', wake, { once: true })
    try {
      yield { type: 'snapshot', state: await this.open(actor, projectId, lifetime) }
      while (!lifetime.aborted) {
        const commit = follower.pending
        if (commit === undefined) {
          await new Promise<void>((resolve) => {
            follower.wake = resolve
          })
          continue
        }
        follower.pending = undefined
        this.ctx.educationRepository.openProject(actor, projectId)
        yield { type: 'committed', projectId, operation: commit.operation, requestId: commit.requestId }
      }
    } catch (error) {
      this.report(error)
      throw wireFailure(error)
    } finally {
      lifetime.removeEventListener('abort', wake)
      this.followers.delete(follower)
    }
  }

  private claims(access: ConnectionAccess): boolean {
    if (access.kind === 'fetch') return access.url.pathname === EXPORT_TEXT_PATH
    if (access.kind === 'remote') return access.namespace === 'education' && this.remoteSchemas.has(access.method)
    return (
      access.kind === 'rpc' &&
      access.channel === '/api' &&
      access.endpoint.startsWith('education/') &&
      this.remoteSchemas.has(access.endpoint.slice('education/'.length))
    )
  }

  private authorize(actor: ActorContext, access: ConnectionAccess): boolean {
    let schema: z.ZodType | undefined
    let request: unknown
    if (access.kind === 'fetch') {
      schema = this.schemas.exportText
      request = exportParameters(access.url)
    } else if (access.kind === 'remote') {
      schema = this.remoteSchemas.get(access.method)
      request = access.args.request
    } else if (access.kind === 'rpc') {
      schema = this.remoteSchemas.get(access.endpoint.slice('education/'.length))
      request = record(record(access.payload)?.args)?.request
    }
    const checked = schema?.safeParse(request)
    if (checked?.success !== true) {
      if (schema === undefined) return false
      if (access.kind === 'fetch') return true
      const failure = wireFailure(new EducationError('validation-failed', 'business request fields are invalid'))
      if (access.kind === 'rpc') throw new ConnectionRpcError(failure)
      throw failure
    }
    const values = record(checked.data)
    if (typeof values?.projectId === 'string')
      this.ctx.educationRepository.openProject(actor, brandString<ProjectId>(values.projectId))
    if (typeof values?.artifactId === 'string')
      this.ctx.educationRepository.readArtifact(actor, brandString<ArtifactId>(values.artifactId))
    if (typeof values?.accountId === 'string')
      this.ctx.educationRepository.analytics.requireAccess(actor, brandString<ContentAccountId>(values.accountId))
    return true
  }

  private exportText(request: Request, peer: PeerScope): Response {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    try {
      request.signal.throwIfAborted()
      const actor = this.ctx.educationPeers.actor(peer)
      const input = parse(this.schemas.exportText, exportParameters(new URL(request.url)))
      const selected =
        input.target === 'draft'
          ? this.ctx.educationRepository.readDraft(actor, input.artifactId)
          : this.ctx.educationRepository.readVersion(actor, input.artifactId, input.versionId)
      if (selected.restricted)
        throw new EducationError('resource-unavailable', 'source authorization no longer permits export')
      this.ctx.educationRepository.requireArtifactExport(
        actor,
        input.artifactId,
        input.target === 'version' ? input.versionId : null,
      )
      const body = selected.body
      this.ctx.educationRepository.readSelf(actor)
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: {
          ...headers,
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(Buffer.byteLength(body, 'utf8')),
          'content-disposition': `attachment; filename="education-${input.target}-${input.artifactId}.txt"`,
        },
      })
    } catch (error) {
      this.report(error)
      const failure = wireFailure(error)
      const status =
        failure.code === 'education/INPUT_INVALID'
          ? 400
          : failure.code === 'education/UNAUTHENTICATED'
            ? 401
            : failure.code === 'education/RESOURCE_UNAVAILABLE'
              ? 403
              : 503
      return Response.json({ error: { code: failure.code, message: failure.message } }, { status, headers })
    }
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function exportParameters(url: URL): unknown {
  const entries = [...url.searchParams]
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return null
  return Object.fromEntries(entries)
}

export default EducationController
