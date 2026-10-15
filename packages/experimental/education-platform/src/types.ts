/** Browser-safe education identifiers, private resource DTOs, and write results. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CreationBasis, CreationScenario } from './creation-types.ts'
import type { ResearchArtifactCreated, ResearchBasis } from './research-types.ts'
export type * from './creation-types.ts'
export type * from './knowledge-types.ts'
export type * from './analytics-types.ts'
export type * from './research-types.ts'
export type { ContentPlatform } from './data-provider.ts'

/** Stable organization identity. */
export type OrganizationId = Branded<'EducationOrganizationId'>
/** Stable employee identity. */
export type UserId = Branded<'EducationUserId'>
/** One durable login, independent of other logins by the same employee. */
export type LoginSessionId = Branded<'EducationLoginSessionId'>
/** Private project identity. */
export type ProjectId = Branded<'EducationProjectId'>
/** Private artifact identity. */
export type ArtifactId = Branded<'EducationArtifactId'>
/** Immutable artifact version identity. */
export type ArtifactVersionId = Branded<'EducationArtifactVersionId'>
/** Client-generated write identity, reused after uncertain outcomes. */
export type RequestId = Branded<'EducationRequestId'>
/** One unique Harness-to-business session association. */
export type SessionBindingId = Branded<'EducationSessionBindingId'>

/** Trusted server-resolved actor; client owner fields never establish this value. */
export interface ActorContext {
  readonly organizationId: OrganizationId
  readonly userId: UserId
  readonly loginSessionId: LoginSessionId
  readonly authRevision: number
}

/** Employee fields safe to return to that employee. */
export interface UserDTO {
  readonly id: UserId
  readonly organizationId: OrganizationId
  readonly username: string
}

/** Private project summary, without full artifact text. */
export interface ProjectDTO {
  readonly id: ProjectId
  readonly title: string
  readonly scenario: CreationScenario
  readonly primaryArtifactId: ArtifactId
  readonly createdAt: string
  readonly updatedAt: string
}

/** Artifact metadata and its current immutable version pointer. */
export interface ArtifactDTO {
  readonly id: ArtifactId
  readonly projectId: ProjectId
  readonly kind: CreationScenario | 'text-analysis'
  readonly latestVersionId: ArtifactVersionId | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** Current editable text, independently revised from formal versions. */
export interface DraftDTO {
  readonly artifactId: ArtifactId
  readonly body: string
  readonly bodyHash: string
  readonly revision: number
  readonly updatedAt: string
  readonly restricted?: boolean
}

/** Stage-A validation uses no invented profile or material references. */
export interface FoundationBasis {
  readonly source: 'foundation-validation'
  readonly profileVersionIds: readonly []
  readonly materialVersionIds: readonly []
}
/** Old validation records and real creation evidence have distinct decoders. */
export type BasisSnapshot = FoundationBasis | CreationBasis | ResearchBasis

/** Immutable version metadata; full text is fetched separately. */
export interface ArtifactVersionSummary {
  readonly id: ArtifactVersionId
  readonly artifactId: ArtifactId
  readonly versionNo: number
  readonly bodyHash: string
  readonly savedBy: UserId
  readonly savedAt: string
}

/** One immutable version with its original text and saving basis. */
export interface ArtifactVersionDTO extends ArtifactVersionSummary {
  readonly body: string
  readonly basisSnapshot: BasisSnapshot
  readonly restricted?: boolean
}

/** Authoritative state read on project reopen; reading never writes. */
export interface ProjectState {
  readonly project: ProjectDTO
  readonly artifact: ArtifactDTO
  readonly draft: DraftDTO
  readonly latestVersion: ArtifactVersionSummary | null
  readonly sessionBindings: readonly SessionBindingDTO[]
}

/** Provider-enforced resource limits reused at the external input boundary. */
export interface EducationResourceLimits {
  readonly maxBodyBytes: number
  readonly maxTitleBytes: number
  readonly maxPageSize: number
}

/** Body-free notification emitted only after a new transaction commits. */
export interface EducationProjectCommit {
  readonly organizationId: OrganizationId
  readonly userId: UserId
  readonly projectId: ProjectId
  readonly operation: WriteOperation | 'sessions.invalidate'
  readonly requestId: RequestId
}

/** Owner-filtered page without a global resource count. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

/** Bound Harness session; binding does not make two databases atomic. */
export interface SessionBindingDTO {
  readonly id: SessionBindingId
  readonly projectId: ProjectId
  readonly artifactId: ArtifactId
  readonly harnessSessionId: SessionId
  readonly status: 'active' | 'invalid'
  readonly createdAt: string
}

/** Durable non-secret result of creating a project and its empty draft. */
export interface ProjectCreated {
  readonly operation: 'projects.create'
  readonly projectId: ProjectId
  readonly artifactId: ArtifactId
  readonly draftRevision: 0
}

/** Committed draft metadata; receipts do not retain a second copy of private text. */
export interface DraftCommitted {
  readonly operation: 'drafts.sync' | 'drafts.restoreVersion'
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly bodyHash: string
  readonly updatedAt: string
}

/** Committed immutable version reference and the checked draft baseline. */
export interface VersionSaved {
  readonly operation: 'artifacts.saveVersion'
  readonly artifactId: ArtifactId
  readonly versionId: ArtifactVersionId
  readonly versionNo: number
  readonly draftRevision: number
}

/** Durable session association result. */
export interface SessionBound {
  readonly operation: 'sessions.bind'
  readonly binding: SessionBindingDTO
}

/** Results that can be queried and replayed under the current authorized actor. */
export type WriteResult = ProjectCreated | DraftCommitted | VersionSaved | SessionBound | ResearchArtifactCreated
/** Public operation names accepted by request-result lookup. */
export type WriteOperation = WriteResult['operation']

/** Project creation parameters; ownership comes exclusively from the actor. */
export interface CreateProjectInput {
  readonly title: string
  readonly scenario: CreationScenario
  readonly requestId: RequestId
}

/** Explicit optimistic draft revision. */
export interface SyncDraftInput {
  readonly artifactId: ArtifactId
  readonly body: string
  readonly expectedDraftRevision: number
  readonly requestId: RequestId
}

/** Both baselines are required, including an explicit null for the first save. */
export interface SaveVersionInput {
  readonly artifactId: ArtifactId
  readonly expectedDraftRevision: number
  readonly expectedLatestVersionId: ArtifactVersionId | null
  readonly requestId: RequestId
}

/** Restoration revises the current draft and preserves the formal pointer. */
export interface RestoreVersionInput {
  readonly artifactId: ArtifactId
  readonly versionId: ArtifactVersionId
  readonly expectedDraftRevision: number
  readonly requestId: RequestId
}

/** Page size and an opaque cursor issued for the current actor and query. */
export interface PageInput {
  readonly limit: number
  readonly cursor?: string
}

/** Association parameters after the caller creates a controlled native session. */
export interface BindSessionInput {
  readonly projectId: ProjectId
  readonly artifactId: ArtifactId
  readonly harnessSessionId: SessionId
  readonly requestId: RequestId
}
export type * from './transfer-types.ts'
