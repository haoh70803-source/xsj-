/** Versioned research evidence and reports; original source text stays separate from model conclusions. */
import type {
  ActorContext,
  ArtifactDTO,
  ArtifactId,
  ArtifactVersionId,
  ArtifactVersionSummary,
  CreationBasis,
  CreationInputSnapshot,
  DraftDTO,
  ProjectId,
  RequestId,
  RunDTO,
  RunId,
  SourceDTO,
  SourceId,
  SourceReference,
  SourceVersionId,
} from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** JSON metadata is validated at import and remains untrusted material, never execution instructions. */
export type ResearchJson = null | boolean | number | string | ResearchJson[] | { [key: string]: ResearchJson }
/** Original text evidence has stable paragraph identifiers and no fabricated times. */
export interface ParagraphEvidence {
  readonly kind: 'text'
  readonly units: readonly {
    readonly id: string
    readonly text: string
    readonly startOffset: number
    readonly endOffset: number
  }[]
}
/** Transcript units retain real speech-segment timing and supplied ASR/review metadata. */
export interface TranscriptEvidence {
  readonly kind: 'transcript'
  readonly durationSeconds: number
  readonly units: readonly {
    readonly id: string
    readonly text: string
    readonly start: number
    readonly end: number
  }[]
  readonly language: string
  readonly asr: { readonly [key: string]: ResearchJson }
}
/** Explicit original evidence; textual paragraphs and timed transcripts do not share imaginary time fields. */
export type ResearchEvidence = ParagraphEvidence | TranscriptEvidence
/** Verifiable source origin metadata never establishes account ownership. */
export interface ResearchOrigin {
  readonly originalTitle: string | null
  readonly externalSourceId: string | null
  readonly sourceUrl: string
  readonly fileSha256: string | null
  readonly transcriptObjectSha256: string | null
  readonly videoInfo: { readonly [key: string]: ResearchJson }
}
/** Grounded selected source and exact evidence at analysis admission. */
export interface ResearchSource {
  readonly source: SourceDTO
  readonly evidence: ResearchEvidence
  readonly origin: ResearchOrigin
}
/** Verbatim evidence refers to one original unit, never a concatenation of unrelated snippets. */
export interface ResearchQuote {
  readonly source_id: string
  readonly quote: string
}
/** Model-owned report fields adapted from the delivered content-research-v3.1 format. */
export interface ResearchReport {
  readonly schema_version: 2
  readonly prompt_version: 'content-research-v3.1'
  readonly overview: {
    readonly thesis: string
    readonly audience: string
    readonly purpose: string
    readonly pain: string
    readonly takeaway: string
  }
  readonly compact: {
    readonly content_summary: string
    readonly main_summary: string
    readonly reasons: readonly { readonly title: string; readonly text: string }[]
  }
  readonly propagation: { readonly summary: string; readonly evidence: readonly ResearchQuote[] }
  readonly opening: {
    readonly title_promise: string
    readonly opening_move: string
    readonly payoff: string
    readonly evidence: readonly ResearchQuote[]
  }
  readonly ending: { readonly conclusion: string; readonly cta: string; readonly evidence: readonly ResearchQuote[] }
  readonly sections: readonly {
    readonly source_ids: readonly string[]
    readonly title: string
    readonly short_title: string
    readonly structure_tags: readonly string[]
    readonly analysis_short: string
    readonly role: string
    readonly summary: string
    readonly analysis: string
    readonly evidence: readonly ResearchQuote[]
  }[]
  readonly mechanisms: readonly {
    readonly title: string
    readonly analysis: string
    readonly audience_reason: string
    readonly connection: string
    readonly learn: string
    readonly evidence: readonly ResearchQuote[]
  }[]
  readonly sidebar_analysis: {
    readonly blocks: readonly {
      readonly title: string
      readonly text: string
      readonly source_ids: readonly string[]
    }[]
  }
  readonly methods: readonly {
    readonly title: string
    readonly how: string
    readonly example: string
    readonly condition: string
    readonly evidence: readonly ResearchQuote[]
  }[]
  readonly creative_directions: readonly {
    readonly title: string
    readonly angle: string
    readonly basis: string
    readonly opening_idea: string
    readonly outline: readonly string[]
    readonly what_to_keep: string
    readonly what_to_change: string
    readonly materials: readonly string[]
    readonly evidence: readonly ResearchQuote[]
  }[]
  readonly issues: readonly {
    readonly title: string
    readonly analysis: string
    readonly evidence: readonly ResearchQuote[]
  }[]
  readonly creation_note?: string
}
/** Server-built research artifact body; it remains a string in the existing draft/version store. */
export interface ResearchDocument {
  readonly kind: 'research-report'
  readonly version: 1
  readonly report: ResearchReport
  readonly input: ResearchSource
  readonly generated: {
    readonly runId: RunId
    readonly policyVersion: string
    readonly provider: string
    readonly model: string
    readonly createdAt: string
  }
}
/** Old free text has an explicit migration envelope and is never mislabeled as a structured report. */
export interface LegacyResearchDocument {
  readonly kind: 'legacy-text'
  readonly version: 1
  readonly text: string
  readonly originId: string
}
/** Research evidence retains no creator profile; transfer to writing fetches a current profile separately. */
export interface ResearchBasis {
  readonly source: 'research-context'
  readonly profileVersionIds: readonly []
  readonly materialVersionIds: readonly SourceVersionId[]
  readonly references: readonly SourceReference[]
  readonly runId: RunId
  readonly contextFingerprint: string
  readonly policyVersion: string
}
/** Exact source-only model input, separately discriminated from personal content creation. */
export interface ResearchInputSnapshot {
  readonly scenario: 'text-analysis'
  readonly input: ResearchSource
  readonly instruction: string
  readonly contextFingerprint: string
  readonly policyVersion: string
  readonly expectedLatestVersionId: ArtifactVersionId | null
  readonly execution: {
    readonly provider: string
    readonly model: string
    readonly maxTokens: number
    readonly maxAttempts: number
    readonly timeoutMs: number
  }
  readonly capabilities: readonly []
}
/** Analysis execution has its own explicit formal and draft baselines. */
export interface StartResearchInput {
  readonly artifactId: ArtifactId
  readonly sourceVersionId: SourceVersionId
  readonly expectedDraftRevision: number
  readonly expectedLatestVersionId: ArtifactVersionId | null
  readonly requestId: RequestId
  readonly instruction: string
}
/** Same-project analysis creation leaves the primary writing artifact unchanged. */
export interface EnsureResearchInput {
  readonly projectId: ProjectId
  readonly requestId: RequestId
}
/** Transfer fixes report and original source versions; it never starts model execution. */
export interface ResearchTransferInput {
  readonly artifactId: ArtifactId
  readonly versionId: ArtifactVersionId
  readonly direction: number
  readonly requestId: RequestId
}
/** Shared version evidence accepts old foundation and creation branches alongside source-only research. */
export type RealContextBasis = CreationBasis | ResearchBasis

