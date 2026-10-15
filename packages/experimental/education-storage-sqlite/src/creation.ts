/** Creation transactions use the owning repository's actor checks and the same SQLite connection. */
import type { DatabaseSync } from 'node:sqlite'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  ActorContext,
  ArtifactId,
  AuthorizeSourceInput,
  BasisSnapshot,
  CreationBasis,
  CreationInputSnapshot,
  CreationRepository,
  CreationState,
  DialogueMessage,
  ProfileVersion,
  RequestId,
  RunDTO,
  RunId,
  SaveProfileInput,
  SaveSourceInput,
  SourceDTO,
  SourceId,
  SourceReference,
  SourceVersionId,
  StartCreationInput,
  GenerationInputSnapshot,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { digest, FOUNDATION_BASIS, id, integer, newId, receiptResult, text, timestamp, type Row } from './codec.ts'
import type {
  CreationMutation,
  CreationMutationResult,
  DraftCommitted,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { decodeBasis, decodeProfile, decodeRunSnapshot, decodeSource } from './creation-codec.ts'
import { sourceView } from './source-view.ts'

interface Owner {
  transaction<T>(actor: ActorContext, work: () => T, write?: boolean): T
  artifact(actor: ActorContext, artifactId: ArtifactId): Row
  readonly maxBodyBytes: number
  readonly maxTitleBytes: number
  readonly maxPageSize: number
  system<T>(work: () => T): T
  sourcePermitted(
    actor: ActorContext,
    versionId: SourceVersionId,
    permission?: 'view' | 'use_for_ai' | 'export',
  ): boolean
  validateBody(actor: ActorContext, artifactId: ArtifactId, body: string, basis: BasisSnapshot): void
}
/** Source metadata is supplied only by the trusted research/transfer consumers, never by the plain-source RPC. */
export interface SourceAttachment {
  readonly kind: 'text' | 'transcript'
  readonly evidenceJson: string
  readonly fileHash: string | null
  readonly objectHash: string | null
  readonly dependencies?: readonly {
    readonly kind: 'account' | 'source' | 'report'
    readonly parentId: string
    readonly parentRevision: number
  }[]
}
const unavailable = () => new EducationError('resource-unavailable', 'creation resource is unavailable')
const conflict = () => new EducationError('draft-conflict', 'creation baseline changed; reload before continuing')
const now = () => new Date().toISOString()
const terminal = (status: RunDTO['status']) => status !== 'pending' && status !== 'running'

/** Same-medium source versions, fixed inputs and generation occupancy. All public calls revalidate the Actor. */
export class SqliteCreationRepository implements CreationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: Owner,
  ) {}

  resetContext(
    actor: ActorContext,
    artifactId: ArtifactId,
    expectedRevision: number,
    requestId: RequestId,
  ): DraftCommitted {
    const request = { artifactId, expectedRevision, requestId }
    return this.owner.transaction(
      actor,
      () =>
        this.receipt(actor, 'context.reset', request, this.resetReceipt, () => {
          this.owner.artifact(actor, artifactId)
          if (
            this.db
              .prepare("SELECT id FROM creation_runs WHERE artifact_id=? AND status IN('pending','running')")
              .get(artifactId) !== undefined
          )
            throw conflict()
          const draft = this.db.prepare('SELECT revision FROM drafts WHERE artifact_id=?').get(artifactId)
          if (draft?.revision !== expectedRevision) throw conflict()
          const at = now(),
            revision = integer(expectedRevision + 1)
          this.db
            .prepare('UPDATE drafts SET body=?,body_hash=?,revision=?,updated_at=? WHERE artifact_id=?')
            .run('', digest(''), revision, at, artifactId)
          this.setBasis(artifactId, FOUNDATION_BASIS)
          this.db
            .prepare('INSERT INTO audit_records VALUES(?,?,?,?,?,?,?,?,?)')
            .run(
              newId(),
              actor.organizationId,
              actor.userId,
              'creation.reset',
              'artifact',
              artifactId,
              'committed',
              requestId,
              at,
            )
          return { operation: 'drafts.sync', artifactId, revision, bodyHash: digest(''), updatedAt: at }
        }),
      true,
    )
  }
  mutationResult(
    actor: ActorContext,
    operation: CreationMutation,
    requestId: RequestId,
  ): CreationMutationResult | null {
    return this.owner.transaction(actor, () => {
      const row = this.db
        .prepare(
          'SELECT result_json FROM creation_receipts WHERE organization_id=? AND owner_id=? AND operation=? AND request_id=?',
        )
        .get(actor.organizationId, actor.userId, operation, requestId)
      if (row === undefined) return null
      const json = text(row, 'result_json')
      if (operation === 'profiles.save') return decodeProfile(json)
      if (operation === 'context.reset') {
        const result = this.resetReceipt(json)
        this.owner.artifact(actor, result.artifactId)
        return result
      }
      const source = decodeSource(json)
      return this.source(actor, source.id, source.versionId)
    })
  }
  private resetReceipt(this: void, json: string): DraftCommitted {
    const result = receiptResult(json)
    if (result.operation !== 'drafts.sync')
      throw new EducationError('storage-unavailable', 'context reset receipt is invalid')
    return result
  }

  readProfile(actor: ActorContext): ProfileVersion | null {
    return this.owner.transaction(actor, () => this.profile(actor))
  }
  private profile(actor: ActorContext): ProfileVersion | null {
    const row = this.db
      .prepare(
        'SELECT content_json FROM profile_versions WHERE organization_id=? AND owner_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(actor.organizationId, actor.userId)
    return row === undefined ? null : decodeProfile(text(row, 'content_json'))
  }
  saveProfile(actor: ActorContext, input: SaveProfileInput): ProfileVersion {
    return this.owner.transaction(
      actor,
      () =>
        this.receipt(actor, 'profiles.save', input, decodeProfile, () => {
          const prior = this.profile(actor)
          if ((prior?.revision ?? 0) !== input.expectedRevision) throw conflict()
          const content = {
            facts: this.body(input.facts, true),
            preferences: this.body(input.preferences),
            prohibitedPromises: this.body(input.prohibitedPromises),
          }
          const result: ProfileVersion = {
            ...content,
            id: newId(),
            revision: integer(input.expectedRevision + 1),
            bodyHash: digest(JSON.stringify(content)),
            createdAt: now(),
          }
          this.db
            .prepare('INSERT INTO profile_versions VALUES(?,?,?,?,?,?,?)')
            .run(
              result.id,
              actor.organizationId,
              actor.userId,
              result.revision,
              JSON.stringify(result),
              result.bodyHash,
              result.createdAt,
            )
          return result
        }),
      true,
    )
  }
  listSources(actor: ActorContext): readonly SourceDTO[] {
    return this.owner.transaction(actor, () =>
      this.db
        .prepare(
          'SELECT id FROM sources WHERE organization_id=? AND owner_id=? ORDER BY created_at DESC,id DESC LIMIT ?',
        )
        .all(actor.organizationId, actor.userId, this.owner.maxPageSize)
        .map(row => this.source(actor, id(row.id))),
    )
  }
  private source(actor: ActorContext, sourceId: SourceId, versionId?: SourceVersionId): SourceDTO {
    return sourceView(
      this.db,
      actor,
      sourceId,
      versionId,
      selected =>
        this.owner.sourcePermitted(actor, selected, 'view') &&
        this.owner.sourcePermitted(actor, selected, 'use_for_ai'),
    )
  }
  saveSource(actor: ActorContext, input: SaveSourceInput): SourceDTO {
    return this.saveSourceWithMetadata(actor, input)
  }
  /**
   * Attach immutable evidence and upstream dependencies in the source version's own transaction.
   * @param actor - current trusted source owner.
   * @param input - source version and unchanged original request identity.
   * @param attachment - Host-validated evidence, or absent for a plain-text source.
   * @param validate - recheck transfer provenance inside the same source transaction before receipt lookup.
   * @returns current authorized view; editing a derived source cannot discard its upstream grants.
   */
  saveSourceWithMetadata(
    actor: ActorContext,
    input: SaveSourceInput,
    attachment?: SourceAttachment,
    validate?: () => void,
  ): SourceDTO {
    const parameters =
      attachment === undefined ? input : { ...input, attachmentHash: digest(JSON.stringify(attachment)) }
    return this.owner.transaction(
      actor,
      () => {
        validate?.()
        return this.receipt(actor, 'sources.save', parameters, decodeSource, () => {
          const body = this.body(input.body, true),
            title = this.body(input.title, true)
          if (Buffer.byteLength(title) > this.owner.maxTitleBytes)
            throw new EducationError('validation-failed', 'source title is too long')
          if (input.sourceUrl !== '') {
            let url: URL
            try {
              url = new URL(input.sourceUrl)
            } catch {
              throw new EducationError('validation-failed', 'source URL is invalid')
            }
            if (
              !['http:', 'https:'].includes(url.protocol) ||
              url.username ||
              url.password ||
              Buffer.byteLength(input.sourceUrl) > this.owner.maxBodyBytes
            )
              throw new EducationError('validation-failed', 'source URL is invalid')
          }
          const previous = input.sourceId === undefined ? null : this.source(actor, input.sourceId)
          if ((previous?.revision ?? 0) !== input.expectedRevision) throw conflict()
          const sourceId = previous?.id ?? newId<SourceId>(),
            versionId = newId<SourceVersionId>(),
            at = now(),
            revision = integer(input.expectedRevision + 1)
          if (previous === null)
            this.db
              .prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?)')
              .run(sourceId, actor.organizationId, actor.userId, title, input.sourceUrl, revision, versionId, 1, 1, at)
          else
            this.db
              .prepare('UPDATE sources SET title=?,source_url=?,revision=?,current_version_id=? WHERE id=?')
              .run(title, input.sourceUrl, revision, versionId, sourceId)
          this.db
            .prepare('INSERT INTO source_versions VALUES(?,?,?,?,?,?,?,?)')
            .run(versionId, sourceId, actor.organizationId, actor.userId, revision, body, digest(body), at)
          if (previous !== null)
            this.db
              .prepare(
                'INSERT INTO source_dependencies SELECT ?,kind,parent_id,parent_revision FROM source_dependencies WHERE version_id=?',
              )
              .run(versionId, previous.versionId)
          if (attachment !== undefined) {
            this.db
              .prepare('INSERT INTO source_evidence VALUES(?,?,?,?,?)')
              .run(versionId, attachment.kind, attachment.evidenceJson, attachment.fileHash, attachment.objectHash)
            for (const dependency of attachment.dependencies ?? [])
              this.db
                .prepare('INSERT OR IGNORE INTO source_dependencies VALUES(?,?,?,?)')
                .run(versionId, dependency.kind, dependency.parentId, dependency.parentRevision)
          }
          return this.source(actor, sourceId)
        })
      },
      true,
    )
  }
  authorizeSource(actor: ActorContext, input: AuthorizeSourceInput): SourceDTO {
    return this.owner.transaction(
      actor,
      () =>
        this.receipt(actor, 'sources.authorize', input, decodeSource, () => {
          const source = this.source(actor, input.sourceId)
          if (source.authorizationRevision !== input.expectedAuthorizationRevision) throw conflict()
          this.db
            .prepare('UPDATE sources SET authorized=?,authorization_revision=? WHERE id=?')
            .run(input.authorized ? 1 : 0, integer(source.authorizationRevision + 1), source.id)
          return this.source(actor, source.id)
        }),
      true,
    )
  }
  /**
   * Check original source references against current authorization.
   * @param actor - trusted owner.
   * @param basis - original evidence.
   * @param permission - independent read, model-use or export authorization.
   * @returns whether all original grants still permit reading.
   */
  permitted(actor: ActorContext, basis: BasisSnapshot, permission: 'view' | 'use_for_ai' | 'export' = 'view'): boolean {
    if (basis.source === 'foundation-validation') return true
    return basis.references.every((ref) => {
      if (ref.ownerId !== actor.userId) return false
      const row = this.db
        .prepare(
          `SELECT s.authorized,s.authorization_revision,v.body_hash FROM sources s JOIN source_versions v ON v.source_id=s.id
        WHERE s.id=? AND v.id=? AND s.owner_id=? AND s.organization_id=? AND v.owner_id=s.owner_id AND v.organization_id=s.organization_id`,
        )
        .get(ref.sourceId, ref.versionId, actor.userId, actor.organizationId)
      return (
        row !== undefined &&
        row.authorized === 1 &&
        row.authorization_revision === ref.authorizationRevision &&
        row.body_hash === ref.bodyHash &&
        this.owner.sourcePermitted(actor, ref.versionId, permission)
      )
    })
  }
  /**
   * Read the evidence associated with the current draft.
   * @param actor - trusted owner.
   * @param artifactId - same-owner artifact.
   * @returns currently recorded draft evidence.
   */
  basis(actor: ActorContext, artifactId: ArtifactId): BasisSnapshot {
    this.owner.artifact(actor, artifactId)
    const row = this.db.prepare('SELECT basis_json FROM creation_draft_context WHERE artifact_id=?').get(artifactId)
    return row === undefined ? FOUNDATION_BASIS : decodeBasis(text(row, 'basis_json'))
  }
  /**
   * Reject active generation occupancy and revoked derivatives.
   * @param actor - trusted owner.
   * @param artifactId - target draft. Reject concurrent model ownership and revoked derivatives.
   */
  assertWritable(actor: ActorContext, artifactId: ArtifactId): void {
    this.owner.artifact(actor, artifactId)
    if (
      this.db
        .prepare("SELECT id FROM creation_runs WHERE artifact_id=? AND status IN('pending','running')")
        .get(artifactId) !== undefined
    )
      throw conflict()
    if (!this.permitted(actor, this.basis(actor, artifactId))) throw unavailable()
  }
  /**
   * Replace draft evidence without modifying formal history.
   * @param artifactId - already authorized artifact.
   * @param basis - checked original basis to preserve on restoration.
   */
  setBasis(artifactId: ArtifactId, basis: BasisSnapshot): void {
    this.db
      .prepare(
        'INSERT INTO creation_draft_context VALUES(?,?) ON CONFLICT(artifact_id) DO UPDATE SET basis_json=excluded.basis_json',
      )
      .run(artifactId, JSON.stringify(basis))
  }
  /**
   * Capture another supported input in the existing atomic run-admission and occupancy store.
   * @param actor - trusted current owner.
   * @param input - exact original request including its draft baseline.
   * @param maxInputBytes - complete fixed-input cap.
   * @param capture - same-transaction source capture; must not perform external work or open nested transactions.
   * @returns original run on replay, otherwise one newly occupied artifact run.
   */
  startPrepared(
    actor: ActorContext,
    input: { readonly artifactId: ArtifactId; readonly requestId: RequestId; readonly expectedDraftRevision: number },
    maxInputBytes: number,
    capture: (runId: RunId, artifact: Row, draft: Row) => { snapshot: GenerationInputSnapshot; basis: BasisSnapshot },
  ): RunDTO {
    return this.owner.transaction(
      actor,
      () => {
        const requestHash = digest(JSON.stringify(input)),
          prior = this.db
            .prepare('SELECT * FROM creation_runs WHERE organization_id=? AND owner_id=? AND request_id=?')
            .get(actor.organizationId, actor.userId, input.requestId)
        if (prior !== undefined) {
          if (prior.request_hash !== requestHash)
            throw new EducationError('idempotency-conflict', 'run request identity was used with different parameters')
          return this.runDTO(actor, prior)
        }
        this.assertWritable(actor, input.artifactId)
        const artifact = this.owner.artifact(actor, input.artifactId),
          draft = this.db.prepare('SELECT * FROM drafts WHERE artifact_id=?').get(input.artifactId)
        if (draft === undefined || draft.revision !== input.expectedDraftRevision) throw conflict()
        const runId = newId<RunId>(),
          at = now(),
          prepared = capture(runId, artifact, draft)
        if (Buffer.byteLength(JSON.stringify(prepared.snapshot)) > maxInputBytes)
          throw new EducationError('validation-failed', 'complete fixed run input exceeds the configured limit')
        return this.insertCapturedRun(actor, input, requestHash, artifact, runId, at, prepared.snapshot, prepared.basis)
      },
      true,
    )
  }
  start(actor: ActorContext, input: StartCreationInput, policyVersion: string, maxInputBytes: number): RunDTO {
    return this.owner.transaction(
      actor,
      () => {
        const prior = this.db
          .prepare('SELECT * FROM creation_runs WHERE organization_id=? AND owner_id=? AND request_id=?')
          .get(actor.organizationId, actor.userId, input.requestId)
        const requestHash = digest(JSON.stringify(input))
        if (prior !== undefined) {
          if (prior.request_hash !== requestHash)
            throw new EducationError('idempotency-conflict', 'creation request was used with different parameters')
          return this.runDTO(actor, prior)
        }
        this.assertWritable(actor, input.artifactId)
        const artifact = this.owner.artifact(actor, input.artifactId)
        if (artifact.kind === 'text-analysis')
          throw new EducationError('validation-failed', 'analysis requires the source-only research operation')
        const draft = this.db.prepare('SELECT * FROM drafts WHERE artifact_id=?').get(input.artifactId)
        if (draft === undefined || draft.revision !== input.expectedDraftRevision) throw conflict()
        const profile = this.profile(actor)
        if (profile === null || profile.id !== input.profileVersionId) throw conflict()
        if (
          !['generate', 'modify', 'selection'].includes(input.mode) ||
          new Set(input.sourceVersionIds).size !== input.sourceVersionIds.length ||
          input.sourceVersionIds.length > this.owner.maxPageSize
        )
          throw new EducationError('validation-failed', 'creation mode or sources are invalid')
        const sources = input.sourceVersionIds.map((versionId) => {
          const row = this.db
            .prepare('SELECT source_id FROM source_versions WHERE id=? AND organization_id=? AND owner_id=?')
            .get(versionId, actor.organizationId, actor.userId)
          if (row === undefined) throw unavailable()
          const result = this.source(actor, id(row.source_id), versionId)
          if (!result.authorized) throw unavailable()
          return result
        })
        const previousBasis = this.basis(actor, input.artifactId)
        if (!this.permitted(actor, previousBasis, 'use_for_ai')) throw unavailable()
        if (
          previousBasis.source === 'creation-context' &&
          previousBasis.profileVersionIds[0] !== profile.id &&
          text(draft, 'body').trim() !== ''
        )
          throw conflict()
        // A directly edited derivative retains its complete source evidence on subsequent modifications.
        const references: SourceReference[] =
          previousBasis.source === 'creation-context' ? [...previousBasis.references] : []
        for (const source of sources)
          if (!references.some(ref => ref.versionId === source.versionId))
            references.push({
              sourceId: source.id,
              versionId: source.versionId,
              ownerId: actor.userId,
              bodyHash: source.bodyHash,
              authorizationRevision: source.authorizationRevision,
            })
        const contextFingerprint = digest(
          JSON.stringify({ profile: profile.id, references, policyVersion, capabilities: [] }),
        )
        const snapshot: CreationInputSnapshot = {
          scenario: artifact.kind === 'moments' ? 'moments' : 'spoken-script',
          profile,
          sources,
          draft: text(draft, 'body'),
          instruction: this.body(input.instruction, true),
          mode: input.mode,
          ...(input.selection === undefined ? {} : { selection: input.selection }),
          contextFingerprint,
          policyVersion,
          capabilities: [],
        }
        if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > maxInputBytes)
          throw new EducationError('validation-failed', 'complete creation input exceeds the configured limit')
        if (input.mode === 'selection') this.selection(snapshot)
        else if (input.selection !== undefined)
          throw new EducationError('validation-failed', 'selection is only valid for a selection modification')
        const runId = newId<RunId>(),
          at = now()
        const basis: CreationBasis = {
          source: 'creation-context',
          profileVersionIds: [profile.id],
          materialVersionIds: references.map(ref => ref.versionId),
          references,
          runId,
          contextFingerprint,
          policyVersion,
        }
        return this.insertCapturedRun(actor, input, requestHash, artifact, runId, at, snapshot, basis)
      },
      true,
    )
  }
  private insertCapturedRun(
    actor: ActorContext,
    input: { readonly artifactId: ArtifactId; readonly requestId: RequestId; readonly expectedDraftRevision: number },
    requestHash: string,
    artifact: Row,
    runId: RunId,
    at: string,
    snapshot: GenerationInputSnapshot,
    basis: BasisSnapshot,
  ): RunDTO {
    this.db
      .prepare("INSERT INTO creation_runs VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?,NULL,NULL,NULL,NULL,NULL,?,?)")
      .run(
        runId,
        actor.organizationId,
        actor.userId,
        actor.loginSessionId,
        input.artifactId,
        text(artifact, 'project_id'),
        input.requestId,
        requestHash,
        input.expectedDraftRevision,
        JSON.stringify(snapshot),
        JSON.stringify(basis),
        at,
        at,
      )
    this.db
      .prepare('INSERT INTO creation_dialogue VALUES(?,?,?,?,?)')
      .run(newId(), runId, 'user', snapshot.instruction, at)
    return this.runDTO(actor, this.ownedRun(actor, runId))
  }
  input(actor: ActorContext, runId: RunId): CreationInputSnapshot {
    const input = this.runInput(actor, runId)
    if (input.scenario === 'text-analysis') throw unavailable()
    return input
  }
  runInput(actor: ActorContext, runId: RunId): GenerationInputSnapshot {
    return this.owner.transaction(actor, () => {
      const row = this.ownedRun(actor, runId)
      this.checkContext(actor, row)
      return decodeRunSnapshot(text(row, 'snapshot_json'))
    })
  }
  markRunning(actor: ActorContext, runId: RunId, sessionId: SessionId): RunDTO {
    return this.owner.transaction(
      actor,
      () => {
        const row = this.ownedRun(actor, runId)
        if (
          row.status !== 'pending' &&
          (row.status !== 'running' || decodeRunSnapshot(text(row, 'snapshot_json')).scenario !== 'text-analysis')
        )
          throw conflict()
        this.checkContext(actor, row)
        const binding = this.db
          .prepare(
            "SELECT id FROM session_bindings WHERE harness_session_id=? AND artifact_id=? AND organization_id=? AND owner_id=? AND status='active'",
          )
          .get(sessionId, text(row, 'artifact_id'), actor.organizationId, actor.userId)
        if (binding === undefined) throw unavailable()
        this.db
          .prepare("UPDATE creation_runs SET status='running',session_id=?,updated_at=? WHERE id=?")
          .run(sessionId, now(), runId)
        return this.runDTO(actor, this.ownedRun(actor, runId))
      },
      true,
    )
  }
  complete(actor: ActorContext, runId: RunId, body: string, explanation: string): RunDTO {
    return this.owner.transaction(
      actor,
      () => {
        const row = this.ownedRun(actor, runId)
        if (terminal(this.status(row))) return this.runDTO(actor, row)
        let candidate = this.body(body, true)
        explanation = this.body(explanation)
        const snapshot = decodeRunSnapshot(text(row, 'snapshot_json'))
        if (snapshot.scenario !== 'text-analysis' && snapshot.mode === 'selection') {
          const selection = this.selection(snapshot)
          candidate = snapshot.draft.slice(0, selection.start) + candidate + snapshot.draft.slice(selection.end)
        }
        candidate = this.body(candidate, true)
        this.owner.validateBody(actor, id(row.artifact_id), candidate, decodeBasis(text(row, 'basis_json')))
        let errorCode: string | null = null
        try {
          this.checkContext(actor, row)
        } catch (error) {
          if (!(error instanceof EducationError)) throw error
          errorCode = error.code
        }
        const draft = this.db.prepare('SELECT revision FROM drafts WHERE artifact_id=?').get(text(row, 'artifact_id'))
        if (draft?.revision !== row.expected_revision) errorCode ??= 'draft-conflict'
        this.db
          .prepare('UPDATE creation_runs SET candidate=?,explanation=? WHERE id=?')
          .run(candidate, explanation, runId)
        if (errorCode !== null) this.settle(row, 'failed', errorCode)
        else this.commit(actor, row, candidate, explanation)
        return this.runDTO(actor, this.ownedRun(actor, runId))
      },
      true,
    )
  }
  private commit(actor: ActorContext, row: Row, candidate: string, explanation: string): void {
    this.owner.validateBody(actor, id(row.artifact_id), candidate, decodeBasis(text(row, 'basis_json')))
    const revision = integer(integer(row.expected_revision) + 1),
      at = now()
    const updated = this.db
      .prepare('UPDATE drafts SET body=?,body_hash=?,revision=?,updated_at=? WHERE artifact_id=? AND revision=?')
      .run(candidate, digest(candidate), revision, at, text(row, 'artifact_id'), integer(row.expected_revision))
    if (updated.changes !== 1) throw conflict()
    this.setBasis(id(row.artifact_id), decodeBasis(text(row, 'basis_json')))
    this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(at, text(row, 'project_id'))
    this.db
      .prepare("UPDATE creation_runs SET status='completed',error_code=NULL,draft_revision=?,updated_at=? WHERE id=?")
      .run(revision, at, text(row, 'id'))
    this.db
      .prepare('INSERT INTO creation_dialogue VALUES(?,?,?,?,?)')
      .run(newId(), text(row, 'id'), 'assistant', explanation, at)
    this.db
      .prepare('INSERT INTO audit_records VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        newId(),
        actor.organizationId,
        actor.userId,
        'creation.complete',
        'artifact',
        text(row, 'artifact_id'),
        'committed',
        text(row, 'request_id'),
        at,
      )
  }
  fail(actor: ActorContext, runId: RunId, status: 'failed' | 'cancelled' | 'interrupted', errorCode: string): RunDTO {
    return this.owner.transaction(
      actor,
      () => {
        const row = this.ownedRun(actor, runId)
        if (!terminal(this.status(row))) this.settle(row, status, errorCode)
        return this.runDTO(actor, this.ownedRun(actor, runId))
      },
      true,
    )
  }
  getRun(actor: ActorContext, runId: RunId): RunDTO {
    return this.owner.transaction(actor, () => this.runDTO(actor, this.ownedRun(actor, runId)))
  }
  findRun(actor: ActorContext, requestId: RequestId): RunDTO | null {
    return this.owner.transaction(actor, () => {
      const row = this.db
        .prepare('SELECT * FROM creation_runs WHERE organization_id=? AND owner_id=? AND request_id=?')
        .get(actor.organizationId, actor.userId, requestId)
      return row === undefined ? null : this.runDTO(actor, row)
    })
  }
  readState(actor: ActorContext, artifactId: ArtifactId): CreationState {
    return this.owner.transaction(actor, () => {
      this.owner.artifact(actor, artifactId)
      const row = this.db
        .prepare('SELECT * FROM creation_runs WHERE artifact_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
        .get(artifactId)
      const dialogue: DialogueMessage[] = this.db
        .prepare(
          `SELECT d.*,r.basis_json FROM creation_dialogue d JOIN creation_runs r ON d.run_id=r.id
        WHERE r.artifact_id=? ORDER BY d.rowid DESC LIMIT ?`,
        )
        .all(artifactId, this.owner.maxPageSize)
        .reverse()
        .map((message) => {
          const restricted = !this.permitted(actor, decodeBasis(text(message, 'basis_json')))
          if (message.role !== 'user' && message.role !== 'assistant')
            throw new EducationError('storage-unavailable', 'dialogue role is invalid')
          return {
            id: text(message, 'id'),
            runId: id(message.run_id),
            role: message.role,
            body: restricted ? '' : text(message, 'body'),
            restricted,
            createdAt: timestamp(message.created_at),
          }
        })
      const basis = this.basis(actor, artifactId)
      return {
        run: row === undefined ? null : this.runDTO(actor, row),
        dialogue,
        basis,
        restricted: !this.permitted(actor, basis),
      }
    })
  }
  applyCandidate(actor: ActorContext, runId: RunId, expectedRevision: number, requestId: RequestId): RunDTO {
    return this.owner.transaction(
      actor,
      () => {
        const key = `candidate:${requestId}`
        const prior = this.db
          .prepare(
            "SELECT result_json,request_hash FROM creation_receipts WHERE organization_id=? AND owner_id=? AND operation='candidate' AND request_id=?",
          )
          .get(actor.organizationId, actor.userId, requestId)
        const parameters = digest(JSON.stringify({ runId, expectedRevision }))
        if (prior !== undefined) {
          if (prior.request_hash !== parameters)
            throw new EducationError('idempotency-conflict', 'candidate request changed')
          return this.runDTO(actor, this.ownedRun(actor, runId))
        }
        const row = this.ownedRun(actor, runId)
        if (row.status !== 'failed' || row.error_code !== 'draft-conflict' || typeof row.candidate !== 'string')
          throw conflict()
        const snapshot = decodeRunSnapshot(text(row, 'snapshot_json'))
        if (snapshot.scenario !== 'text-analysis' && snapshot.mode === 'selection')
          throw new EducationError(
            'validation-failed',
            'a selection conflict requires a new selection on the current text',
          )
        this.assertWritable(actor, id(row.artifact_id))
        this.checkContext(actor, row)
        const draft = this.db.prepare('SELECT revision FROM drafts WHERE artifact_id=?').get(text(row, 'artifact_id'))
        if (draft?.revision !== expectedRevision) throw conflict()
        this.commit(actor, { ...row, expected_revision: expectedRevision }, row.candidate, text(row, 'explanation'))
        this.db
          .prepare('INSERT INTO creation_receipts VALUES(?,?,?,?,?,?)')
          .run(actor.organizationId, actor.userId, 'candidate', requestId, parameters, JSON.stringify({ runId, key }))
        return this.runDTO(actor, this.ownedRun(actor, runId))
      },
      true,
    )
  }
  interruptPending(): number {
    return this.owner.system(() => {
      this.db
        .prepare("UPDATE research_attempts SET status='unknown',finished_at=? WHERE status IN('prepared','running')")
        .run(now())
      return Number(
        this.db
          .prepare(
            "UPDATE creation_runs SET status='interrupted',error_code='process-interrupted',updated_at=? WHERE status IN('pending','running')",
          )
          .run(now()).changes,
      )
    })
  }
  abandon(runId: RunId, status: 'failed' | 'cancelled' | 'interrupted', errorCode: string): void {
    this.owner.system(() => {
      this.db
        .prepare(
          "UPDATE creation_runs SET status=?,error_code=?,updated_at=? WHERE id=? AND status IN('pending','running')",
        )
        .run(status, errorCode, now(), runId)
    })
  }
  private settle(row: Row, status: RunDTO['status'], errorCode: string): void {
    this.db
      .prepare('UPDATE creation_runs SET status=?,error_code=?,updated_at=? WHERE id=?')
      .run(status, errorCode, now(), text(row, 'id'))
  }
  private checkContext(actor: ActorContext, row: Row): void {
    if (!this.permitted(actor, decodeBasis(text(row, 'basis_json')), 'use_for_ai')) throw unavailable()
    const snapshot = decodeRunSnapshot(text(row, 'snapshot_json'))
    if (snapshot.scenario !== 'text-analysis') {
      if (this.profile(actor)?.id !== snapshot.profile.id) throw conflict()
    } else if (this.owner.artifact(actor, id(row.artifact_id)).latest_version_id !== snapshot.expectedLatestVersionId)
      throw conflict()
  }
  private ownedRun(actor: ActorContext, runId: RunId): Row {
    const row = this.db
      .prepare('SELECT * FROM creation_runs WHERE id=? AND organization_id=? AND owner_id=?')
      .get(runId, actor.organizationId, actor.userId)
    if (row === undefined) throw unavailable()
    return row
  }
  private status(row: Row): RunDTO['status'] {
    const value = row.status
    if (
      value !== 'pending' &&
      value !== 'running' &&
      value !== 'completed' &&
      value !== 'failed' &&
      value !== 'cancelled' &&
      value !== 'interrupted'
    )
      throw new EducationError('storage-unavailable', 'stored run status is invalid')
    return value
  }
  private runDTO(actor: ActorContext, row: Row): RunDTO {
    const restricted = !this.permitted(actor, decodeBasis(text(row, 'basis_json')))
    const snapshot = decodeRunSnapshot(text(row, 'snapshot_json'))
    return {
      id: id(row.id),
      requestId: id(row.request_id),
      artifactId: id(row.artifact_id),
      projectId: id(row.project_id),
      status: this.status(row),
      expectedDraftRevision: integer(row.expected_revision),
      draftRevision: row.draft_revision === null ? null : integer(row.draft_revision),
      errorCode: row.error_code === null ? null : text(row, 'error_code'),
      candidate: restricted || row.candidate === null ? null : text(row, 'candidate'),
      explanation: restricted || row.explanation === null ? null : text(row, 'explanation'),
      restricted,
      sessionId: row.session_id === null || restricted ? null : brandString<SessionId>(text(row, 'session_id')),
      contextFingerprint: snapshot.contextFingerprint,
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
    }
  }
  private receipt<T>(
    actor: ActorContext,
    operation: string,
    input: { requestId: RequestId },
    decode: (json: string) => T,
    perform: () => T,
  ): T {
    const requestHash = digest(JSON.stringify(input))
    const prior = this.db
      .prepare(
        'SELECT * FROM creation_receipts WHERE organization_id=? AND owner_id=? AND operation=? AND request_id=?',
      )
      .get(actor.organizationId, actor.userId, operation, input.requestId)
    if (prior !== undefined) {
      if (prior.request_hash !== requestHash)
        throw new EducationError('idempotency-conflict', 'request identity was reused with different values')
      const value = decode(text(prior, 'result_json'))
      // Source receipts are reconstructed from current authorization, never a frozen allow=true copy.
      if (operation.startsWith('sources.')) {
        const source = decodeSource(text(prior, 'result_json'))
        return decode(JSON.stringify(this.source(actor, source.id, source.versionId)))
      }
      return value
    }
    const result = perform()
    this.db
      .prepare('INSERT INTO creation_receipts VALUES(?,?,?,?,?,?)')
      .run(actor.organizationId, actor.userId, operation, input.requestId, requestHash, JSON.stringify(result))
    return result
  }
  private body(value: string, required = false): string {
    const result = value.replaceAll('\r\n', '\n')
    if (
      !result.isWellFormed() ||
      (required && result.trim() === '') ||
      Buffer.byteLength(result) > this.owner.maxBodyBytes
    )
      throw new EducationError('validation-failed', 'creation text is empty, malformed or exceeds the configured limit')
    return result
  }
  private selection(snapshot: CreationInputSnapshot) {
    const selection = snapshot.selection
    if (
      selection === undefined ||
      !Number.isSafeInteger(selection.start) ||
      !Number.isSafeInteger(selection.end) ||
      selection.start < 0 ||
      selection.end <= selection.start ||
      selection.end > snapshot.draft.length ||
      selection.bodyHash !== digest(snapshot.draft) ||
      snapshot.draft.slice(selection.start, selection.end) !== selection.original ||
      !snapshot.draft.slice(0, selection.start).isWellFormed() ||
      !snapshot.draft.slice(selection.end).isWellFormed()
    )
      throw new EducationError('validation-failed', 'selection no longer matches the complete LF draft')
    return selection
  }
}
