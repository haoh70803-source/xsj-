/** Source-only research operations share the existing source, artifact, version and generation stores. */
import type { DatabaseSync } from 'node:sqlite'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import {
  EducationError,
  decodeResearchDocument,
  paragraphEvidence,
  parseResearchInputV1,
  validateResearchSource,
} from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  ActorContext,
  ArtifactId,
  BasisSnapshot,
  EnsureResearchInput,
  ImportResearchSourceInput,
  ResearchArtifactCreated,
  ResearchAttempt,
  ResearchBasis,
  ResearchInputSnapshot,
  ResearchRepository,
  ResearchSource,
  ResearchState,
  RunDTO,
  RunId,
  SourceDTO,
  SourceVersionId,
  StartResearchInput,
  ImportLegacyResearchInput,
  DraftCommitted,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { artifactDTO, digest, draftDTO, id, integer, newId, text, versionSummary, type Row } from './codec.ts'
import { decodeBasis, decodeRunSnapshot } from './creation-codec.ts'
import { sourceView } from './source-view.ts'
import type { SqliteCreationRepository } from './creation.ts'
import type { SqliteKnowledgeRepository } from './knowledge.ts'

interface Owner {
  writeLegacy(actor: ActorContext, input: ImportLegacyResearchInput): DraftCommitted
  transaction<T>(actor: ActorContext, work: () => T, write?: boolean): T
  system<T>(work: () => T): T
  artifact(actor: ActorContext, artifactId: ArtifactId): Row
  project(actor: ActorContext, projectId: EnsureResearchInput['projectId']): Row
  draft(actor: ActorContext, artifactId: ArtifactId): Row
  createArtifact(
    actor: ActorContext,
    input: EnsureResearchInput,
    perform: () => ResearchArtifactCreated,
  ): ResearchArtifactCreated
  readonly maxBodyBytes: number
  validateBody(actor: ActorContext, artifactId: ArtifactId, body: string, basis: BasisSnapshot): void
}
const unavailable = () => new EducationError('resource-unavailable', 'research resource is unavailable')
const conflict = () => new EducationError('draft-conflict', 'research baseline changed; reopen before continuing')
const evidenceRecord = z.strictObject({
  evidence: z.unknown(),
  origin: z.unknown(),
  canonicalTranscript: z.string().nullable(),
  purpose: z.enum(['original', 'reference-method']).optional(),
})

