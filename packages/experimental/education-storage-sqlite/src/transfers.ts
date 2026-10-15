/** Explicit immutable-version transfers; every derived source retains current upstream grants. */
import type { DatabaseSync } from 'node:sqlite'
import {
  EducationError,
  decodeResearchDocument,
  paragraphEvidence,
} from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  ActorContext,
  AnalyticsTransferInput,
  ArtifactId,
  ArtifactVersionId,
  ProjectId,
  ResearchTransferInput,
  SourceDTO,
  BasisSnapshot,
  TransferRepository,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { id, integer, text, versionDTO, type Row } from './codec.ts'
import { analyticsStored, normalizedContentSchema } from './analytics-codec.ts'
import type { SqliteCreationRepository } from './creation.ts'
import type { SqliteAnalyticsRepository } from './analytics.ts'
interface Owner {
  validateBody(actor: ActorContext, artifactId: ArtifactId, body: string, basis: BasisSnapshot): void
  transaction<T>(actor: ActorContext, work: () => T): T
  project(actor: ActorContext, projectId: ProjectId): Row
  version(actor: ActorContext, artifactId: ArtifactId, versionId: ArtifactVersionId): Row
  artifact(actor: ActorContext, artifactId: ArtifactId): Row
}
/** Same source receipt path makes confirmations recoverable with their original request identity. */
export class SqliteTransferRepository implements TransferRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: Owner,
    private readonly creation: SqliteCreationRepository,
    private readonly analytics: SqliteAnalyticsRepository,
  ) {}
  fromResearch(actor: ActorContext, input: ResearchTransferInput): SourceDTO {
    const captured = this.owner.transaction(actor, () => {
      const artifact = this.owner.artifact(actor, input.artifactId),
        version = versionDTO(this.owner.version(actor, input.artifactId, input.versionId))
      if (
        artifact.kind !== 'text-analysis' ||
        !this.creation.permitted(actor, version.basisSnapshot, 'view') ||
        !this.creation.permitted(actor, version.basisSnapshot, 'use_for_ai')
      )
        throw new EducationError('resource-unavailable', 'report source authority is unavailable')
      this.owner.validateBody(actor, input.artifactId, version.body, version.basisSnapshot)
      const document = decodeResearchDocument(version.body)
      if (
        document.kind !== 'research-report' ||
        !Number.isSafeInteger(input.direction) ||
        document.report.creative_directions[input.direction] === undefined
      )
        throw new EducationError('validation-failed', 'select an available direction from a saved structured report')
      const direction = document.report.creative_directions[input.direction]
      if (direction === undefined) throw new EducationError('validation-failed', 'selected direction is unavailable')
      return { document, direction, projectId: id<ProjectId>(artifact.project_id), basis: version.basisSnapshot }
    })
    const body = `参考创作方向（其他作者的方法，不是本人的经历或业绩）：\n${JSON.stringify(captured.direction, null, 2)}\n来源报告版本：${input.versionId}\n原始资料版本：${captured.document.input.source.versionId}`
    const origin = {
      ...captured.document.input.origin,
      fileSha256: null,
      transcriptObjectSha256: null,
      videoInfo: {
        projectId: captured.projectId,
        reportVersionId: input.versionId,
        sourceVersionId: captured.document.input.source.versionId,
        direction: input.direction,
      },
    }
    return this.creation.saveSourceWithMetadata(
      actor,
      {
        title: captured.direction.title,
        body,
        sourceUrl: origin.sourceUrl,
        expectedRevision: 0,
        requestId: input.requestId,
      },
      {
        kind: 'text',
        fileHash: null,
        objectHash: null,
        evidenceJson: JSON.stringify({
          purpose: 'reference-method',
          evidence: paragraphEvidence(body),
          origin,
          canonicalTranscript: null,
        }),
        dependencies: [{ kind: 'report', parentId: input.versionId, parentRevision: 0 }],
      },
      () => {
        this.owner.project(actor, captured.projectId)
        this.owner.version(actor, input.artifactId, input.versionId)
        if (
          !this.creation.permitted(actor, captured.basis, 'view') ||
          !this.creation.permitted(actor, captured.basis, 'use_for_ai')
        )
          throw new EducationError('resource-unavailable', 'report authority changed')
      },
    )
  }
  fromAnalytics(actor: ActorContext, input: AnalyticsTransferInput): SourceDTO {
    const captured = this.owner.transaction(actor, () => {
      this.owner.project(actor, input.projectId)
      const row = this.db.prepare('SELECT * FROM content_snapshots WHERE id=?').get(input.snapshotId)
      if (row === undefined) throw new EducationError('resource-unavailable', 'observation is unavailable')
      // The branded account is reconstructed by its actual current row, never inferred from the content's external id.
      const account = this.analytics.accountInside(actor, id(row.account_id), 'view', true)
      this.analytics.accountInside(actor, id(row.account_id), 'use_for_ai', true)
      return { row, account, content: analyticsStored(normalizedContentSchema, text(row, 'content_json')) }
    })
    if (input.target === 'research' && !input.originalText.trim())
      throw new EducationError(
        'validation-failed',
        'titles, metrics and links are not original text; supply the authorized original before research',
      )
    const provenance = {
      projectId: input.projectId,
      target: input.target,
      accountId: text(captured.account, 'id'),
      accountGrantRevision: integer(captured.account.grant_revision),
      snapshotId: input.snapshotId,
      source: text(captured.row, 'source'),
      fetchedAt: text(captured.row, 'fetched_at'),
      sourceDataAt: captured.content.sourceDataAt,
      publishedAt: captured.content.publishedAt,
      metrics: captured.content.fields,
    }
    const body =
      input.target === 'research'
        ? input.originalText
        : `其他账号的选题与指标参考；以下标题、链接和累计指标不是原始全文，也不是本人的经历或业绩。\n${JSON.stringify({ ...captured.content, provenance }, null, 2)}${input.originalText.trim() ? `\n用户提供的原文：\n${input.originalText}` : ''}`
    const origin = {
      originalTitle: captured.content.title || null,
      externalSourceId: captured.content.externalId,
      sourceUrl: captured.content.url,
      fileSha256: null,
      transcriptObjectSha256: null,
      videoInfo: provenance,
    }
    return this.creation.saveSourceWithMetadata(
      actor,
      {
        title: captured.content.title || captured.content.externalId,
        body,
        sourceUrl: captured.content.url,
        expectedRevision: 0,
        requestId: input.requestId,
      },
      {
        kind: 'text',
        fileHash: null,
        objectHash: null,
        evidenceJson: JSON.stringify({
          purpose: 'reference-method',
          evidence: paragraphEvidence(body),
          origin,
          canonicalTranscript: null,
        }),
        dependencies: [
          {
            kind: 'account',
            parentId: text(captured.account, 'id'),
            parentRevision: integer(captured.account.grant_revision),
          },
        ],
      },
      () => {
        this.owner.project(actor, input.projectId)
        const current = this.analytics.accountInside(actor, id(captured.account.id), 'use_for_ai', true)
        this.analytics.accountInside(actor, id(captured.account.id), 'view', true)
        if (current.grant_revision !== captured.account.grant_revision)
          throw new EducationError('version-conflict', 'account authorization changed before transfer')
      },
    )
  }
}
