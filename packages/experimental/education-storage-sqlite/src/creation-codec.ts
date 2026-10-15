/** Strict durable creation decoding, separate from the immutable stage-A representation. */
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { EducationError, validateResearchSource } from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  BasisSnapshot,
  CreationInputSnapshot,
  ProfileVersion,
  SourceDTO,
  ProfileVersionId,
  SourceVersionId,
  SourceId,
  UserId,
  RunId,
  GenerationInputSnapshot,
  ArtifactVersionId,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { digest, id } from './codec.ts'

const uuid = <T extends Branded<string>>() => z.string().transform(value => id<T>(value))
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const time = z.iso.datetime({ precision: 3 })
const profileSchema = z.strictObject({
  id: uuid<ProfileVersionId>(),
  revision: revision.min(1),
  facts: z.string(),
  preferences: z.string(),
  prohibitedPromises: z.string(),
  bodyHash: hash,
  createdAt: time,
})
const sourceSchema = z.strictObject({
  purpose: z.literal('reference-method').optional(),
  id: uuid<SourceId>(),
  title: z.string(),
  sourceUrl: z.string(),
  revision: revision.min(1),
  authorizationRevision: revision.min(1),
  authorized: z.boolean(),
  versionId: uuid<SourceVersionId>(),
  body: z.string(),
  bodyHash: hash,
  createdAt: time,
})
const referenceSchema = z.strictObject({
  sourceId: uuid<SourceId>(),
  versionId: uuid<SourceVersionId>(),
  ownerId: uuid<UserId>(),
  bodyHash: hash,
  authorizationRevision: revision.min(1),
})
const creationBasis = z.strictObject({
  source: z.literal('creation-context'),
  profileVersionIds: z.array(uuid<ProfileVersionId>()).length(1),
  materialVersionIds: z.array(uuid<SourceVersionId>()),
  references: z.array(referenceSchema),
  runId: uuid<RunId>(),
  contextFingerprint: hash,
  policyVersion: z.string().min(1),
})
const basisSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('foundation-validation'),
    profileVersionIds: z.tuple([]),
    materialVersionIds: z.tuple([]),
  }),
  creationBasis,
  z.strictObject({
    source: z.literal('research-context'),
    profileVersionIds: z.tuple([]),
    materialVersionIds: z.array(uuid<SourceVersionId>()).length(1),
    references: z.array(referenceSchema).length(1),
    runId: uuid<RunId>(),
    contextFingerprint: hash,
    policyVersion: z.string().min(1),
  }),
])
const snapshotSchema = z.strictObject({
  scenario: z.enum(['spoken-script', 'moments']),
  profile: profileSchema,
  sources: z.array(sourceSchema),
  draft: z.string(),
  instruction: z.string(),
  mode: z.enum(['generate', 'modify', 'selection']),
  selection: z.strictObject({ start: revision, end: revision, bodyHash: hash, original: z.string() }).optional(),
  contextFingerprint: hash,
  policyVersion: z.string().min(1),
  capabilities: z.tuple([]),
})

/**
 * Validate a stored creation record before dependent work continues.
 * @param schema - durable record parser.
 * @param serialized - JSON from the private database.
 * @returns validated record; corrupt storage stops dependent work.
 */
export function decodeCreation<T>(schema: z.ZodType<T>, serialized: string): T {
  try {
    return schema.parse(JSON.parse(serialized))
  } catch (error) {
    throw new EducationError('storage-unavailable', 'stored creation record is invalid', { cause: error })
  }
}
/**
 * Decode an immutable confirmed profile version.
 * @param serialized - immutable profile.
 * @returns checked profile.
 */
export function decodeProfile(serialized: string): ProfileVersion {
  return decodeCreation(profileSchema, serialized)
}
/**
 * Decode a source receipt without changing its authorization.
 * @param serialized - immutable receipt.
 * @returns checked source record.
 */
export function decodeSource(serialized: string): SourceDTO {
  return decodeCreation(sourceSchema, serialized)
}
/**
 * Decode historical validation or fixed creation evidence.
 * @param serialized - original basis JSON.
 * @returns original foundation or real-context evidence.
 */
export function decodeBasis(serialized: string): BasisSnapshot {
  const result = decodeCreation(basisSchema, serialized)
  if (
    result.source !== 'foundation-validation' &&
    (result.references.length !== result.materialVersionIds.length ||
      result.references.some((ref, index) => ref.versionId !== result.materialVersionIds[index]))
  )
    throw new EducationError('storage-unavailable', 'stored source references are inconsistent')
  return result
}
/**
 * Validate the complete stored model input and source digests.
 * @param serialized - complete fixed model input.
 * @returns checked input, including every source digest.
 */
export function decodeSnapshot(serialized: string): CreationInputSnapshot {
  const result = decodeCreation(snapshotSchema, serialized)
  if (result.sources.some(source => digest(source.body) !== source.bodyHash))
    throw new EducationError('storage-unavailable', 'stored source text does not match its digest')
  const { selection, ...required } = result
  return { ...required, ...(selection === undefined ? {} : { selection }) }
}

/**
 * Decode the discriminated fixed run input; research never receives an invented creator profile.
 * @param serialized - owned durable run input.
 * @returns exact creation or research input with validated source hashes.
 */
export function decodeRunSnapshot(serialized: string): GenerationInputSnapshot {
  const discriminator = decodeCreation(z.object({ scenario: z.string() }), serialized)
  if (discriminator.scenario !== 'text-analysis') return decodeSnapshot(serialized)
  return decodeCreation(
    z.strictObject({
      scenario: z.literal('text-analysis'),
      input: z.unknown().transform(validateResearchSource),
      instruction: z.string(),
      contextFingerprint: hash,
      policyVersion: z.string().min(1),
      expectedLatestVersionId: uuid<ArtifactVersionId>().nullable(),
      capabilities: z.tuple([]),
      execution: z.strictObject({
        provider: z.string().min(1),
        model: z.string().min(1),
        maxTokens: z.number().int().positive(),
        maxAttempts: z.number().int().min(1).max(3),
        timeoutMs: z.number().int().positive(),
      }),
    }),
    serialized,
  )
}
