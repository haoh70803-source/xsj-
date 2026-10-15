/** Durable row and JSON decoding; invalid stored values stop dependent business work. */
import { createHash, randomUUID } from 'node:crypto'
import type { SQLOutputValue } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { decodeBasis } from './creation-codec.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  ArtifactDTO,
  ArtifactVersionDTO,
  ArtifactVersionSummary,
  BasisSnapshot,
  DraftDTO,
  ProjectDTO,
  SessionBindingDTO,
  WriteResult,
} from '@deepseek-ai/dsh-experimental-education-platform/types'

/** SQLite row returned from this provider's fixed queries. */
export type Row = Record<string, SQLOutputValue>

/**
 * Mint a business UUID in the caller's nominal domain.
 * @returns a new globally unique branded business identifier.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- The caller selects the nominal ID domain.
export function newId<T extends Branded<string>>(): T {
  return brandString<T>(randomUUID())
}

/**
 * Validate a business UUID before applying the caller's nominal domain.
 * @param value - external or durable identifier.
 * @returns validated canonical UUID.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- The caller selects the nominal ID domain.
export function id<T extends Branded<string>>(value: unknown): T {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  ) {
    throw new EducationError('validation-failed', 'business identifier must be a canonical UUID')
  }
  return brandString<T>(value)
}

/**
 * Hash canonical UTF-8 business text or a normalized request.
 * @param value - canonical plaintext or request serialization.
 * @returns lowercase SHA-256 digest.
 */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Read a required text column from a durable record.
 * @param row - queried durable record.
 * @param column - required text column.
 * @returns validated text.
 */
export function text(row: Row, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw malformed()
  return value
}

/**
 * Validate a stored revision or ordinal.
 * @param value - revision or ordinal.
 * @returns nonnegative safe integer.
 */
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw malformed()
  return value
}

/**
 * Reject noncanonical or impossible stored UTC timestamps.
 * @param value - stored UTC timestamp.
 * @returns canonical ISO timestamp.
 */
export function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw malformed()
  return value
}

/**
 * Decode a project summary without ownership or credential fields.
 * @param row - stored project.
 * @returns private summary without owner or credential fields.
 */
