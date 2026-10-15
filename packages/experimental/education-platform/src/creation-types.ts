/** Browser-safe creation data; credentials and runtime handles never belong to these records. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ActorContext, ArtifactId, BasisSnapshot, DraftCommitted, ProjectId, RequestId, UserId } from './types.ts'
import type { GenerationInputSnapshot } from './research-types.ts'

/** Immutable owner profile revision. */
export type ProfileVersionId = Branded<'EducationProfileVersionId'>
/** Private source identity, independent of its current authorization. */
export type SourceId = Branded<'EducationSourceId'>
/** Immutable source text revision. */
export type SourceVersionId = Branded<'EducationSourceVersionId'>
/** Durable one-request generation identity. */
export type RunId = Branded<'EducationRunId'>
/** Supported creation scenarios. */
export type CreationScenario = 'spoken-script' | 'moments'
/** Facts are explicitly separate from stylistic preferences. */
export interface ProfileContent {
  readonly facts: string
  readonly preferences: string
  readonly prohibitedPromises: string
}
/** Immutable profile version and current optimistic pointer. */
export interface ProfileVersion extends ProfileContent {
  readonly id: ProfileVersionId
  readonly revision: number
  readonly bodyHash: string
  readonly createdAt: string
}
/** Current source authorization and immutable selected text. Revocation hides text. */
export interface SourceDTO {
  /** Derived references describe another creator or account; their facts never become the employee's biography. */
  readonly purpose?: 'reference-method' | undefined
  readonly id: SourceId
  readonly title: string
  readonly sourceUrl: string
  readonly revision: number
  readonly authorizationRevision: number
  readonly authorized: boolean
  readonly versionId: SourceVersionId
  readonly body: string
  readonly bodyHash: string
  readonly createdAt: string
}
/** Server-captured immutable source evidence, rechecked against the current grant. */
export interface SourceReference {
  readonly sourceId: SourceId
  readonly versionId: SourceVersionId
  readonly ownerId: UserId
  readonly bodyHash: string
  readonly authorizationRevision: number
}
/** Real context branch; old foundation versions remain unchanged. */
export interface CreationBasis {
  readonly source: 'creation-context'
  readonly profileVersionIds: readonly ProfileVersionId[]
  readonly materialVersionIds: readonly SourceVersionId[]
  readonly references: readonly SourceReference[]
  readonly runId: RunId
  readonly contextFingerprint: string
  readonly policyVersion: string
}
/** LF text coordinates use JavaScript UTF-16 indices and cannot split surrogate pairs. */
export interface TextSelection {
  readonly start: number
  readonly end: number
  readonly bodyHash: string
  readonly original: string
}
/** Exact request retained for safe one-key retries. */
export interface StartCreationInput {
  readonly artifactId: ArtifactId
  readonly requestId: RequestId
  readonly expectedDraftRevision: number
  readonly profileVersionId: ProfileVersionId
  readonly sourceVersionIds: readonly SourceVersionId[]
  readonly instruction: string
  readonly mode: 'generate' | 'modify' | 'selection'
  readonly selection?: TextSelection
}
/** Immutable complete model input, including the current editable text. */
export interface CreationInputSnapshot {
  readonly scenario: CreationScenario
  readonly profile: ProfileVersion
  readonly sources: readonly SourceDTO[]
  readonly draft: string
  readonly instruction: string
  readonly mode: StartCreationInput['mode']
  readonly selection?: TextSelection
  readonly contextFingerprint: string
  readonly policyVersion: string
  readonly capabilities: readonly []
}
/** Persisted outcome; completed means the full candidate was committed to the draft. */
export interface RunDTO {
  readonly id: RunId
  readonly requestId: RequestId
  readonly artifactId: ArtifactId
  readonly projectId: ProjectId
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly expectedDraftRevision: number
  readonly draftRevision: number | null
  readonly errorCode: string | null
  readonly candidate: string | null
  readonly explanation: string | null
  readonly restricted: boolean
  readonly sessionId: SessionId | null
  readonly contextFingerprint: string
  readonly createdAt: string
  readonly updatedAt: string
}
/** Owner-visible conversation, redacted when its original context loses authorization. */
export interface DialogueMessage {
  readonly id: string
  readonly runId: RunId
  readonly role: 'user' | 'assistant'
  readonly body: string
  readonly restricted: boolean
  readonly createdAt: string
}
/** Current owner-scoped creation state; no live Agent is resumed by reading. */
export interface CreationState {
  readonly run: RunDTO | null
  readonly dialogue: readonly DialogueMessage[]
  readonly basis: BasisSnapshot
  readonly restricted: boolean
}
/** Profile version append with compare-and-swap and an original write identity. */
export interface SaveProfileInput extends ProfileContent {
  readonly expectedRevision: number
  readonly requestId: RequestId
}
/** Source text append; authorization changes use a separate method and revision. */
export interface SaveSourceInput {
  readonly sourceId?: SourceId
  readonly expectedRevision: number
  readonly title: string
  readonly body: string
  readonly sourceUrl: string
  readonly requestId: RequestId
}
/** Exact current authorization baseline; reauthorizing cannot revive old snapshots. */
export interface AuthorizeSourceInput {
  readonly sourceId: SourceId
  readonly authorized: boolean
  readonly expectedAuthorizationRevision: number
  readonly requestId: RequestId
}
/** Non-model writes that retain actor-scoped original receipts. */
export type CreationMutation = 'profiles.save' | 'sources.save' | 'sources.authorize' | 'context.reset'
/** Safe original outcomes; source text is checked against the current grant again. */
export type CreationMutationResult = ProfileVersion | SourceDTO | DraftCommitted
/** Transactional creation operations on the same business repository and database. */
export interface CreationRepository {
  /**
   * Return empty draft metadata while preserving all formal history.
   * @param actor - trusted owner.
   * @param artifactId - affected artifact.
   * @param expectedRevision - current draft baseline.
   * @param requestId - explicit reset identity.
   * @returns empty draft metadata while preserving all formal history.
   */
  resetContext(
    actor: ActorContext,
    artifactId: ArtifactId,
    expectedRevision: number,
    requestId: RequestId,
  ): DraftCommitted
  /**
   * Return original authorized outcome or null, which does not settle concurrent work.
   * @param actor - trusted owner.
   * @param operation - original non-model write.
   * @param requestId - original identity.
   * @returns original authorized outcome or null, which does not settle concurrent work.
   */
  mutationResult(actor: ActorContext, operation: CreationMutation, requestId: RequestId): CreationMutationResult | null
  /**
   * Return current immutable profile or null.
   * @param actor - trusted owner.
   * @returns current immutable profile or null.
   */
  readProfile(actor: ActorContext): ProfileVersion | null
  /**
   * Save employee-confirmed facts as an immutable profile version.
   * @param actor - trusted owner.
   * @param input - facts and optimistic pointer.
   * @returns newly appended profile or the original receipt.
   */
  saveProfile(actor: ActorContext, input: SaveProfileInput): ProfileVersion
  /**
   * Return bounded source metadata and currently permitted text.
   * @param actor - trusted owner.
   * @returns bounded source metadata and currently permitted text.
   */
  listSources(actor: ActorContext): readonly SourceDTO[]
  /**
   * Save explicitly selected private source text and its version.
   * @param actor - trusted owner.
   * @param input - private text and revision.
   * @returns immutable appended source version.
   */
  saveSource(actor: ActorContext, input: SaveSourceInput): SourceDTO
  /**
   * Change the current source grant using its displayed revision.
   * @param actor - trusted owner.
   * @param input - independent current grant baseline.
   * @returns source after authorization commit.
   */
  authorizeSource(actor: ActorContext, input: AuthorizeSourceInput): SourceDTO
  /**
   * Start one owner-scoped content operation outside the database transaction.
   * @param actor - trusted owner.
   * @param input - complete creation request.
   * @param policyVersion - configured policy identity.
   * @param maxInputBytes - full JSON input cap.
   * @returns durable run, with no model call in the transaction.
   */
  start(actor: ActorContext, input: StartCreationInput, policyVersion: string, maxInputBytes: number): RunDTO
  /**
   * Return private snapshot only while all current grants and profile remain valid.
   * @param actor - trusted owner.
   * @param runId - original run.
   * @returns private snapshot only while all current grants and profile remain valid.
   */
  input(actor: ActorContext, runId: RunId): CreationInputSnapshot
  /**
   * Read a fixed creation or source-only research input under current grants.
   * @param actor - trusted owner.
   * @param runId - owned original run.
   * @returns discriminated immutable input without resuming native execution.
   */
  runInput(actor: ActorContext, runId: RunId): GenerationInputSnapshot
  /**
   * Return running record.
   * @param actor - trusted owner.
   * @param runId - original run.
   * @param sessionId - controlled, already bound Session.
   * @returns running record.
   */
  markRunning(actor: ActorContext, runId: RunId, sessionId: SessionId): RunDTO
  /**
   * Return durable committed or failed run; authorization and draft conflicts never overwrite text.
   * @param actor - trusted owner.
   * @param runId - original run.
   * @param body - validated complete candidate or selected replacement.
   * @param explanation - separate assistant explanation.
   * @returns durable committed or failed run; authorization and draft conflicts never overwrite text.
   */
  complete(actor: ActorContext, runId: RunId, body: string, explanation: string): RunDTO
  /**
   * Return settled record; completed records are not reversed.
   * @param actor - trusted owner.
   * @param runId - original run.
   * @param status - terminal failure.
   * @param errorCode - safe handling category.
   * @returns settled record; completed records are not reversed.
   */
  fail(actor: ActorContext, runId: RunId, status: 'failed' | 'cancelled' | 'interrupted', errorCode: string): RunDTO
  /**
   * Return current record with revoked content redacted.
   * @param actor - trusted owner.
   * @param runId - private run.
   * @returns current record with revoked content redacted.
   */
  getRun(actor: ActorContext, runId: RunId): RunDTO
  /**
   * Return original run or null; absence does not settle a concurrent request.
   * @param actor - trusted owner.
   * @param requestId - original request identity.
   * @returns original run or null; absence does not settle a concurrent request.
   */
  findRun(actor: ActorContext, requestId: RequestId): RunDTO | null
  /**
   * Return current conversation and run.
   * @param actor - trusted owner.
   * @param artifactId - private artifact.
   * @returns current conversation and run.
   */
  readState(actor: ActorContext, artifactId: ArtifactId): CreationState
  /**
   * Return committed metadata, without another model call.
   * @param actor - trusted owner.
   * @param runId - failed authorized candidate.
   * @param expectedRevision - latest confirmed draft.
   * @param requestId - original explicit application.
   * @returns committed metadata, without another model call.
   */
  applyCandidate(actor: ActorContext, runId: RunId, expectedRevision: number, requestId: RequestId): RunDTO
  /**
   * Mark only unsettled records interrupted on exclusive process startup; never replay a model request.
   * @returns number of interrupted runs.
   */
  interruptPending(): number
  /**
   * Settle only a runtime-owned unsettled record after its initiating login expires; never exposed to the Client.
   * @param runId - runtime-owned run.
   * @param status - terminal failure.
   * @param errorCode - safe handling category.
   */
  abandon(runId: RunId, status: 'failed' | 'cancelled' | 'interrupted', errorCode: string): void
}
