/** Public education Remote requests and project follow frames. */
import type {
  ArtifactId,
  ArtifactVersionId,
  EducationProjectCommit,
  PageInput,
  ProjectId,
  ProjectState,
  RequestId,
  WriteOperation,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import type { ImportResearchSourceInput } from '@deepseek-ai/dsh-experimental-education-platform/types'
export type { EducationRemoteErrorCode } from './error-codes.ts'
/** Explicit user confirmation precedes source import; external origin IDs never establish authority. */
export interface ResearchImportRequest extends ImportResearchSourceInput {
  readonly confirmed: true
}

/** Project-specific read or subscription; ownership is resolved on the Host. */
export interface ProjectRequest {
  readonly projectId: ProjectId
}
/** Artifact-specific read. */
export interface ArtifactRequest {
  readonly artifactId: ArtifactId
}
/** Bounded version metadata page. */
export interface VersionPageRequest extends PageInput {
  readonly artifactId: ArtifactId
}
/** Immutable version read. */
export interface VersionRequest extends ArtifactRequest {
  readonly versionId: ArtifactVersionId
}
/** Query a prior write after an uncertain transport outcome. */
export interface ResultRequest {
  readonly operation: WriteOperation
  readonly requestId: RequestId
}
/** Explicit text source; draft and historical version are never inferred from one another. */
export type ExportTextRequest =
  | { readonly artifactId: ArtifactId; readonly target: 'draft' }
  | { readonly artifactId: ArtifactId; readonly target: 'version'; readonly versionId: ArtifactVersionId }
/** Authoritative opening snapshot followed by body-free, coalescible commit notifications. */
export type ProjectFollowFrame =
  | { readonly type: 'snapshot'; readonly state: ProjectState }
  | {
    readonly type: 'committed'
    readonly projectId: ProjectId
    readonly operation: EducationProjectCommit['operation']
    readonly requestId: RequestId
  }

/** Deployment limits for long-lived project subscriptions. */
export interface Config {
  /** Validated deployment-owned RedFox transport, capability and budget configuration. Disabled by default. */
  readonly analytics?: unknown
  /** Maximum simultaneous project follow subscriptions. @default 100 */
  readonly maxFollowers?: number
  /** Explicitly opt this profile into model creation. @default false */
  readonly creationEnabled?: boolean
  /** Explicitly enable source-only research through the same native run owner. @default false */
  readonly researchEnabled?: boolean
  /** Maximum native output tokens per research attempt. @default 8192 */
  readonly researchMaxTokens?: number
  /** Bounded completed-invalid-output attempts, including the first call. @default 2 */
  readonly researchMaxAttempts?: number
  /** Overall deadline across all attempts of a research run. @default 300000 */
  readonly researchTimeoutMs?: number
  /** Native model route. @default deepseek-official */
  readonly provider?: string
  /** Native model identity. @default deepseek-flash */
  readonly model?: string
  /** Native credential reference, never its value. @default DEEPSEEK_API_KEY */
  readonly credentialRef?: string
  /** Complete fixed input including the policy, in UTF-8 bytes. @default 120000 */
  readonly maxInputBytes?: number
  /** Maximum concurrent owned model generations. @default 4 */
  readonly maxConcurrentGenerations?: number
  /** Bounded generation deadline. @default 120000 */
  readonly generationTimeoutMs?: number
  /** Maximum output tokens. @default 4096 */
  readonly maxTokens?: number
  /** Explicit content rules identity recorded with every new input. @default education-content-v3 */
  readonly policyVersion?: string
}