/** Creation and research have separate required inputs under one durable run lifecycle. */
export type GenerationInputSnapshot = CreationInputSnapshot | ResearchInputSnapshot
/** Same-project artifact receipt; replay never creates a duplicate analysis artifact. */
export interface ResearchArtifactCreated {
  readonly operation: 'artifacts.create'
  readonly projectId: ProjectId
  readonly primaryArtifactId: ArtifactId
  readonly artifactId: ArtifactId
  readonly kind: 'text-analysis'
  readonly draftRevision: number
  readonly created: boolean
}
/** Explicit source input; imported external source IDs never override the server actor or resource IDs. */
export interface ImportResearchSourceInput {
  readonly format: 'text' | 'research-input-v1'
  readonly title: string
  readonly content: string
  readonly sourceUrl: string
  readonly sourceId?: SourceId
  readonly expectedRevision: number
  readonly requestId: RequestId
}
/** Explicit old-text migration never claims validated structured research evidence. */
export interface ImportLegacyResearchInput {
  readonly artifactId: ArtifactId
  readonly text: string
  readonly originId: string
  readonly expectedDraftRevision: number
  readonly expectedLatestVersionId: ArtifactVersionId | null
  readonly requestId: RequestId
  readonly confirmed: true
}
/** Read-only current report surface; opening never resumes an Agent or starts an analysis. */
export interface ResearchState {
  readonly projectId: ProjectId
  readonly primaryArtifactId: ArtifactId
  readonly artifact: ArtifactDTO
  readonly draft: DraftDTO
  readonly latestVersion: ArtifactVersionSummary | null
  readonly document: ResearchDocument | LegacyResearchDocument | null
}
/** Structured immutable preview, separately authorized from the current draft. */
export interface ResearchVersion {
  readonly version: ArtifactVersionSummary
  readonly document: ResearchDocument | LegacyResearchDocument | null
  readonly restricted: boolean
}
/** Durable model attempt metadata; complete prompts and outputs live in its private native Session. */
export interface ResearchAttempt {
  readonly runId: RunId
  readonly attempt: number
  readonly bindingRequestId: RequestId
  readonly sessionId: SessionId | null
  readonly promptHash: string
  readonly status: 'prepared' | 'running' | 'completed' | 'failed' | 'unknown'
  readonly validationErrors: readonly string[]
}
/** Source-only analysis, sharing the original source, artifact, version, receipt and run stores. */
export interface ResearchRepository {
  /**
 * Migrate confirmed old text into an explicitly labeled legacy draft.
 * @param actor - current employee.
 * @param input - confirmed old text and both baselines.
 * @returns original draft acknowledgement with an explicit legacy envelope.
 */
  importLegacy(actor: ActorContext, input: ImportLegacyResearchInput): import('./types.ts').DraftCommitted
  /**
   * Import or correct source evidence atomically with its immutable text version.
   * @param actor - current trusted employee.
   * @param input - bounded original text or media-free V1 JSON and revision.
   * @returns selected source; no model or supplier request is issued.
   */
  importSource(actor: ActorContext, input: ImportResearchSourceInput): SourceDTO
  /**
   * Read original source text and evidence under current view grants.
   * @param actor - current trusted employee.
   * @param versionId - immutable selected source version.
   * @returns exact original evidence; external origin metadata grants no authority.
   */
  readSource(actor: ActorContext, versionId: SourceVersionId): ResearchSource
  /**
   * Ensure one analysis artifact within the already selected private project.
   * @param actor - current trusted employee.
   * @param input - project and original request identity.
   * @returns original artifact receipt, leaving the primary writing artifact unchanged.
   */
  ensureArtifact(actor: ActorContext, input: EnsureResearchInput): ResearchArtifactCreated
  /**
   * Open current report text without model execution or private Session history.
   * @param actor - current trusted employee.
   * @param artifactId - same-owner analysis artifact.
   * @returns current authorized report or redacted metadata.
   */
  open(actor: ActorContext, artifactId: ArtifactId): ResearchState
  /**
   * Atomically capture source-only input and acquire the existing artifact run occupancy.
   * @param actor - current trusted employee.
   * @param input - source version and both report baselines.
   * @param policyVersion - exact installed research-rule identity.
   * @param execution - selected native model settings.
   * @param maxInputBytes - complete fixed-input byte limit.
   * @returns original run without issuing a model request in the transaction.
   */
  start(
    actor: ActorContext,
    input: StartResearchInput,
    policyVersion: string,
    execution: ResearchInputSnapshot['execution'],
    maxInputBytes: number,
  ): RunDTO
  /**
   * Register one bounded repair attempt before native execution.
   * @param actor - current trusted employee.
   * @param runId - owned unsettled research run.
   * @param attempt - sequential attempt ordinal.
   * @param promptHash - complete actual prompt digest.
   * @returns original attempt metadata and binding key; changed retries are refused.
   */
  prepareAttempt(actor: ActorContext, runId: RunId, attempt: number, promptHash: string): ResearchAttempt
  /**
   * Record the native session and validation outcome of an owned attempt.
   * @param actor - current trusted employee.
   * @param runId - owned research run.
   * @param attempt - existing attempt ordinal.
   * @param sessionId - actual private native Session, if created.
   * @param status - current or terminal attempt state.
   * @param validationErrors - safe error paths retained for a subsequent explicit repair.
   */
  finishAttempt(
    actor: ActorContext,
    runId: RunId,
    attempt: number,
    sessionId: SessionId | null,
    status: ResearchAttempt['status'],
    validationErrors: readonly string[],
  ): void
  /**
   * Settle a runtime-owned abandoned attempt after its login authority is lost.
   * @param runId - run captured by the trusted runtime before authority loss.
   * @param attempt - owned active attempt.
   * @param validationErrors - safe failure categories; this cannot publish a successful report.
   */
  abandonAttempt(runId: RunId, attempt: number, validationErrors: readonly string[]): void
}