/** Same-medium research consumer; there is no separate identity, model loop or version database. */
export class SqliteResearchRepository implements ResearchRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: Owner,
    private readonly creation: SqliteCreationRepository,
    private readonly knowledge: SqliteKnowledgeRepository,
  ) {}
  importLegacy(actor: ActorContext, input: ImportLegacyResearchInput): DraftCommitted {
    return this.owner.writeLegacy(actor, input)
  }

  importSource(actor: ActorContext, input: ImportResearchSourceInput): SourceDTO {
    const body = input.content.replaceAll('\r\n', '\n')
    if (!input.content.isWellFormed() || Buffer.byteLength(input.content) > this.owner.maxBodyBytes)
      throw new EducationError('validation-failed', 'research import exceeds its configured byte limit')
    const parsed =
      input.format === 'research-input-v1'
        ? parseResearchInputV1(input.content, this.owner.maxBodyBytes)
        : {
          body,
          evidence: paragraphEvidence(body),
          origin: {
            originalTitle: null,
            externalSourceId: null,
            sourceUrl: input.sourceUrl,
            fileSha256: null,
            transcriptObjectSha256: null,
            videoInfo: {},
          },
          canonicalTranscript: null,
        }
    return this.creation.saveSourceWithMetadata(
      actor,
      {
        title: input.title,
        body: parsed.body,
        sourceUrl: parsed.origin.sourceUrl,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      },
      {
        kind: parsed.evidence.kind,
        evidenceJson: JSON.stringify({
          evidence: parsed.evidence,
          origin: parsed.origin,
          canonicalTranscript: parsed.canonicalTranscript,
        }),
        fileHash: parsed.origin.fileSha256,
        objectHash: parsed.origin.transcriptObjectSha256,
      },
    )
  }

  readSource(actor: ActorContext, versionId: SourceVersionId): ResearchSource {
    return this.owner.transaction(actor, () => this.sourceInside(actor, versionId, 'view'))
  }

  private sourceInside(
    actor: ActorContext,
    versionId: SourceVersionId,
    permission: 'view' | 'use_for_ai',
  ): ResearchSource {
    const row = this.db
      .prepare('SELECT source_id FROM source_versions WHERE id=? AND organization_id=? AND owner_id=?')
      .get(versionId, actor.organizationId, actor.userId)
    if (
      row === undefined ||
      !this.knowledge.sourcePermitted(actor, versionId, 'view') ||
      !this.knowledge.sourcePermitted(actor, versionId, permission)
    )
      throw unavailable()
    const source = sourceView(this.db, actor, id(row.source_id), versionId, selected =>
      this.knowledge.sourcePermitted(actor, selected, permission),
    )
    const metadata = this.db.prepare('SELECT * FROM source_evidence WHERE version_id=?').get(versionId)
    if (metadata === undefined)
      return validateResearchSource({
        source,
        evidence: paragraphEvidence(source.body),
        origin: {
          originalTitle: null,
          externalSourceId: null,
          sourceUrl: source.sourceUrl,
          fileSha256: null,
          transcriptObjectSha256: null,
          videoInfo: {},
        },
      })
    try {
      const record = evidenceRecord.parse(JSON.parse(text(metadata, 'evidence_json')))
      const input = validateResearchSource({ source, evidence: record.evidence, origin: record.origin })
      if (
        metadata.kind !== input.evidence.kind ||
        metadata.file_hash !== input.origin.fileSha256 ||
        metadata.object_hash !== input.origin.transcriptObjectSha256 ||
        (record.canonicalTranscript !== null &&
          digest(record.canonicalTranscript) !== input.origin.transcriptObjectSha256)
      )
        throw new Error('source evidence hashes disagree')
      return input
    } catch (error) {
      throw new EducationError('storage-unavailable', 'stored source evidence is invalid', { cause: error })
    }
  }

  ensureArtifact(actor: ActorContext, input: EnsureResearchInput): ResearchArtifactCreated {
    return this.owner.createArtifact(actor, input, () => {
      const project = this.owner.project(actor, input.projectId),
        primaryArtifactId = id<ArtifactId>(project.primary_artifact_id)
      const existing = this.db
        .prepare(
          "SELECT * FROM artifacts WHERE project_id=? AND organization_id=? AND owner_id=? AND kind='text-analysis'",
        )
        .get(input.projectId, actor.organizationId, actor.userId)
      if (existing !== undefined) {
        const artifactId = id<ArtifactId>(existing.id)
        return {
          operation: 'artifacts.create',
          projectId: input.projectId,
          primaryArtifactId,
          artifactId,
          kind: 'text-analysis',
          draftRevision: integer(this.owner.draft(actor, artifactId).revision),
          created: false,
        }
      }
      const artifactId = newId<ArtifactId>(),
        at = new Date().toISOString()
      this.db
        .prepare("INSERT INTO artifacts VALUES(?,?,?,?,'text-analysis',NULL,?,?)")
        .run(artifactId, actor.organizationId, actor.userId, input.projectId, at, at)
      this.db
        .prepare('INSERT INTO drafts VALUES(?,?,?,?,?,0,?)')
        .run(artifactId, actor.organizationId, actor.userId, '', digest(''), at)
      this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(at, input.projectId)
      return {
        operation: 'artifacts.create',
        projectId: input.projectId,
        primaryArtifactId,
        artifactId,
        kind: 'text-analysis',
        draftRevision: 0,
        created: true,
      }
    })
  }

  open(actor: ActorContext, artifactId: ArtifactId): ResearchState {
    return this.owner.transaction(actor, () => {
      const artifact = artifactDTO(this.owner.artifact(actor, artifactId))
      if (artifact.kind !== 'text-analysis') throw unavailable()
      const project = this.owner.project(actor, artifact.projectId),
        original = draftDTO(this.owner.draft(actor, artifactId))
      const permitted = this.creation.permitted(actor, this.creation.basis(actor, artifactId))
      const draft = permitted ? original : { ...original, body: '', restricted: true }
      if (draft.body !== '')
        this.owner.validateBody(actor, artifactId, draft.body, this.creation.basis(actor, artifactId))
      const version =
        artifact.latestVersionId === null
          ? undefined
          : this.db
            .prepare('SELECT * FROM artifact_versions WHERE id=? AND artifact_id=?')
            .get(artifact.latestVersionId, artifactId)
      return {
        projectId: artifact.projectId,
        primaryArtifactId: id(project.primary_artifact_id),
        artifact,
        draft,
        latestVersion: version === undefined ? null : versionSummary(version),
        document: draft.body === '' ? null : decodeResearchDocument(draft.body),
      }
    })
  }

  start(
    actor: ActorContext,
    input: StartResearchInput,
    policyVersion: string,
    execution: ResearchInputSnapshot['execution'],
    maxInputBytes: number,
  ): RunDTO {
    return this.creation.startPrepared(actor, input, maxInputBytes, (runId, artifact) => {
      if (artifact.kind !== 'text-analysis') throw unavailable()
      if (artifact.latest_version_id !== input.expectedLatestVersionId) throw conflict()
      if (!input.instruction.isWellFormed() || Buffer.byteLength(input.instruction) > this.owner.maxBodyBytes)
        throw new EducationError('validation-failed', 'research instruction exceeds its configured bounds')
      const source = this.sourceInside(actor, input.sourceVersionId, 'use_for_ai')
      const reference = {
        sourceId: source.source.id,
        versionId: source.source.versionId,
        ownerId: actor.userId,
        bodyHash: source.source.bodyHash,
        authorizationRevision: source.source.authorizationRevision,
      }
      const contextFingerprint = digest(
        JSON.stringify({
          reference,
          evidence: source.evidence,
          origin: source.origin,
          policyVersion,
          execution,
          capabilities: [],
        }),
      )
      const snapshot: ResearchInputSnapshot = {
        scenario: 'text-analysis',
        input: source,
        instruction: input.instruction,
        contextFingerprint,
        policyVersion,
        execution,
        expectedLatestVersionId: input.expectedLatestVersionId,
        capabilities: [],
      }
      const basis: ResearchBasis = {
        source: 'research-context',
        profileVersionIds: [],
        materialVersionIds: [input.sourceVersionId],
        references: [reference],
        runId,
        contextFingerprint,
        policyVersion,
      }
      return { snapshot, basis }
    })
  }

  prepareAttempt(actor: ActorContext, runId: RunId, attempt: number, promptHash: string): ResearchAttempt {
    return this.owner.transaction(
      actor,
      () => {
        const { snapshot } = this.requireRun(actor, runId)
        if (
          !Number.isSafeInteger(attempt) ||
          attempt < 1 ||
          attempt > snapshot.execution.maxAttempts ||
          !/^[a-f0-9]{64}$/.test(promptHash)
        )
          throw new EducationError('validation-failed', 'research attempt exceeds its captured limits')
        const prior = this.db
          .prepare('SELECT * FROM research_attempts WHERE run_id=? AND attempt=?')
          .get(runId, attempt)
        if (prior !== undefined) {
          if (prior.prompt_hash !== promptHash)
            throw new EducationError('idempotency-conflict', 'research attempt prompt changed')
          return this.attemptDTO(prior)
        }
        const previous = this.db
          .prepare('SELECT COALESCE(MAX(attempt),0) AS last FROM research_attempts WHERE run_id=?')
          .get(runId)
        if (integer(previous?.last) + 1 !== attempt)
          throw new EducationError('validation-failed', 'research attempts must be sequential')
        if (attempt > 1) {
          const priorAttempt = this.db
            .prepare('SELECT status,session_id,validation_json FROM research_attempts WHERE run_id=? AND attempt=?')
            .get(runId, attempt - 1)
          if (
            priorAttempt?.status !== 'failed' ||
            priorAttempt.session_id === null ||
            z.array(z.string()).parse(JSON.parse(text(priorAttempt, 'validation_json'))).length === 0
          )
            throw new EducationError('draft-conflict', 'an unsettled or uncertain model attempt cannot be retried')
        }
        this.db
          .prepare("INSERT INTO research_attempts VALUES(?,?,?,NULL,?,'prepared','[]',?,NULL)")
          .run(runId, attempt, newId(), promptHash, new Date().toISOString())
        const created = this.db
          .prepare('SELECT * FROM research_attempts WHERE run_id=? AND attempt=?')
          .get(runId, attempt)
        if (created === undefined)
          throw new EducationError('storage-unavailable', 'research attempt was not registered')
        return this.attemptDTO(created)
      },
      true,
    )
  }

  finishAttempt(
    actor: ActorContext,
    runId: RunId,
    attempt: number,
    sessionId: SessionId | null,
    status: ResearchAttempt['status'],
    validationErrors: readonly string[],
  ): void {
    this.owner.transaction(
      actor,
      () => {
        this.requireRun(actor, runId)
        const updated = this.db
          .prepare(
            "UPDATE research_attempts SET session_id=COALESCE(?,session_id),status=?,validation_json=?,finished_at=? WHERE run_id=? AND attempt=? AND status IN('prepared','running')",
          )
          .run(
            sessionId,
            status,
            JSON.stringify(validationErrors),
            status === 'running' || status === 'prepared' ? null : new Date().toISOString(),
            runId,
            attempt,
          )
        if (updated.changes !== 1) throw new EducationError('draft-conflict', 'research attempt is already settled')
      },
      true,
    )
  }

  abandonAttempt(runId: RunId, attempt: number, validationErrors: readonly string[]): void {
    this.owner.system(() => {
      this.db
        .prepare(
          "UPDATE research_attempts SET status='unknown',validation_json=?,finished_at=? WHERE run_id=? AND attempt=? AND status IN('prepared','running')",
        )
        .run(JSON.stringify(validationErrors), new Date().toISOString(), runId, attempt)
    })
  }

  private requireRun(actor: ActorContext, runId: RunId): { row: Row; snapshot: ResearchInputSnapshot } {
    const row = this.db
      .prepare('SELECT * FROM creation_runs WHERE id=? AND organization_id=? AND owner_id=?')
      .get(runId, actor.organizationId, actor.userId)
    if (row === undefined) throw unavailable()
    const snapshot = decodeRunSnapshot(text(row, 'snapshot_json'))
    if (
      snapshot.scenario !== 'text-analysis' ||
      !this.creation.permitted(actor, decodeBasis(text(row, 'basis_json')), 'use_for_ai')
    )
      throw unavailable()
    if (row.status !== 'pending' && row.status !== 'running') throw conflict()
    const artifactId = id<ArtifactId>(row.artifact_id)
    if (
      this.owner.draft(actor, artifactId).revision !== row.expected_revision ||
      this.owner.artifact(actor, artifactId).latest_version_id !== snapshot.expectedLatestVersionId
    )
      throw conflict()
    return { row, snapshot }
  }

  private attemptDTO(row: Row): ResearchAttempt {
    const state = z.enum(['prepared', 'running', 'completed', 'failed', 'unknown']).parse(row.status)
    return {
      runId: id(row.run_id),
      attempt: integer(row.attempt),
      bindingRequestId: id(row.binding_request_id),
      sessionId: row.session_id === null ? null : brandString<SessionId>(text(row, 'session_id')),
      promptHash: text(row, 'prompt_hash'),
      status: state,
      validationErrors: z.array(z.string()).parse(JSON.parse(text(row, 'validation_json'))),
    }
  }
}
