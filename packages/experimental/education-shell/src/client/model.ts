/** React-free employee workspace. No draft is persisted in browser storage. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { RemoteResult, RemoteStreamHandle, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-experimental-education-controller/remote'
import type { ExportTextRequest, ProjectFollowFrame } from '@deepseek-ai/dsh-experimental-education-controller/types'
import type {
  ArtifactVersionDTO,
  ArtifactVersionSummary,
  ProjectDTO,
  ProjectId,
  ProjectState,
  RequestId,
  UserDTO,
  WriteOperation,
  WriteResult,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import type {
  CreationMutation,
  CreationMutationResult,
  CreationScenario,
  CreationState,
  ProfileContent,
  ProfileVersion,
  RunDTO,
  SourceDTO,
  SourceVersionId,
  StartCreationInput,
  TextSelection,
} from '@deepseek-ai/dsh-experimental-education-platform/types'

/** Generated business API, kept outside React. */
export type EducationRemote = TypertRemoteNamespaceMap['education']
/** Explicit lifecycle and recovery states, rendered through localized copy. */
export type Problem = 'failed' | 'conflict' | 'unknown' | 'changed' | 'signedOut' | 'invalid' | 'unavailable'
/** Narrow external adapters; tests replace the carrier, never the state machine. */
export interface WorkspaceTransport {
  readonly remote: EducationRemote
  identity(
    action: 'me' | 'sign-in' | 'sign-out',
    signal: AbortSignal,
    credentials?: { username: string; password: string },
  ): Promise<UserDTO | null>
  download(request: ExportTextRequest, signal: AbortSignal): Promise<Blob>
  requestId(): RequestId
}
/** Immutable view snapshot owned by one identity generation. */
export interface WorkspaceSnapshot {
  readonly recommendedSourceVersionId: SourceVersionId | null
  readonly profile: ProfileVersion | null
  readonly sources: readonly SourceDTO[]
  readonly creation: CreationState | null
  readonly run: RunDTO | null
  readonly modelConfigured: boolean | null
  readonly syncing: boolean
  readonly user: UserDTO | null
  readonly generation: number
  readonly busy: boolean
  readonly projects: readonly ProjectDTO[]
  readonly projectsCursor: string | null
  readonly project: ProjectState | null
  readonly text: string
  readonly dirty: boolean
  readonly versions: readonly ArtifactVersionSummary[]
  readonly versionsCursor: string | null
  readonly preview: ArtifactVersionDTO | null
  readonly problem: Problem | null
  readonly uncertain: boolean
  readonly notice: 'synced' | 'saved' | 'restored' | 'exported' | null
  readonly noticeId: number
}
interface PendingWrite {
  readonly operation: WriteOperation
  readonly requestId: RequestId
  readonly send: () => Promise<RemoteResult<WriteResult>>
  readonly complete: (value: WriteResult) => Promise<void> | void
}
interface PendingContext {
  readonly operation: CreationMutation
  readonly requestId: RequestId
  readonly send: () => Promise<RemoteResult<CreationMutationResult>>
  readonly complete: (value: CreationMutationResult) => Promise<void>
}
const empty = (generation: number): WorkspaceSnapshot => ({
  recommendedSourceVersionId: null,
  profile: null,
  sources: [],
  creation: null,
  run: null,
  modelConfigured: null,
  syncing: false,
  user: null,
  generation,
  busy: false,
  projects: [],
  projectsCursor: null,
  project: null,
  text: '',
  dirty: false,
  versions: [],
  versionsCursor: null,
  preview: null,
  problem: null,
  uncertain: false,
  notice: null,
  noticeId: 0,
})
const normalized = (text: string): string => text.replace(/\r\n/g, '\n')

/** Owns request fencing, subscriptions, editor baselines and uncertain write receipts. */
export class EducationWorkspace {
  private snapshot = empty(0)
  private readonly listeners = new Set<() => void>()
  private identityScope = new AbortController()
  private projectScope = new AbortController()
  private stream: RemoteStreamHandle<ProjectFollowFrame, never> | undefined
  private pending: PendingWrite | undefined
  private readSequence = 0
  private previewSequence = 0
  private disposed = false
  private autosyncTimer: ReturnType<typeof setTimeout> | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private autoInFlight: Promise<void> | undefined
  private composing = false
  private pendingCreation: StartCreationInput | undefined
  private pendingContext: PendingContext | undefined
  private creationSequence = 0