export function projectDTO(row: Row): ProjectDTO {
  if (row.scenario !== 'spoken-script' && row.scenario !== 'moments') throw malformed()
  return {
    id: id(row.id),
    title: text(row, 'title'),
    scenario: row.scenario,
    primaryArtifactId: id(row.primary_artifact_id),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

/**
 * Decode an artifact's current formal-version pointer.
 * @param row - stored artifact.
 * @returns checked formal-version pointer and metadata.
 */
export function artifactDTO(row: Row): ArtifactDTO {
  if (row.kind !== 'spoken-script' && row.kind !== 'moments' && row.kind !== 'text-analysis') throw malformed()
  return {
    id: id(row.id),
    projectId: id(row.project_id),
    kind: row.kind,
    latestVersionId: row.latest_version_id === null ? null : id(row.latest_version_id),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

/**
 * Validate current draft content against its durable digest.
 * @param row - stored current draft.
 * @returns text after validating its recorded digest.
 */
export function draftDTO(row: Row): DraftDTO {
  const body = text(row, 'body')
  const bodyHash = hash(row.body_hash)
  if (digest(body) !== bodyHash) throw malformed()
  return {
    artifactId: id(row.artifact_id),
    body,
    bodyHash,
    revision: integer(row.revision),
    updatedAt: timestamp(row.updated_at),
  }
}

/**
 * Decode an immutable formal-version summary.
 * @param row - immutable version metadata.
 * @returns summary without private text.
 */
export function versionSummary(row: Row): ArtifactVersionSummary {
  const versionNo = integer(row.version_no)
  if (versionNo === 0) throw malformed()
  return {
    id: id(row.id),
    artifactId: id(row.artifact_id),
    versionNo,
    bodyHash: hash(row.body_hash),
    savedBy: id(row.saved_by),
    savedAt: timestamp(row.saved_at),
  }
}

/** Stage A has no profile or source documents. */
export const FOUNDATION_BASIS: BasisSnapshot = Object.freeze({
  source: 'foundation-validation',
  profileVersionIds: Object.freeze([] as const),
  materialVersionIds: Object.freeze([] as const),
})

/**
 * Validate historical text and its original saving basis.
 * @param row - immutable version.
 * @returns verified text and original, validated saving basis.
 */
export function versionDTO(row: Row): ArtifactVersionDTO {
  const summary = versionSummary(row)
  const body = text(row, 'body')
  const basis = decodeBasis(text(row, 'basis_snapshot'))
  if (digest(body) !== summary.bodyHash) throw malformed()
  return { ...summary, body, basisSnapshot: basis }
}

/**
 * Decode a business-owned native Session association.
 * @param row - unique native session association.
 * @returns validated business binding.
 */
export function bindingDTO(row: Row): SessionBindingDTO {
  if (row.status !== 'active' && row.status !== 'invalid') throw malformed()
  return {
    id: id(row.id),
    projectId: id(row.project_id),
    artifactId: id(row.artifact_id),
    harnessSessionId: nativeSessionId(row.harness_session_id),
    status: row.status,
    createdAt: timestamp(row.created_at),
  }
}

/**
 * Parse persisted JSON without accepting arrays or primitive values.
 * @param value - untrusted serialized object.
 * @returns plain JSON record or a contained malformed-data failure.
 */
export function parseObject(value: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw malformed(error)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw malformed()
  return parsed as Record<string, unknown>
}

/**
 * Validate a durable SHA-256 digest.
 * @param value - durable digest.
 * @returns a SHA-256 digest.
 */
export function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw malformed()
  return value
}

/**
 * Decode a durable receipt using its operation discriminator.
 * @param serialized - durable non-secret receipt.
 * @returns its validated discriminated result.
 */
export function receiptResult(serialized: string): WriteResult {
  const value = parseObject(serialized)
  switch (value.operation) {
    case 'artifacts.create':
      if (value.kind !== 'text-analysis' || typeof value.created !== 'boolean') throw malformed()
      return {
        operation: value.operation,
        projectId: id(value.projectId),
        primaryArtifactId: id(value.primaryArtifactId),
        artifactId: id(value.artifactId),
        kind: value.kind,
        draftRevision: integer(value.draftRevision),
        created: value.created,
      }
    case 'projects.create':
      if (value.draftRevision !== 0) throw malformed()
      return {
        operation: value.operation,
        projectId: id(value.projectId),
        artifactId: id(value.artifactId),
        draftRevision: 0,
      }
    case 'drafts.sync':
    case 'drafts.restoreVersion':
      return {
        operation: value.operation,
        artifactId: id(value.artifactId),
        revision: integer(value.revision),
        bodyHash: hash(value.bodyHash),
        updatedAt: timestamp(value.updatedAt),
      }
    case 'artifacts.saveVersion': {
      const versionNo = integer(value.versionNo)
      if (versionNo === 0) throw malformed()
      return {
        operation: value.operation,
        artifactId: id(value.artifactId),
        versionId: id(value.versionId),
        versionNo,
        draftRevision: integer(value.draftRevision),
      }
    }
    case 'sessions.bind': {
      if (value.binding === null || typeof value.binding !== 'object' || Array.isArray(value.binding)) throw malformed()
      const binding = value.binding as Record<string, unknown>
      if (typeof binding.harnessSessionId !== 'string' || (binding.status !== 'active' && binding.status !== 'invalid'))
        throw malformed()
      return {
        operation: value.operation,
        binding: {
          id: id(binding.id),
          projectId: id(binding.projectId),
          artifactId: id(binding.artifactId),
          harnessSessionId: nativeSessionId(binding.harnessSessionId),
          status: binding.status,
          createdAt: timestamp(binding.createdAt),
        },
      }
    }
    default:
      throw malformed()
  }
}

function malformed(cause?: unknown): EducationError {
  return new EducationError('storage-unavailable', 'education stored data is invalid; stop dependent operations', {
    cause,
  })
}

function nativeSessionId(value: unknown): SessionId {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) throw malformed()
  return brandString<SessionId>(value)
}
