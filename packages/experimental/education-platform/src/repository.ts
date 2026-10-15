/** Host repository requirements; credential records are excluded from the browser DTO export. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CreationRepository } from './creation-types.ts'
import type { KnowledgeRepository } from './knowledge-types.ts'
import type { ResearchRepository } from './research-types.ts'
import type { TransferRepository } from './transfer-types.ts'
import type { AnalyticsRepository, SyncRepository } from './analytics-types.ts'
import type {
  ActorContext,
  ArtifactDTO,
  DraftDTO,
  EducationProjectCommit,
  EducationResourceLimits,
  ArtifactId,
  ArtifactVersionDTO,
  ArtifactVersionId,
  ArtifactVersionSummary,
  BindSessionInput,
  CreateProjectInput,
  DraftCommitted,
  LoginSessionId,
  OrganizationId,
  Page,
  PageInput,
  ProjectCreated,
  ProjectDTO,
  ProjectId,
  ProjectState,
  RequestId,
  RestoreVersionInput,
  SaveVersionInput,
  SessionBindingDTO,
  SessionBound,
  SyncDraftInput,
  UserDTO,
  UserId,
  VersionSaved,
  WriteOperation,
  WriteResult,
} from './types.ts'

/** Operator-owned account creation input; never a browser response. */
export interface ProvisionUserInput {
  readonly organizationId: OrganizationId
  readonly usernameNormalized: string
  readonly credentialHash: string
  readonly credentialSalt: string
}

/** Private password record used only by the identity provider. */
export interface UserCredentialRecord {
  readonly user: UserDTO
  readonly credentialHash: string
  readonly credentialSalt: string
  readonly status: 'active' | 'disabled'
  readonly authRevision: number
}

/** Server-generated hashed token and permissions baseline. */
export interface CreateLoginSessionInput {
  readonly organizationId: OrganizationId
  readonly userId: UserId
  readonly tokenHash: string
  readonly authRevision: number
  readonly expiresAt: string
}

