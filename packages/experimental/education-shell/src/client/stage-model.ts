/** React-free four-entry state; private reads and original writes are fenced by identity/project generations. */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AccountGrantView,
  AccountPermissions,
  AnalyticsDataset,
  AnalyticsQuery,
  AnalyticsSchedule,
  AnalyticsWriteResult,
  ArtifactVersionId,
  ArtifactVersionSummary,
  ContentAccount,
  ContentAccountId,
  CreationMutationResult,
  KnowledgeItem,
  KnowledgeSearch,
  MetricImportPreview,
  MetricSnapshotId,
  ProjectId,
  ResearchState,
  ResearchVersion,
  RunDTO,
  RequestId,
  SourceDTO,
  SourceVersionId,
  SyncRun,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import type { WorkspaceTransport } from './model.ts'

/** Fixed native workbench destinations. */
export type WorkbenchEntry = 'writing' | 'knowledge' | 'research' | 'analytics'
/** All private state is memory-only and discarded on employee/project changes. */
export interface StageSnapshot {
  readonly entry: WorkbenchEntry
  readonly epoch: number
  readonly projectId: ProjectId | null
  readonly busy: boolean
  readonly loading: boolean
  readonly uncertain: boolean
  readonly problem: string | null
  readonly notice: 'done' | 'copied' | 'exported' | null
  readonly knowledge: readonly KnowledgeItem[]
  readonly cursor: string | null
  readonly selectedSource: SourceDTO | null
  readonly research: ResearchState | null
  readonly researchRun: RunDTO | null
  readonly reportVersions: readonly ArtifactVersionSummary[]
  readonly reportCursor: string | null
  readonly reportPreview: ResearchVersion | null
  readonly accounts: readonly ContentAccount[]
  readonly accountId: ContentAccountId | null
  readonly dataset: AnalyticsDataset | null
  readonly grants: readonly AccountGrantView[]
  readonly preview: MetricImportPreview | null
  readonly importResult: AnalyticsWriteResult | null
  readonly runs: readonly SyncRun[]
  readonly schedule: AnalyticsSchedule | null
  readonly providerReady: boolean
}
interface Bridge {
  readonly useWritingSource: (source: SourceDTO) => Promise<void>
  readonly changed: () => void
}
interface Pending {
  readonly send: () => Promise<void>
  readonly check: () => Promise<boolean>
}
const empty = (epoch: number, projectId: ProjectId | null): StageSnapshot => ({
  entry: 'writing',
  epoch,
  projectId,
  busy: false,
  loading: false,
  uncertain: false,
  problem: null,
  notice: null,
  knowledge: [],
  cursor: null,
  selectedSource: null,
  research: null,
  researchRun: null,
  reportVersions: [],
  reportCursor: null,
  reportPreview: null,
  accounts: [],
  accountId: null,
  dataset: null,
  grants: [],
  preview: null,
  importResult: null,
  runs: [],
  schedule: null,
  providerReady: false,
})
function code(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}
async function value<T>(result: Promise<RemoteResult<T>>): Promise<T> {
  const outcome = await result
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

/** Owner-bound coordinator; components receive callbacks and immutable snapshots only. */
export class StageWorkspace {
  private state = empty(0, null)
  private readonly listeners = new Set<() => void>()
  private scope = new AbortController()
  private owner = ''
  private active = false
  private disposed = false
  private sequence = 0
  private selectionSequence = 0
  private reads = 0
  private accountSequence = 0
  private pending: Pending | undefined
  private query: Omit<KnowledgeSearch, 'cursor'> = { query: '', kind: 'all', limit: 20 }
  private analyticsQuery: AnalyticsQuery | undefined
  private poll: ReturnType<typeof setTimeout> | undefined
  constructor(
    private readonly transport: WorkspaceTransport,
    private readonly bridge: Bridge,
    private readonly pollMs: number,
  ) {}
  /**
 * Return current immutable private snapshot.
 * @returns current immutable private snapshot.
 */
  readonly getSnapshot = (): StageSnapshot => this.state
  /**
 * Return exact disposer.
 * @param listener - framework-owned observer.
 * @returns exact disposer.
 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  /**
 * Discard private state when the employee or selected project changes.
 * @param identity - primary model's generation/user key, or empty after logout.
 * @param projectId - selected native project.
 */
  setOwner(identity: string, projectId: ProjectId | null): void {
    if (identity === this.owner && projectId === this.state.projectId) return
    this.scope.abort()
    this.scope = new AbortController()
    clearTimeout(this.poll)
    this.pending = undefined
    const priorEntry = identity === this.owner ? this.state.entry : 'writing'
    this.owner = identity
    this.active = identity !== ''
    this.reads = 0
    this.state = { ...empty(this.state.epoch + 1, projectId), entry: priorEntry }
    this.emit()
  }
  /** Cancel local reads and timers; durable server work remains governed by its actual authority. */
  dispose(): void {
    this.disposed = true
    this.scope.abort()
    clearTimeout(this.poll)
    this.listeners.clear()
    this.pending = undefined
    this.state = empty(this.state.epoch + 1, null)
  }
  /**
 * Open one fixed workbench entry without starting paid work.
 * @param entry - explicit fixed destination.
 */
  async navigate(entry: WorkbenchEntry): Promise<void> {
    this.patch({ entry, problem: null, notice: null })
    if (entry === 'knowledge') await this.search(this.query, false)
    if (entry === 'analytics') await this.accounts()
    if (entry === 'research') await this.openResearch()
  }
  /** Refresh visible permissions without starting a provider or model call. */
  async refresh(): Promise<void> {
    if (!this.active || this.state.busy || this.state.uncertain) return
    if (this.state.entry === 'research') {
      await this.openResearch(false)
      const selected = this.state.selectedSource?.versionId
      if (selected !== undefined) await this.selectSource(selected)
    } else if (this.state.entry === 'analytics') await this.accounts()
    else if (this.state.entry === 'knowledge') {
      const selected = this.state.selectedSource?.versionId
      await this.search(this.query, false)
      if (selected !== undefined) await this.selectSource(selected)
    }
  }
  /**
 * Search current authorized source metadata with literal keywords.
 * @param query - literal query and type.
 * @param more - explicit next page.
 */
  async search(query: Omit<KnowledgeSearch, 'cursor'>, more = false): Promise<void> {
    const epoch = this.state.epoch,
      sequence = ++this.sequence,
      cursor = more ? this.state.cursor : null
    this.query = query
    await this.read(async () => {
      const page = await value(
        this.transport.remote.knowledgeSearch({ ...query, ...(cursor === null ? {} : { cursor }) }),
      )
      if (this.current(epoch) && sequence === this.sequence)
        this.patch({ knowledge: more ? [...this.state.knowledge, ...page.items] : page.items, cursor: page.nextCursor })
    })
  }
  /**
 * Read an exact selected source version under current grants.
 * @param versionId - exact selected authorized source.
 */
  async selectSource(versionId: SourceVersionId): Promise<void> {
    const epoch = this.state.epoch,
      sequence = ++this.selectionSequence
    this.patch({ selectedSource: null })
    await this.read(async () => {
      const source = await value(this.transport.remote.knowledgeReadSourceVersion({ versionId }))
      if (this.current(epoch) && sequence === this.selectionSequence) this.patch({ selectedSource: source })
    })
  }
  /**
 * Recheck a selected source and explicitly transfer its selection to writing.
 * @param versionId - explicitly selected source; its current grants are rechecked before navigation.
 */
  async useSource(versionId: SourceVersionId): Promise<void> {
    const epoch = this.state.epoch
    await this.read(async () => {
      const source = await value(this.transport.remote.knowledgeReadSourceVersion({ versionId }))
      if (!this.current(epoch)) return
      await this.bridge.useWritingSource(source)
      if (this.current(epoch)) this.patch({ entry: 'writing' })
    })
  }
  /**
 * Save confirmed original text or an immutable transcript import.
 * @param input - confirmed source contents; updates retain the source revision baseline.
 */
  async importSource(input: {
    format: 'text' | 'research-input-v1'
    title: string
    content: string
    sourceUrl: string
    edit: boolean
  }): Promise<void> {
    const selected = input.edit ? this.state.selectedSource : null
    if (input.edit && selected === null) return
    const request = {
      format: input.format,
      title: input.title,
      content: input.content,
      sourceUrl: input.sourceUrl,
      ...(selected === null ? {} : { sourceId: selected.id }),
      expectedRevision: selected?.revision ?? 0,
      requestId: this.transport.requestId(),
      confirmed: true as const,
    }
    await this.mutate(
      () => this.transport.remote.researchImportSource(request),
      () => this.sourceReceipt(request.requestId),
      async (source) => {
        this.patch({ selectedSource: source })
        this.bridge.changed()
        await this.search(this.query)
      },
    )
  }
  /**
 * Change the current source grant using its displayed revision.
 * @param authorized - explicit source authorization change.
 */
  async authorizeSource(authorized: boolean): Promise<void> {
    const source = this.state.selectedSource
    if (source === null) return
    const request = {
      sourceId: source.id,
      authorized,
      expectedAuthorizationRevision: source.authorizationRevision,
      requestId: this.transport.requestId(),
    }
    await this.mutate(
      () => this.transport.remote.sourcesSetAuthorization(request),
      () => this.sourceReceipt(request.requestId, 'sources.authorize'),
      async (result) => {
        this.patch({ selectedSource: result.authorized ? result : null, research: null, reportPreview: null })
        this.bridge.changed()
        await this.search(this.query)
      },
    )
  }
  /**
 * Open the current same-project report without model execution.
 * @param create - whether explicit navigation may ensure the one same-project artifact.
 */
  async openResearch(create = true): Promise<void> {
    if (this.state.projectId === null) return
    if (this.state.research === null && create) {
      const request = { projectId: this.state.projectId, requestId: this.transport.requestId() }
      await this.mutate(
        () => this.transport.remote.researchEnsureArtifact(request),
        async () => {
          const result = await value(
            this.transport.remote.requestsGetResult({ operation: 'artifacts.create', requestId: request.requestId }),
          )
          return { ok: true, value: result?.operation === 'artifacts.create' ? result : null }
        },
        async (result) => {
          await this.loadResearch(result.artifactId)
          await this.versions()
        },
      )
    } else {
      const research = this.state.research
      if (research !== null) await this.read(async () => { await this.loadResearch(research.artifact.id) })
    }
  }
  /**
 * Start one explicitly requested source-only research run.
 * @param instruction - explicit source-only research request.
 */
  async analyze(instruction: string): Promise<void> {
    const research = this.state.research,
      source = this.state.selectedSource
    if (research === null || source === null) return
    const request = {
      artifactId: research.artifact.id,
      sourceVersionId: source.versionId,
      expectedDraftRevision: research.draft.revision,
      expectedLatestVersionId: research.artifact.latestVersionId,
      instruction,
      requestId: this.transport.requestId(),
    }
    await this.mutate(
      () => this.transport.remote.researchStart(request),
      () => this.transport.remote.creationFindRun({ requestId: request.requestId }),
      (run) => {
        this.patch({ researchRun: run, reportPreview: null })
        this.pollResearch()
      },
    )
  }
  /** Stop the current owned research interval. */
  async cancelResearch(): Promise<void> {
    const run = this.state.researchRun
    if (run !== null)
      await this.read(async () => {
        const result = await value(this.transport.remote.creationCancel({ runId: run.id }))
        this.patch({ researchRun: result })
      })
  }
  /** Save the exact validated research draft with both formal/draft baselines. */
  async saveResearch(): Promise<void> {
    const state = this.state.research
    if (state === null || state.draft.restricted || !state.draft.body) return
    const request = {
      artifactId: state.artifact.id,
      expectedDraftRevision: state.draft.revision,
      expectedLatestVersionId: state.artifact.latestVersionId,
      requestId: this.transport.requestId(),
    }
    await this.mutate(
      () => this.transport.remote.artifactsSaveVersion(request),
      async () => {
        const result = await value(
          this.transport.remote.requestsGetResult({ operation: 'artifacts.saveVersion', requestId: request.requestId }),
        )
        return { ok: true, value: result?.operation === 'artifacts.saveVersion' ? result : null }
      },
      async () => {
        await this.loadResearch(state.artifact.id)
        await this.versions()
      },
    )
  }
  /**
 * Migrate confirmed old text into an explicitly labeled legacy draft.
 * @param text - explicitly confirmed old report text.
 * @param originId - caller-recorded old report identity.
 */
  async importLegacy(text: string, originId: string): Promise<void> {
    const state = this.state.research
    if (state === null) return
    const request = {
      artifactId: state.artifact.id,
      text,
      originId,
      expectedDraftRevision: state.draft.revision,
      expectedLatestVersionId: state.artifact.latestVersionId,
      requestId: this.transport.requestId(),
      confirmed: true as const,
    }
    await this.mutate(
      () => this.transport.remote.researchImportLegacy(request),
      async () => {
        const result = await value(
          this.transport.remote.requestsGetResult({ operation: 'drafts.sync', requestId: request.requestId }),
        )
        return { ok: true, value: result?.operation === 'drafts.sync' ? result : null }
      },
      async () => {
        this.patch({ reportPreview: null })
        await this.loadResearch(state.artifact.id)
      },
    )
  }
  /**
 * Read the selected report history without replacing its draft.
 * @param more - load another bounded history page.
 */
  async versions(more = false): Promise<void> {
    const state = this.state.research
    if (state === null) return
    const epoch = this.state.epoch,
      cursor = more ? this.state.reportCursor : null
    await this.read(async () => {
      const result = await value(
        this.transport.remote.artifactsListVersions({
          artifactId: state.artifact.id,
          limit: 20,
          ...(cursor === null ? {} : { cursor }),
        }),
      )
      if (this.current(epoch))
        this.patch({
          reportVersions: more ? [...this.state.reportVersions, ...result.items] : result.items,
          reportCursor: result.nextCursor,
        })
    })
  }
  /**
 * Read a selected immutable report under current grants.
 * @param versionId - immutable report version, or null to return to the draft.
 */
  async previewReport(versionId: ArtifactVersionId | null): Promise<void> {
    const state = this.state.research,
      epoch = this.state.epoch,
      sequence = ++this.selectionSequence
    this.patch({ reportPreview: null })
    if (state === null || versionId === null) return
    await this.read(async () => {
      const result = await value(
        this.transport.remote.researchReadVersion({ artifactId: state.artifact.id, versionId }),
      )
      if (this.current(epoch) && sequence === this.selectionSequence) this.patch({ reportPreview: result })
    })
  }
  /** Restore only after an explicit UI confirmation; historical versions remain immutable. */
  async restoreReport(): Promise<void> {
    const state = this.state.research,
      preview = this.state.reportPreview
    if (state === null || preview === null || preview.restricted) return
    const request = {
      artifactId: state.artifact.id,
      versionId: preview.version.id,
      expectedDraftRevision: state.draft.revision,
      requestId: this.transport.requestId(),
    }
    await this.mutate(
      () => this.transport.remote.draftsRestoreVersion(request),
      async () => {
        const result = await value(
          this.transport.remote.requestsGetResult({ operation: 'drafts.restoreVersion', requestId: request.requestId }),
        )
        return { ok: true, value: result?.operation === 'drafts.restoreVersion' ? result : null }
      },
      async () => {
        this.patch({ reportPreview: null })
        await this.loadResearch(state.artifact.id)
      },
    )
  }
  /**
 * Reauthorize export before copying or downloading the selected report.
 * @param copy - copy only after a fresh server export check, otherwise download.
 */
  async exportResearch(copy: boolean): Promise<void> {
    const state = this.state.research,
      preview = this.state.reportPreview,
      epoch = this.state.epoch
    if (state === null) return
    await this.read(async () => {
      const blob = await this.transport.download(
        preview === null
          ? { artifactId: state.artifact.id, target: 'draft' }
          : { artifactId: state.artifact.id, target: 'version', versionId: preview.version.id },
        this.scope.signal,
      )
      if (!this.current(epoch)) return
      if (copy) {
        const text = await blob.text()
        if (!this.current(epoch)) return
        await navigator.clipboard.writeText(text)
      } else download(blob, 'research-report.json')
      if (this.current(epoch)) this.patch({ notice: copy ? 'copied' : 'exported' })
    })
  }
  /**
 * Transfer one saved creative direction as a reference source.
 * @param direction - direction index from the explicitly previewed or latest saved report.
 */
  async transferResearch(direction: number): Promise<void> {
    const state = this.state.research,
      versionId = this.state.reportPreview?.version.id ?? state?.artifact.latestVersionId
    if (state === null || versionId === null || versionId === undefined) return
    if (this.state.reportPreview === null && state.draft.bodyHash !== state.latestVersion?.bodyHash) return
    const request = { artifactId: state.artifact.id, versionId, direction, requestId: this.transport.requestId() }
    await this.mutate(
      () => this.transport.remote.researchTransfer(request),
      () => this.sourceReceipt(request.requestId),
      async (source) => {
        await this.bridge.useWritingSource(source)
        this.patch({ entry: 'writing' })
        this.bridge.changed()
      },
    )
  }
  /** Load only safe saved account metadata and selected-account observations. */
  async accounts(): Promise<void> {
    const epoch = this.state.epoch
    await this.read(async () => {
      const [accounts, availability] = await Promise.all([
        value(this.transport.remote.analyticsAccountsList({})),
        value(this.transport.remote.analyticsAvailability({})),
      ])
      if (!this.current(epoch)) return
      const selected = accounts.find(account => account.id === this.state.accountId)
      this.patch({ accounts, providerReady: availability.configured })
      if (selected === undefined)
        this.patch({ accountId: null, dataset: null, grants: [], preview: null, runs: [], schedule: null })
      else await this.selectAccount(selected.id, false)
    })
  }
  /**
 * Discard prior-account content and load current authorized observations.
 * @param accountId - explicitly selected private account.
 * @param reset - clear previous-account private data immediately.
 */
  async selectAccount(accountId: ContentAccountId, reset = true): Promise<void> {
    const sequence = ++this.accountSequence,
      epoch = this.state.epoch,
      account = this.state.accounts.find(item => item.id === accountId)
    if (account === undefined) return
    if (reset || this.state.accountId !== accountId)
      this.patch({ accountId, dataset: null, grants: [], preview: null, importResult: null, runs: [], schedule: null })
    const query: AnalyticsQuery =
      this.analyticsQuery?.accountId === accountId
        ? this.analyticsQuery
        : { accountId, source: 'redfox', mode: 'latest', keyword: '' }
    await this.read(async () => {
      const [dataset, grants, runs, schedule] = await Promise.all([
        account.permissions.view ? value(this.transport.remote.analyticsQuery(query)) : null,
        account.permissions.manage ? value(this.transport.remote.analyticsAccountGrants({ accountId })) : [],
        value(this.transport.remote.analyticsSyncList({ accountId })),
        value(this.transport.remote.analyticsScheduleRead({ accountId })),
      ])
      if (this.current(epoch) && sequence === this.accountSequence) {
        this.analyticsQuery = query
        this.patch({ dataset, grants, runs, schedule })
      }
    })
  }
  /**
 * Create a default-private account through an original request.
 * @param input - explicit account platform/id/name.
 */
  async createAccount(input: { platform: 'douyin' | 'xiaohongshu'; externalId: string; title: string }): Promise<void> {
    const request = { ...input, requestId: this.transport.requestId() }
    await this.mutate(
      () => this.transport.remote.analyticsAccountCreate(request),
      () =>
        this.transport.remote.analyticsMutationResult({ operation: 'accounts.create', requestId: request.requestId }),
      async (result) => {
        await this.accounts()
        await this.selectAccount(result.accountId)
      },
    )
  }
  /**
 * Filter saved observations without calling a supplier.
 * @param query - source and display-only filters; no provider request is made.
 */
  async queryAnalytics(query: Omit<AnalyticsQuery, 'accountId'>): Promise<void> {
    if (this.state.accountId === null) return
    this.analyticsQuery = { ...query, accountId: this.state.accountId }
    await this.selectAccount(this.state.accountId, false)
  }
  /**
 * Prepare a bounded immutable import preview without committing metric rows.
 * @param input - explicit data file, source label and observation instant.
 */
  async previewImport(input: { content: string; sourceLabel: string; observedAt: string }): Promise<void> {
    if (this.state.accountId === null) return
    const request = { ...input, accountId: this.state.accountId, requestId: this.transport.requestId() }
    await this.mutate(
      () => this.transport.remote.analyticsImportPreview(request),
      () => Promise.resolve({ ok: true, value: null }),
      async (preview) => {
        this.patch({ preview, importResult: null })
      },
    )
  }
  /**
 * Commit only the explicitly confirmed preview and accepted partial-import choice.
 * @param allowPartial - explicit acceptance of only valid rows.
 */
  async confirmImport(allowPartial: boolean): Promise<void> {
    const preview = this.state.preview
    if (preview === null) return
    const request = {
      importId: preview.id,
      expectedFileHash: preview.fileHash,
      allowPartial,
      requestId: this.transport.requestId(),
    }
    await this.mutate(
      () => this.transport.remote.analyticsImportCommit(request),
      () =>
        this.transport.remote.analyticsMutationResult({ operation: 'imports.commit', requestId: request.requestId }),
      async (result) => {
        this.patch({ importResult: result, preview: null })
        this.analyticsQuery = { accountId: preview.accountId, source: preview.source, mode: 'latest', keyword: '' }
        await this.selectAccount(preview.accountId, false)
      },
    )
  }
  /**
 * Save independent account privileges against the current grant revision.
 * @param input - explicit account-specific independent grant choice.
 */
  async grant(input: { username: string; permissions: AccountPermissions; expectedRevision: number }): Promise<void> {
    if (this.state.accountId === null) return
    const request = { ...input, accountId: this.state.accountId, requestId: this.transport.requestId() }
    await this.mutate(
      () => this.transport.remote.analyticsAccountSetGrant(request),
      () =>
        this.transport.remote.analyticsMutationResult({ operation: 'accounts.grant', requestId: request.requestId }),
      async () => {
        await this.accounts()
      },
    )
  }
  /**
 * Change account enablement and advance its authorization baseline.
 * @param enabled - explicit account enablement, which advances authorization revisions.
 */
  async enableAccount(enabled: boolean): Promise<void> {
    const account = this.state.accounts.find(item => item.id === this.state.accountId)
    if (account === undefined) return
    const request = {
      accountId: account.id,
      enabled,
      expectedRevision: account.revision,
      requestId: this.transport.requestId(),
    }
    await this.mutate(
      () => this.transport.remote.analyticsAccountSetEnabled(request),
      () =>
        this.transport.remote.analyticsMutationResult({ operation: 'accounts.enable', requestId: request.requestId }),
      async () => {
        await this.accounts()
      },
    )
  }
  /**
 * Register an explicit metered scope under deployment-controlled limits.
 * @param mode - explicit metered synchronization scope.
 */
  async sync(mode: 'latest' | 'seven-days'): Promise<void> {
    if (this.state.accountId === null) return
    const request = { accountId: this.state.accountId, mode, requestId: this.transport.requestId() }
    await this.mutate(
      () => this.transport.remote.analyticsSyncRequest(request),
      () => this.transport.remote.analyticsSyncFind({ requestId: request.requestId }),
      async () => {
        await this.selectAccount(request.accountId, false)
      },
    )
  }
  /**
 * Stop a run or acknowledge an externally reconciled unknown result.
 * @param run - visible original run.
 * @param reviewed - explicit management acknowledgement of a supplier-reconciled unknown result.
 */
  async stopSync(run: SyncRun, reviewed = false): Promise<void> {
    await this.read(async () => {
      await value(
        reviewed
          ? this.transport.remote.analyticsSyncReviewUnknown({ runId: run.id, confirmed: true })
          : this.transport.remote.analyticsSyncCancel({ runId: run.id }),
      )
      if (this.state.accountId !== null) await this.selectAccount(this.state.accountId, false)
    })
  }
  /**
 * Persist explicit offline business authority and a daily local execution time.
 * @param input - explicit persistent offline authorization and selected local time.
 */
  async schedule(input: { enabled: boolean; hour: number; minute: number; timeZone: string }): Promise<void> {
    if (this.state.accountId === null) return
    const request = {
      ...input,
      accountId: this.state.accountId,
      expectedRevision: this.state.schedule?.revision ?? 0,
      requestId: this.transport.requestId(),
    }
    await this.mutate(
      () => this.transport.remote.analyticsScheduleSave(request),
      () =>
        this.transport.remote.analyticsMutationResult({ operation: 'schedules.save', requestId: request.requestId }),
      async () => {
        await this.selectAccount(request.accountId, false)
      },
    )
  }
  /** Download fresh data under current export grants. */
  async exportAnalytics(): Promise<void> {
    const query = this.analyticsQuery,
      epoch = this.state.epoch
    if (query === undefined) return
    await this.read(async () => {
      const result = await value(this.transport.remote.analyticsExport(query))
      if (this.current(epoch)) {
        download(
          new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }),
          'analytics-observations.json',
        )
        this.patch({ notice: 'exported' })
      }
    })
  }
  /**
 * Transfer a saved observation without treating metrics or titles as original text.
 * @param snapshotId - immutable selected observation.
 * @param target - explicit target entry.
 * @param originalText - required actual original for research.
 */
  async transferAnalytics(
    snapshotId: MetricSnapshotId,
    target: 'writing' | 'research',
    originalText: string,
  ): Promise<void> {
    if (this.state.projectId === null) return
    const request = {
      snapshotId,
      target,
      originalText,
      projectId: this.state.projectId,
      requestId: this.transport.requestId(),
    }
    await this.mutate(
      () => this.transport.remote.analyticsTransfer(request),
      () => this.sourceReceipt(request.requestId),
      async (source) => {
        this.patch({ selectedSource: source })
        this.bridge.changed()
        if (target === 'writing') {
          await this.bridge.useWritingSource(source)
          this.patch({ entry: 'writing' })
        } else {
          this.patch({ entry: 'research' })
          await this.loadOrEnsureResearch()
        }
      },
    )
  }
  /**
 * Query the original write before an explicit retry of the identical request.
 * @param retry - explicit original-key retry only after a null original-result check.
 */
  async resolve(retry = false): Promise<void> {
    const pending = this.pending
    if (pending === undefined || this.state.busy) return
    this.patch({ busy: true })
    try {
      if (!(await pending.check()) && retry) await pending.send()
    } catch (error) {
      this.fail(error)
    } finally {
      this.patch({ busy: false })
    }
  }
  private async loadOrEnsureResearch(): Promise<void> {
    // The transfer receipt has committed; a separate explicit ensure is safe and has its own original key.
    const projectId = this.state.projectId,
      epoch = this.state.epoch
    if (projectId === null) return
    const result = await value(
      this.transport.remote.researchEnsureArtifact({ projectId, requestId: this.transport.requestId() }),
    )
    if (this.current(epoch)) {
      await this.loadResearch(result.artifactId)
      await this.versions()
    }
  }
  private async loadResearch(artifactId: ResearchState['artifact']['id']): Promise<void> {
    const epoch = this.state.epoch,
      result = await value(this.transport.remote.researchOpen({ artifactId }))
    if (!this.current(epoch)) return
    this.patch({ research: result, ...(result.draft.restricted ? { reportPreview: null, selectedSource: null } : {}) })
  }
  private pollResearch(): void {
    clearTimeout(this.poll)
    const epoch = this.state.epoch,
      run = this.state.researchRun
    if (run === null || !['pending', 'running'].includes(run.status)) return
    this.poll = setTimeout(() => {
      void this.read(async () => {
        const result = await value(this.transport.remote.creationGetRun({ runId: run.id }))
        if (!this.current(epoch)) return
        this.patch({ researchRun: result })
        if (this.state.research !== null) await this.loadResearch(this.state.research.artifact.id)
        this.pollResearch()
      })
    }, this.pollMs)
  }
  private async sourceReceipt(
    requestId: RequestId,
    operation: 'sources.save' | 'sources.authorize' = 'sources.save',
  ): Promise<RemoteResult<SourceDTO | null>> {
    const result: CreationMutationResult | null = await value(
      this.transport.remote.creationMutationResult({ operation, requestId }),
    )
    return { ok: true, value: result !== null && 'versionId' in result ? result : null }
  }
  private async mutate<T>(
    send: () => Promise<RemoteResult<T>>,
    lookup: () => Promise<RemoteResult<T | null>>,
    complete: (result: T) => Promise<void> | void,
  ): Promise<void> {
    if (!this.active || this.state.busy || this.pending !== undefined) return
    const epoch = this.state.epoch
    const finish = async (result: T) => {
      if (!this.current(epoch)) return
      this.pending = undefined
      this.patch({ uncertain: false, problem: null, notice: 'done' })
      await complete(result)
    }
    const pending: Pending = {
      send: async () => {
        await finish(await value(send()))
      },
      check: async () => {
        const result = await value(lookup())
        if (result === null || !this.current(epoch)) return false
        await finish(result)
        return true
      },
    }
    this.pending = pending
    this.patch({ busy: true, problem: null, notice: null })
    try {
      await pending.send()
    } catch (error) {
      if (this.current(epoch)) {
        const known = code(error)?.startsWith('education/') === true
        if (known) this.pending = undefined
        this.patch({ uncertain: !known })
        this.fail(error)
      }
    } finally {
      if (this.current(epoch)) this.patch({ busy: false })
    }
  }
  private async read(work: () => Promise<void>): Promise<void> {
    if (!this.active) return
    const epoch = this.state.epoch
    this.reads++
    this.patch({ loading: true })
    try {
      await work()
    } catch (error) {
      if (this.current(epoch)) this.fail(error)
    } finally {
      if (this.current(epoch)) {
        this.reads--
        this.patch({ loading: this.reads > 0 })
      }
    }
  }
  private fail(error: unknown): void {
    const reason = code(error)
    if (reason === 'education/RESOURCE_UNAVAILABLE' || reason === 'education/UNAUTHENTICATED')
      this.patch({
        selectedSource: null,
        research: null,
        researchRun: null,
        reportVersions: [],
        reportPreview: null,
        dataset: null,
        grants: [],
        preview: null,
        runs: [],
        schedule: null,
        knowledge: [],
        accounts: [],
        accountId: null,
      })
    this.patch({ problem: reason ?? 'failed' })
  }
  private current(epoch: number): boolean {
    return !this.disposed && this.active && epoch === this.state.epoch
  }
  private patch(value: Partial<StageSnapshot>): void {
    if (!this.disposed) {
      this.state = { ...this.state, ...value }
      this.emit()
    }
  }
  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