  constructor(
    private readonly transport: WorkspaceTransport,
    private readonly options: { autoSyncDelayMs?: number; runPollIntervalMs?: number } = {},
  ) {}
  /** Stable observable read for the framework renderer. */
  readonly getSnapshot = (): WorkspaceSnapshot => this.snapshot
  /**
 * Select an explicitly transferred currently authorized reference for writing.
 * @param versionId - explicitly transferred current source; selection never starts generation.
 */
  recommendSource(versionId: SourceVersionId): void {
    if (this.snapshot.sources.some(source => source.versionId === versionId && source.authorized))
      this.patch({ recommendedSourceVersionId: versionId })
  }
  /** Framework-owned rendering subscribes here; components never subscribe themselves. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private patch(value: Partial<WorkspaceSnapshot>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...value }
    for (const listener of this.listeners) listener()
  }
  private current(generation: number): boolean {
    return !this.disposed && generation === this.snapshot.generation
  }
  private clear(): number {
    clearTimeout(this.autosyncTimer)
    clearTimeout(this.pollTimer)
    this.pendingCreation = undefined
    this.pendingContext = undefined
    this.autoInFlight = undefined
    this.composing = false
    this.identityScope.abort()
    this.projectScope.abort()
    this.stream?.dispose()
    this.stream = undefined
    this.pending = undefined
    this.readSequence++
    this.previewSequence++
    this.creationSequence++
    this.identityScope = new AbortController()
    this.projectScope = new AbortController()
    const generation = this.snapshot.generation + 1
    this.snapshot = empty(generation)
    this.patch({})
    return generation
  }
  private allowed(): boolean {
    return (
      this.snapshot.user !== null &&
      !this.snapshot.busy &&
      !this.pending &&
      !this.pendingCreation &&
      !this.pendingContext &&
      !this.disposed
    )
  }
  private report(error: unknown): void {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code === 'education/UNAUTHENTICATED' || code === 'unauthenticated') {
      this.clear()
      this.patch({ problem: 'signedOut' })
    } else if (
      code === 'education/DRAFT_CONFLICT' ||
      code === 'education/VERSION_CONFLICT' ||
      code === 'education/IDEMPOTENCY_CONFLICT'
    ) {
      this.patch({ problem: 'conflict' })
    } else if (code === 'education/INPUT_INVALID') this.patch({ problem: 'invalid' })
    else if (code === 'education/RESOURCE_UNAVAILABLE') this.patch({ problem: 'unavailable' })
    else this.patch({ problem: 'failed' })
  }
  private async value<T>(result: Promise<RemoteResult<T>>): Promise<T> {
    const generation = this.snapshot.generation
    try {
      const outcome = await result
      if (!outcome.ok) throw outcome.error
      return outcome.value
    } catch (error) {
      // Native HTTP admission can reject before a business error is decoded.
      if (this.current(generation)) await this.checkIdentity()
      throw error
    }
  }
  /**
   * Bootstrap or explicitly recheck identity; always removes prior private state first.
   * @param credentials - explicit login fields; omit to recheck the current cookie.
   */
  async authenticate(credentials?: { username: string; password: string }): Promise<void> {
    const generation = this.clear()
    this.patch({ busy: true })
    try {
      const user = await this.transport.identity(credentials ? 'sign-in' : 'me', this.identityScope.signal, credentials)
      if (!this.current(generation)) return
      this.patch({ user })
      if (user) await this.loadProjects(false, generation)
    } catch (error) {
      if (this.current(generation)) this.report(error)
    } finally {
      if (this.current(generation)) this.patch({ busy: false })
    }
  }
  /** Local cleanup is immediate, even when the server cannot confirm logout. */
  async signOut(): Promise<void> {
    const generation = this.clear()
    this.patch({ busy: true })
    try {
      await this.transport.identity('sign-out', this.identityScope.signal)
    } catch {
      if (this.current(generation)) this.patch({ problem: 'failed' })
    } finally {
      if (this.current(generation)) this.patch({ busy: false })
    }
  }
  /** Clear stale data on carrier loss; the next generation must recheck the cookie. */
  invalidate(): void {
    this.clear()
    this.patch({ problem: 'signedOut' })
  }
  /** Revalidate cookies on focus/reconnect without discarding same-account unsynced edits. */
  async checkIdentity(): Promise<void> {
    const generation = this.snapshot.generation
    try {
      const user = await this.transport.identity('me', this.identityScope.signal)
      if (!this.current(generation)) return
      if (user?.id !== this.snapshot.user?.id || user?.organizationId !== this.snapshot.user?.organizationId) {
        this.clear()
        this.patch({ problem: 'signedOut' })
      }
    } catch {
      /* A network outage does not prove logout; retain unsynced text. */
    }
  }
  private async loadProjects(more: boolean, generation: number): Promise<void> {
    const cursor = more ? this.snapshot.projectsCursor : null
    if (more && !cursor) return
    const page = await this.value(this.transport.remote.projectsList({ limit: 30, ...(cursor ? { cursor } : {}) }))
    if (this.current(generation))
      this.patch({
        projects: more ? [...this.snapshot.projects, ...page.items] : page.items,
        projectsCursor: page.nextCursor,
      })
  }
  /**
   * Reload list metadata without touching editor text.
   * @param more - append the next owner-scoped page instead of replacing the catalog.
   */
  async list(more = false): Promise<void> {
    if (!this.allowed()) return
    const generation = this.snapshot.generation
    this.patch({ busy: true, problem: null })
    try {
      await this.loadProjects(more, generation)
    } catch (error) {
      if (this.current(generation)) this.report(error)
    } finally {
      if (this.current(generation)) this.patch({ busy: false })
    }
  }
  /**
   * Open only after the caller explicitly handles any dirty editor.
   * @param projectId - selected project whose ownership the Host verifies.
   * @param discard - caller has explicitly confirmed loss of local edits.
   */
  async open(projectId: ProjectId, discard = false): Promise<void> {
    if (!this.allowed() || (this.snapshot.dirty && !discard)) return
    const generation = this.snapshot.generation
    this.patch({ busy: true, problem: null })
    try {
      await this.openInternal(projectId, generation)
    } catch (error) {
      if (this.current(generation)) this.report(error)
    } finally {
      if (this.current(generation)) this.patch({ busy: false })
    }
  }
  private async openInternal(projectId: ProjectId, generation: number): Promise<void> {
    this.creationSequence++
    clearTimeout(this.pollTimer)
    clearTimeout(this.autosyncTimer)
    this.projectScope.abort()
    this.stream?.dispose()
    this.projectScope = new AbortController()
    const sequence = ++this.readSequence
    const state = await this.value(this.transport.remote.projectsOpen({ projectId }, this.projectScope.signal))
    if (!this.current(generation) || sequence !== this.readSequence) return
    this.patch({
      project: state,
      text: state.draft.body,
      dirty: false,
      versions: [],
      versionsCursor: null,
      preview: null,
      creation: null,
      run: null,
    })
    this.follow(projectId, generation)
    await this.loadVersions(false, generation)
  }
  private follow(projectId: ProjectId, generation: number): void {
    const signal = this.projectScope.signal
    const stream = this.transport.remote.projectsFollow({ projectId }, signal)
    this.stream = stream
    void (async () => {
      try {
        for await (const frame of stream) {
          if (!this.current(generation) || signal.aborted) break
          // Notifications never replace editor text or advance its CAS baseline.
          if (frame.type === 'snapshot') {
            const state = this.snapshot.project
            if (
              state &&
              (frame.state.draft.revision !== state.draft.revision ||
                frame.state.artifact.latestVersionId !== state.artifact.latestVersionId)
            )
              this.patch({ problem: 'changed' })
          } else if (this.pending?.requestId !== frame.requestId) this.patch({ problem: 'changed' })
        }
        if (this.current(generation) && !signal.aborted) this.patch({ problem: 'changed' })
      } catch (error) {
        if (this.current(generation) && !signal.aborted) this.report(error)
      }
    })()
  }
  /**
   * Editing is retained across reads, failures and project-panel unmounts.
   * @param text - editor text, normalized only when synchronizing to the Host.
   */
  edit(text: string): void {
    if (
      !this.snapshot.project ||
      this.snapshot.busy ||
      (this.pending && !this.snapshot.syncing) ||
      this.generating() ||
      this.snapshot.project.draft.restricted
    )
      return
    this.patch({ text, dirty: normalized(text) !== this.snapshot.project.draft.body, notice: null })
    this.scheduleAutosync()
  }
  /**
   * Suspend automatic synchronization while an IME composition is active.
   * @param composing - whether an IME composition is active; composition text is never synchronized early.
   */
  setComposing(composing: boolean): void {
    this.composing = composing
    if (composing) clearTimeout(this.autosyncTimer)
    else this.scheduleAutosync()
  }
  private generating(): boolean {
    return this.snapshot.run?.status === 'pending' || this.snapshot.run?.status === 'running'
  }
  private scheduleAutosync(): void {
    clearTimeout(this.autosyncTimer)
    const delay = this.options.autoSyncDelayMs
    if (
      !delay ||
      this.composing ||
      !this.snapshot.dirty ||
      this.autoInFlight ||
      this.snapshot.uncertain ||
      this.generating()
    )
      return
    this.autosyncTimer = setTimeout(() => {
      if (!this.allowed() || this.composing) return
      const generation = this.snapshot.generation
      this.patch({ syncing: true })
      let succeeded = false
      this.autoInFlight = (async () => {
        try {
          succeeded = await this.syncInternal(generation)
        } catch (error) {
          if (this.current(generation)) this.report(error)
        } finally {
          if (this.current(generation)) {
            this.autoInFlight = undefined
            this.patch({ syncing: false })
            if (succeeded) this.scheduleAutosync()
          }
        }
      })()
    }, delay)
  }
  private async write(pending: PendingWrite, generation: number): Promise<boolean> {
    this.pending = pending
    this.patch({ uncertain: false })
    let outcome: RemoteResult<WriteResult>
    try {
      outcome = await pending.send()
    } catch {
      if (this.current(generation)) this.patch({ problem: 'unknown', uncertain: true })
      if (this.current(generation)) await this.checkIdentity()
      return false
    }
    if (!this.current(generation)) return false
    if (!outcome.ok) {
      // An interruption can happen after commit: keep the original key and arguments.
      if (outcome.error.code === 'education/OPERATION_INTERRUPTED' || outcome.error.code.startsWith('gateway/')) {
        this.patch({ problem: 'unknown', uncertain: true })
      } else {
        this.pending = undefined
        this.report(outcome.error)
      }
      return false
    }
    this.pending = undefined
    this.patch({ uncertain: false })
    await pending.complete(outcome.value)
    return this.current(generation)
  }
  private async action(run: (generation: number) => Promise<void>): Promise<void> {
    if (this.autoInFlight) await this.autoInFlight
    if (!this.allowed()) return
    const generation = this.snapshot.generation
    this.patch({ busy: true, problem: null, notice: null })
    try {
      await run(generation)
    } catch (error) {
      if (this.current(generation)) this.report(error)
    } finally {
      if (this.current(generation)) this.patch({ busy: false })
    }
  }
  private notice(notice: WorkspaceSnapshot['notice']): void {
    this.patch({ notice, noticeId: this.snapshot.noticeId + 1 })
  }
  /**
   * A new empty project uses the same receipt machinery as every other write.
   * @param title - project name validated by the authoritative Host limits.
   * @param discard - caller has confirmed leaving any unsynced editor.
   * @param scenario - selected spoken-script or moments workflow.
   */
  async create(title: string, discard = false, scenario: CreationScenario = 'spoken-script'): Promise<void> {
    if (this.snapshot.dirty && !discard) return
    await this.action(async (generation) => {
      const request = { title, scenario, requestId: this.transport.requestId() }
      await this.write(
        {
          operation: 'projects.create',
          requestId: request.requestId,
          send: () => this.transport.remote.projectsCreate(request),
          complete: async (result) => {
            if (result.operation !== 'projects.create') throw new Error('Invalid project receipt')
            await this.loadProjects(false, generation)
            if (this.current(generation)) await this.openInternal(result.projectId, generation)
          },
        },
        generation,
      )
    })
  }
  private async syncInternal(generation: number): Promise<boolean> {
    const state = this.snapshot.project
    if (!state) return false
    if (!this.snapshot.dirty) return true
    const body = normalized(this.snapshot.text)
    const request = {
      artifactId: state.artifact.id,
      body,
      expectedDraftRevision: state.draft.revision,
      requestId: this.transport.requestId(),
    }
    return this.write(
      {
        operation: 'drafts.sync',
        requestId: request.requestId,
        send: () => this.transport.remote.draftsSync(request),
        complete: (result) => {
          if (result.operation !== 'drafts.sync') throw new Error('Invalid draft receipt')
          const currentText = normalized(this.snapshot.text)
          this.patch({
            project: { ...state, draft: { ...state.draft, ...result, body } },
            text: currentText,
            dirty: currentText !== body,
          })
          this.notice('synced')
        },
      },
      generation,
    )
  }
  /** Explicit synchronization does not append a formal version. */
  async sync(): Promise<void> {
    await this.action(async (generation) => {
      await this.syncInternal(generation)
    })
  }
  /** Save exactly the synchronized editor using both optimistic baselines. */
  async save(): Promise<void> {
    await this.action(async (generation) => {
      if (!(await this.syncInternal(generation))) return
      const state = this.snapshot.project
      if (!state || !this.current(generation)) return
      const request = {
        artifactId: state.artifact.id,
        expectedDraftRevision: state.draft.revision,
        expectedLatestVersionId: state.artifact.latestVersionId,
        requestId: this.transport.requestId(),
      }
      await this.write(
        {
          operation: 'artifacts.saveVersion',
          requestId: request.requestId,
          send: () => this.transport.remote.artifactsSaveVersion(request),
          complete: async (result) => {
            if (result.operation !== 'artifacts.saveVersion') throw new Error('Invalid version receipt')
            // Never infer another window's new draft as this editor's saved content.
            this.patch({ project: { ...state, artifact: { ...state.artifact, latestVersionId: result.versionId } } })
            await this.loadVersions(false, generation)
            if (this.current(generation)) this.notice('saved')
          },
        },
        generation,
      )
    })
  }
  private async loadVersions(more: boolean, generation: number): Promise<void> {
    const state = this.snapshot.project
    if (!state) return
    const cursor = more ? this.snapshot.versionsCursor : null
    if (more && !cursor) return
    const page = await this.value(
      this.transport.remote.artifactsListVersions({
        artifactId: state.artifact.id,
        limit: 30,
        ...(cursor ? { cursor } : {}),
      }),
    )
    const current = this.snapshot.project
    if (this.current(generation) && current?.artifact.id === state.artifact.id) {
      const versions = more ? [...this.snapshot.versions, ...page.items] : page.items
      this.patch({
        versions,
        versionsCursor: page.nextCursor,
        project: {
          ...current,
          latestVersion: versions.find(version => version.id === current.artifact.latestVersionId) ?? null,
        },
      })
    }
  }
  /**
   * History metadata is paginated independently of the project catalog.
   * @param more - append the next artifact-scoped page.
   */
  async versions(more = false): Promise<void> {
    await this.action(generation => this.loadVersions(more, generation))
  }
  /**
   * A historical read never changes draft text or revision.
   * @param version - metadata identifying the immutable version to view.
   */
  async preview(version: ArtifactVersionSummary): Promise<void> {
    await this.action(async (generation) => {
      const sequence = ++this.previewSequence
      const value = await this.value(
        this.transport.remote.artifactsReadVersion({ artifactId: version.artifactId, versionId: version.id }),
      )
      if (this.current(generation) && sequence === this.previewSequence) this.patch({ preview: value })
    })
  }
  /**
   * Explicit restore replaces the editor only after the Host confirms the write.
   * @param discard - caller has confirmed replacing any unsynced editor.
   */
  async restore(discard = false): Promise<void> {
    if (this.snapshot.dirty && !discard) return
    await this.action(async (generation) => {
      const state = this.snapshot.project,
        preview = this.snapshot.preview
      if (!state || !preview) return
      const request = {
        artifactId: state.artifact.id,
        versionId: preview.id,
        expectedDraftRevision: state.draft.revision,
        requestId: this.transport.requestId(),
      }
      await this.write(
        {
          operation: 'drafts.restoreVersion',
          requestId: request.requestId,
          send: () => this.transport.remote.draftsRestoreVersion(request),
          complete: (result) => {
            if (result.operation !== 'drafts.restoreVersion') throw new Error('Invalid restore receipt')
            this.patch({
              project: { ...state, draft: { ...state.draft, ...result, body: preview.body } },
              text: preview.body,
              dirty: false,
            })
            this.notice('restored')
          },
        },
        generation,
      )
    })
  }
  /**
   * Query a receipt first; a null receipt leaves the original request available for retry.
   * @param retry - resend the unchanged original request only when no receipt is found.
   */
  async resolve(retry = false): Promise<void> {
    if (this.pendingCreation) {
      await this.resolveCreation(retry)
      return
    }
    if (this.pendingContext) {
      await this.resolveContext(retry)
      return
    }
    const pending = this.pending
    if (!pending || this.snapshot.busy || !this.snapshot.user) return
    const generation = this.snapshot.generation
    this.patch({ busy: true })
    try {
      const result = await this.value(
        this.transport.remote.requestsGetResult({
          operation: pending.operation,
          requestId: pending.requestId,
        }),
      )
      if (!this.current(generation)) return
      if (result) {
        if (result.operation !== pending.operation) throw new Error('Invalid operation receipt')
        this.pending = undefined
        this.patch({ uncertain: false, problem: null })
        await pending.complete(result)
      } else if (retry) await this.write(pending, generation)
      else this.patch({ uncertain: true, problem: 'unknown' })
    } catch (error) {
      if (this.current(generation)) this.report(error)
    } finally {
      if (this.current(generation)) this.patch({ busy: false })
    }
  }
  /**
   * Export only confirmed server text or the explicitly previewed immutable version.
   * @param target - explicit draft or viewed-version source.
   * @param deliver - browser delivery callback invoked only for the still-current identity.
   */
  async export(target: 'draft' | 'version', deliver: (blob: Blob) => void): Promise<void> {
    await this.action(async (generation) => {
      const state = this.snapshot.project,
        preview = this.snapshot.preview
      if (!state || (target === 'draft' && this.snapshot.dirty) || (target === 'version' && !preview)) return
      const request: ExportTextRequest =
        target === 'version' && preview
          ? { artifactId: state.artifact.id, target: 'version', versionId: preview.id }
          : { artifactId: state.artifact.id, target: 'draft' }
      const blob = await this.transport.download(request, this.identityScope.signal)
      if (this.current(generation)) {
        deliver(blob)
        this.notice('exported')
      }
    })
  }
  /** Remove transient operation feedback without changing business data. */
  dismissNotice(): void {
    this.patch({ notice: null })
  }
  /** Read owner context and configured model presence without retaining credentials. */
  async refreshContext(): Promise<void> {
    if (!this.snapshot.user) return
    const generation = this.snapshot.generation
    try {
      const [profile, sources, availability] = await Promise.all([
        this.value(this.transport.remote.profilesReadSelf({})),
        this.value(this.transport.remote.sourcesList({})),
        this.value(this.transport.remote.creationAvailability({})),
      ])
      if (this.current(generation)) this.patch({ profile, sources, modelConfigured: availability.configured })
      await this.refreshCreation()
    } catch (error) {
      if (this.current(generation)) this.report(error)
    }
  }
  /**
   * Save employee-confirmed facts as an immutable profile version.
   * @param content - employee-confirmed facts, preferences and prohibited promises.
   */
  async saveProfile(content: ProfileContent): Promise<void> {
    await this.action(async (generation) => {
      const request = {
        ...content,
        expectedRevision: this.snapshot.profile?.revision ?? 0,
        requestId: this.transport.requestId(),
      }
      await this.contextWrite(
        {
          operation: 'profiles.save',
          requestId: request.requestId,
          send: () => this.transport.remote.profilesSaveVersion(request),
          complete: async (value) => {
            if (!('facts' in value)) throw new Error('Invalid profile receipt')
            this.patch({ profile: value })
            await this.refreshContext()
          },
        },
        generation,
      )
    })
  }
  /**
   * Save explicitly selected private source text and its version.
   * @param content - explicitly selected private text and optional revision.
   */
  async saveSource(content: { source?: SourceDTO; title: string; body: string; sourceUrl: string }): Promise<void> {
    await this.action(async (generation) => {
      const request = {
        title: content.title,
        body: content.body,
        sourceUrl: content.sourceUrl,
        expectedRevision: content.source?.revision ?? 0,
        ...(content.source ? { sourceId: content.source.id } : {}),
        requestId: this.transport.requestId(),
      }
      await this.contextWrite(
        {
          operation: 'sources.save',
          requestId: request.requestId,
          send: () => this.transport.remote.sourcesSaveVersion(request),
          complete: async () => this.refreshContext(),
        },
        generation,
      )
    })
  }
  /**
   * Change the current source grant using its displayed revision.
   * @param source - displayed current source.
   * @param authorized - explicit grant choice.
   */
  async authorizeSource(source: SourceDTO, authorized: boolean): Promise<void> {
    await this.action(async (generation) => {
      const request = {
        sourceId: source.id,
        authorized,
        expectedAuthorizationRevision: source.authorizationRevision,
        requestId: this.transport.requestId(),
      }
      await this.contextWrite(
        {
          operation: 'sources.authorize',
          requestId: request.requestId,
          send: () => this.transport.remote.sourcesSetAuthorization(request),
          complete: async () => {
            // Clear already visible historical text immediately, before the next server read.
            this.patch({ preview: null, creation: null, run: null })
            await this.refreshContext()
            const state = this.snapshot.project
            if (state && !this.snapshot.dirty) {
              await this.openInternal(state.project.id, generation)
              await this.refreshCreation()
            }
          },
        },
        generation,
      )
    })
  }
  private async contextWrite(pending: PendingContext, generation: number): Promise<void> {
    this.pendingContext = pending
    let result: RemoteResult<CreationMutationResult>
    try {
      result = await pending.send()
    } catch {
      if (this.current(generation)) this.patch({ uncertain: true, problem: 'unknown' })
      return
    }
    if (!this.current(generation)) return
    if (!result.ok) {
      if (result.error.code.startsWith('gateway/') || result.error.code === 'education/OPERATION_INTERRUPTED')
        this.patch({ uncertain: true, problem: 'unknown' })
      else {
        this.pendingContext = undefined
        this.report(result.error)
      }
      return
    }
    this.pendingContext = undefined
    this.patch({ uncertain: false, problem: null })
    await pending.complete(result.value)
  }
  private async resolveContext(retry: boolean): Promise<void> {
    const pending = this.pendingContext,
      generation = this.snapshot.generation
    if (!pending || this.snapshot.busy) return
    this.patch({ busy: true })
    try {
      const result = await this.value(
        this.transport.remote.creationMutationResult({ operation: pending.operation, requestId: pending.requestId }),
      )
      if (!this.current(generation)) return
      if (result !== null) {
        this.pendingContext = undefined
        this.patch({ uncertain: false, problem: null })
        await pending.complete(result)
      } else if (retry) await this.contextWrite(pending, generation)
      else this.patch({ uncertain: true, problem: 'unknown' })
    } catch (error) {
      if (this.current(generation)) this.report(error)
    } finally {
      if (this.current(generation)) this.patch({ busy: false })
    }
  }
  /** Explicitly start a safe empty context in the same project while preserving immutable history. */
  async resetContext(): Promise<void> {
    const state = this.snapshot.project
    if (!state) return
    await this.action(async (generation) => {
      const request = {
        artifactId: state.artifact.id,
        expectedDraftRevision: state.draft.revision,
        requestId: this.transport.requestId(),
      }
      await this.contextWrite(
        {
          operation: 'context.reset',
          requestId: request.requestId,
          send: () => this.transport.remote.creationResetContext(request),
          complete: async () => {
            await this.openInternal(state.project.id, generation)
            await this.refreshCreation()
          },
        },
        generation,
      )
    })
  }
  /** Refresh persistent run state; reading never restarts a model request. */
  async refreshCreation(): Promise<void> {
    const state = this.snapshot.project,
      generation = this.snapshot.generation
    if (!state || !this.snapshot.user) return
    const sequence = ++this.creationSequence
    try {
      const creation = await this.value(this.transport.remote.creationReadState({ artifactId: state.artifact.id }))
      if (
        !this.current(generation) ||
        sequence !== this.creationSequence ||
        this.snapshot.project?.artifact.id !== state.artifact.id
      )
        return
      this.patch({ creation, run: creation.run })
      if (creation.restricted)
        this.patch({
          text: '',
          dirty: false,
          preview: null,
          project: { ...state, draft: { ...state.draft, body: '', restricted: true } },
        })
      this.pollRun(generation, state.artifact.id)
    } catch (error) {
      if (this.current(generation) && sequence === this.creationSequence) this.report(error)
    }
  }
  /**
   * Run owner-authorized content generation through the native Agent.
   * @param instruction - explicit request.
   * @param sourceVersionIds - selected owner source revisions.
   * @param mode - generation or modification.
   * @param selection - optional LF/UTF-16 protected range.
   */
  async generate(
    instruction: string,
    sourceVersionIds: readonly SourceVersionId[],
    mode: StartCreationInput['mode'],
    selection?: TextSelection,
  ): Promise<void> {
    if (this.generating()) return
    await this.sync()
    if (
      !this.allowed() ||
      this.snapshot.dirty ||
      this.snapshot.uncertain ||
      !this.snapshot.profile ||
      !this.snapshot.project
    )
      return
    const state = this.snapshot.project,
      generation = this.snapshot.generation
    const request: StartCreationInput = {
      artifactId: state.artifact.id,
      expectedDraftRevision: state.draft.revision,
      requestId: this.transport.requestId(),
      profileVersionId: this.snapshot.profile.id,
      sourceVersionIds,
      instruction,
      mode,
      ...(selection === undefined ? {} : { selection }),
    }
    this.pendingCreation = request
    this.patch({ busy: true, problem: null })
    try {
      await this.sendCreation(request, generation)
    } finally {
      if (this.current(generation)) this.patch({ busy: false })
    }
  }
  private async sendCreation(request: StartCreationInput, generation: number): Promise<void> {
    try {
      const result = await this.transport.remote.creationStart(request)
      if (!this.current(generation)) return
      if (!result.ok) {
        if (result.error.code === 'education/OPERATION_INTERRUPTED' || result.error.code.startsWith('gateway/'))
          this.patch({ uncertain: true, problem: 'unknown' })
        else {
          this.pendingCreation = undefined
          this.report(result.error)
        }
        return
      }
      this.pendingCreation = undefined
      this.patch({ run: result.value, uncertain: false, problem: null })
      this.pollRun(generation, request.artifactId)
    } catch {
      if (this.current(generation)) this.patch({ uncertain: true, problem: 'unknown' })
    }
  }
  private async resolveCreation(retry: boolean): Promise<void> {
    const request = this.pendingCreation,
      generation = this.snapshot.generation
    if (!request || this.snapshot.busy) return
    this.patch({ busy: true })
    try {
      const result = await this.value(this.transport.remote.creationFindRun({ requestId: request.requestId }))
      if (!this.current(generation)) return
      if (result !== null) {
        this.pendingCreation = undefined
        this.patch({ run: result, uncertain: false, problem: null })
        this.pollRun(generation, request.artifactId)
      } else if (retry) await this.sendCreation(request, generation)
      else this.patch({ uncertain: true, problem: 'unknown' })
    } catch (error) {
      if (this.current(generation)) this.report(error)
    } finally {
      if (this.current(generation)) this.patch({ busy: false })
    }
  }
  /** Cancel and await the currently displayed owned run. */
  async cancelGeneration(): Promise<void> {
    const run = this.snapshot.run,
      generation = this.snapshot.generation
    if (!run || !this.generating()) return
    try {
      const result = await this.value(this.transport.remote.creationCancel({ runId: run.id }))
      if (this.current(generation)) {
        this.patch({ run: result })
        await this.refreshCreation()
      }
    } catch (error) {
      if (this.current(generation)) this.report(error)
    }
  }
  /** Apply an authorized full candidate only after explicit confirmation against the current draft. */
  async applyCandidate(): Promise<void> {
    const run = this.snapshot.run,
      project = this.snapshot.project
    if (!run || !project || this.snapshot.dirty) return
    await this.action(async (generation) => {
      await this.value(
        this.transport.remote.creationApplyCandidate({
          runId: run.id,
          expectedDraftRevision: project.draft.revision,
          requestId: this.transport.requestId(),
        }),
      )
      if (this.current(generation)) {
        await this.openInternal(project.project.id, generation)
        await this.refreshCreation()
      }
    })
  }
  private pollRun(generation: number, artifactId: ProjectState['artifact']['id']): void {
    clearTimeout(this.pollTimer)
    if (!this.current(generation) || !this.generating()) return
    this.pollTimer = setTimeout(() => {
      void (async () => {
        const current = () => this.current(generation) && this.snapshot.project?.artifact.id === artifactId
        try {
          const run = this.snapshot.run
          if (!run || !current()) return
          const sequence = ++this.creationSequence
          const next = await this.value(this.transport.remote.creationGetRun({ runId: run.id }))
          if (!current() || sequence !== this.creationSequence) return
          this.patch({ run: next })
          if (next.status === 'pending' || next.status === 'running') this.pollRun(generation, artifactId)
          else {
            const projectId = this.snapshot.project?.project.id
            if (next.status === 'completed' && !this.snapshot.dirty && projectId)
              await this.openInternal(projectId, generation)
            if (current()) await this.refreshCreation()
          }
        } catch (error) {
          if (current()) this.report(error)
        }
      })()
    }, this.options.runPollIntervalMs ?? 500)
  }
  /** Idempotently remove every retained private object and live subscription. */
  dispose(): void {
    if (this.disposed) return
    this.clear()
    this.disposed = true
    this.listeners.clear()
  }
}

/**
 * Generate a business id separately from the carrier's RPC correlation id.
 * @returns a new UUID in the business request domain.
 */
export function requestId(): RequestId {
  return brandString<RequestId>(randomUUID())
}