/** Transactional repository: all private operations revalidate the durable login and ownership. */
export interface EducationRepository {
  /** Creation transactions share this provider's medium, actor checks and version history. */
  readonly creation: CreationRepository
  /** Query-layer filtered source search and exact-version reads. */
  readonly knowledge: KnowledgeRepository
  /** Source-only analysis reuses this repository's artifacts, fixed runs and formal versions. */
  readonly research: ResearchRepository
  /** Private account grants, source-separated saved observations and explicit import confirmations. */
  readonly analytics: AnalyticsRepository
  /** Shared durable provider budgets, checkpoints and business-authorized daily plans. */
  readonly sync: SyncRepository
  /** Explicit reference transfers never edit the employee profile or start a model turn. */
  readonly transfers: TransferRepository
  /** Active monotonic physical schema version. */
  readonly schemaVersion: number
  /** Effective byte and page bounds selected by this provider. */
  readonly limits: EducationResourceLimits
  /**
   * Observe successful new commits; callback failures cannot change their durable outcome.
   * @param listener - synchronous Host callback receiving only resource metadata.
   * @returns disposer removing this exact observer.
   */
  onProjectCommit(listener: (commit: EducationProjectCommit) => unknown): () => void
  /**
   * Return authorized metadata without text.
   * @param actor - trusted request identity.
   * @param artifactId - private artifact.
   * @returns authorized metadata without text.
   */
  readArtifact(actor: ActorContext, artifactId: ArtifactId): ArtifactDTO
  /**
   * Return authoritative current draft.
   * @param actor - trusted request identity.
   * @param artifactId - private artifact.
   * @returns authoritative current draft.
   */
  readDraft(actor: ActorContext, artifactId: ArtifactId): DraftDTO
  /**
   * Recheck every current upstream export grant for an explicit draft or version download.
   * @param actor - current trusted employee.
   * @param artifactId - requested owned artifact.
   * @param versionId - exact saved version, or null for the current draft.
   */
  requireArtifactExport(actor: ActorContext, artifactId: ArtifactId, versionId: ArtifactVersionId | null): void
  /**
   * Validate the configured identity organization's current existence and active state.
   * @param organizationId - deployment-controlled organization identifier.
   */
  requireActiveOrganization(organizationId: OrganizationId): void
  /**
   * Read public fields of the currently authorized employee.
   * @param actor - trusted request identity.
   * @returns that employee's public DTO, without selecting credential fields.
   */
  readSelf(actor: ActorContext): UserDTO
  /**
   * Return newly created organization identity.
   * @param name - organization name for controlled setup.
   * @returns newly created organization identity.
   */
  provisionOrganization(name: string): OrganizationId
  /**
   * Return public employee fields.
   * @param input - controlled account credentials.
   * @returns public employee fields.
   */
  provisionUser(input: ProvisionUserInput): UserDTO
  /**
   * Return private credential record or null.
   * @param organizationId - configured organization.
   * @param username - already normalized login name.
   * @returns private credential record or null.
   */
  findUserCredentials(organizationId: OrganizationId, username: string): UserCredentialRecord | null
  /**
   * Return durable login identity.
   * @param input - trusted credential verification result.
   * @returns durable login identity.
   */
  createLoginSession(input: CreateLoginSessionInput): LoginSessionId
  /**
   * Return actor for an active organization, employee and login, or null.
   * @param tokenHash - digest of the request's cookie.
   * @returns actor for an active organization, employee and login, or null.
   */
  resolveLoginSession(tokenHash: string): ActorContext | null
  /**
   * Revoke the selected persistent login without changing other sessions.
   * @param loginSessionId - trusted login to revoke.
   */
  revokeLoginSession(loginSessionId: LoginSessionId): void
  /**
   * Change account status and invalidate its previous login revisions.
   * @param organizationId - controlled organization.
   * @param userId - controlled employee.
   * @param status - new status; every change invalidates old logins.
   */
  setUserStatus(organizationId: OrganizationId, userId: UserId, status: 'active' | 'disabled'): void
  /**
   * Return original committed result on same-key replay.
   * @param actor - trusted request identity.
   * @param input - project and request parameters.
   * @returns original committed result on same-key replay.
   */
  createProject(actor: ActorContext, input: CreateProjectInput): ProjectCreated
  /**
   * Return only the actor's project summaries.
   * @param actor - trusted request identity.
   * @param input - actor-bound pagination.
   * @returns only the actor's project summaries.
   */
  listProjects(actor: ActorContext, input: PageInput): Page<ProjectDTO>
  /**
   * Return authoritative current project, artifact and draft.
   * @param actor - trusted request identity.
   * @param projectId - requested private project.
   * @returns authoritative current project, artifact and draft.
   */
  openProject(actor: ActorContext, projectId: ProjectId): ProjectState
  /**
   * Return committed metadata; stale baselines write nothing.
   * @param actor - trusted request identity.
   * @param input - draft and revision baseline.
   * @returns committed metadata; stale baselines write nothing.
   */
  syncDraft(actor: ActorContext, input: SyncDraftInput): DraftCommitted
  /**
   * Return immutable committed version reference.
   * @param actor - trusted request identity.
   * @param input - draft and formal pointer baselines.
   * @returns immutable committed version reference.
   */
  saveVersion(actor: ActorContext, input: SaveVersionInput): VersionSaved
  /**
   * Return immutable version metadata without full text.
   * @param actor - trusted request identity.
   * @param artifactId - requested artifact.
   * @param input - actor and artifact-bound page.
   * @returns immutable version metadata without full text.
   */
  listVersions(actor: ActorContext, artifactId: ArtifactId, input: PageInput): Page<ArtifactVersionSummary>
  /**
   * Return original saved text and basis.
   * @param actor - trusted request identity.
   * @param artifactId - containing artifact.
   * @param versionId - requested version.
   * @returns original saved text and basis.
   */
  readVersion(actor: ActorContext, artifactId: ArtifactId, versionId: ArtifactVersionId): ArtifactVersionDTO
  /**
   * Return revised draft metadata, with the formal pointer unchanged.
   * @param actor - trusted request identity.
   * @param input - historical source and current draft baseline.
   * @returns revised draft metadata, with the formal pointer unchanged.
   */
  restoreVersion(actor: ActorContext, input: RestoreVersionInput): DraftCommitted
  /**
   * Return original result or null; null does not settle a concurrent request.
   * @param actor - current trusted request identity.
   * @param operation - original operation.
   * @param requestId - original request identity.
   * @returns original result or null; null does not settle a concurrent request.
   */
  getResult(actor: ActorContext, operation: WriteOperation, requestId: RequestId): WriteResult | null
  /**
   * Return committed unique association.
   * @param actor - trusted request identity.
   * @param input - same-owner business resources and controlled native session.
   * @returns committed unique association.
   */
  bindSession(actor: ActorContext, input: BindSessionInput): SessionBound
  /**
   * Return same-owner binding or rejects uniformly with resource-unavailable.
   * @param actor - trusted request identity.
   * @param harnessSessionId - requested native session.
   * @returns same-owner binding or rejects uniformly with resource-unavailable.
   */
  getSessionBinding(actor: ActorContext, harnessSessionId: SessionId): SessionBindingDTO
  /**
   * Revoke an owned native association without deleting its Session or history.
   * @param actor - current trusted resource owner.
   * @param harnessSessionId - native association to invalidate.
   */
  invalidateSessionBinding(actor: ActorContext, harnessSessionId: SessionId): void
  /** Release the medium synchronously after short operations settle; repeated calls are safe. */
  close(): void
}
