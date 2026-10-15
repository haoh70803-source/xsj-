/** Shared exact-version source decoding inside an already authorized repository transaction. */
import type { DatabaseSync } from 'node:sqlite'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  ActorContext,
  SourceDTO,
  SourceId,
  SourceVersionId,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { digest, id, integer, text, timestamp } from './codec.ts'

/**
 * Decode one source without confusing its current pointer with a selected historical revision.
 * @param db - same-medium, already authorized transaction.
 * @param actor - trusted employee whose source is being read.
 * @param sourceId - private source identity.
 * @param versionId - exact version or the current source pointer.
 * @param permitted - current upstream authorization check, evaluated before returning text.
 * @returns verified selected text or metadata with its body hidden.
 */
export function sourceView(
  db: DatabaseSync,
  actor: ActorContext,
  sourceId: SourceId,
  versionId: SourceVersionId | undefined,
  permitted: (version: SourceVersionId) => boolean,
): SourceDTO {
  const row = db
    .prepare(
      `SELECT s.*,v.id AS version_id,v.revision AS selected_revision,v.body,v.body_hash
    FROM sources s JOIN source_versions v ON v.source_id=s.id AND v.id=COALESCE(?,s.current_version_id)
    WHERE s.id=? AND s.organization_id=? AND s.owner_id=? AND v.organization_id=s.organization_id AND v.owner_id=s.owner_id`,
    )
    .get(versionId ?? null, sourceId, actor.organizationId, actor.userId)
  if (row === undefined) throw new EducationError('resource-unavailable', 'source is unavailable')
  const body = text(row, 'body'),
    bodyHash = text(row, 'body_hash'),
    selected = id<SourceVersionId>(row.version_id)
  if (digest(body) !== bodyHash) throw new EducationError('storage-unavailable', 'source digest is invalid')
  const authorized = row.authorized === 1 && permitted(selected)
  const evidence = db
    .prepare("SELECT json_extract(evidence_json,'$.purpose') AS purpose FROM source_evidence WHERE version_id=?")
    .get(selected)
  const derived =
    evidence?.purpose === 'reference-method' ||
    db.prepare('SELECT version_id FROM source_dependencies WHERE version_id=? LIMIT 1').get(selected) !== undefined
  return {
    ...(derived ? { purpose: 'reference-method' as const } : {}),
    id: id(row.id),
    versionId: selected,
    revision: integer(row.selected_revision),
    title: text(row, 'title'),
    sourceUrl: text(row, 'source_url'),
    authorizationRevision: integer(row.authorization_revision),
    authorized,
    body: authorized ? body : '',
    bodyHash,
    createdAt: timestamp(row.created_at),
  }
}
