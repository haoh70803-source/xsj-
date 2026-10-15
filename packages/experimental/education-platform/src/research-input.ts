/** Text and media-free research-input V1 import; file bytes and Python-normalized transcript digests stay distinct. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ResearchEvidence, ResearchJson, ResearchOrigin } from './research-types.ts'
import { EducationError } from './error.ts'
import { parsePythonJson, pythonCanonicalJson } from './python-json.ts'

/** Normalized source import; the canonical transcript is retained only as import evidence, never as authorization. */
export interface ParsedResearchInput {
  readonly title: string
  readonly body: string
  readonly evidence: ResearchEvidence
  readonly origin: ResearchOrigin
  readonly canonicalTranscript: string | null
}

const pythonWhitespace = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u
/**
 * Compare transcript layouts using the V1 producer's Unicode whitespace rules.
 * @param value - original transcript text.
 * @returns normalized words for consistency checks, never replacement author text.
 */
export function normalizedTranscriptWords(value: string): string {
  return value.split(pythonWhitespace).filter(Boolean).join(' ')
}
const words = normalizedTranscriptWords
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const segmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string().refine(value => words(value) !== ''),
})
const transcriptSchema = z.object({
  schema_version: z.literal(1).optional(),
  language: z.string().optional(),
  duration_seconds: z.number().positive(),
  segments: z.array(segmentSchema).min(1).max(20_000),
  full_text: z.string().optional(),
})
const bundleSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('video-research-input'),
  source_id: z.string().min(1),
  title: z.string().min(1),
  transcript_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  media_file: z.null().optional(),
  exported_at: z.iso.datetime({ offset: true }).optional(),
})
const asrFields = new Set([
  'primary',
  'backup',
  'engines_used',
  'itn_requested',
  'timestamp_precision',
  'warnings',
  'review_status',
])
const infoFields = new Set([
  'source_kind',
  'content_id',
  'title',
  'author_name',
  'publish_time',
  'snapshot_at',
  'duration_seconds',
  'width',
  'height',
  'followers',
  'cover_available',
  'avatar_available',
  'likes',
  'collects',
  'comments',
  'shares',
  'views',
  'source_url',
])
const counts = new Set(['followers', 'likes', 'collects', 'comments', 'shares', 'views'])

function object(value: ResearchJson | undefined): { [key: string]: ResearchJson } {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new EducationError('validation-failed', 'research input requires an object')
  return value
}

function sourceUrl(value: ResearchJson | undefined): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new EducationError('validation-failed', 'research source URL must be text')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new EducationError('validation-failed', 'research source URL is invalid', { cause: error })
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new EducationError('validation-failed', 'research source URL contains an unsupported scheme or credentials')
  return value
}

/**
 * Build stable paragraph references without inserting fake start/end times.
 * @param body - complete original text, normalized only from CRLF to LF.
 * @returns exact paragraph text with JavaScript UTF-16 offsets in the original body.
 */
export function paragraphEvidence(body: string): ResearchEvidence {
  if (body.trim() === '' || !body.isWellFormed())
    throw new EducationError('validation-failed', 'research source text is empty or malformed')
  const units: { id: string; text: string; startOffset: number; endOffset: number }[] = []
  let start = 0
  const append = (end: number) => {
    const text = body.slice(start, end)
    if (text.trim() !== '')
      units.push({ id: `p_${String(units.length).padStart(4, '0')}`, text, startOffset: start, endOffset: end })
  }
  for (const match of body.matchAll(/\n[ \t]*\n/g)) {
    append(match.index)
    start = match.index + match[0].length
  }
  append(body.length)
  if (units.length > 20_000)
    throw new EducationError('validation-failed', 'research source has too many evidence units')
  return { kind: 'text', units }
}

/**
 * Parse a bounded media-free V1 input and verify the producer's original Python digest.
 * @param raw - exact uploaded JSON bytes decoded as UTF-8, including any BOM.
 * @param maxBytes - deployment's complete imported-JSON byte bound.
 * @returns checked transcript evidence and separately named file/object hashes; no model or network call occurs.
 */
export function parseResearchInputV1(raw: string, maxBytes: number): ParsedResearchInput {
  if (Buffer.byteLength(raw) > maxBytes)
    throw new EducationError('validation-failed', 'research input exceeds the configured byte limit')
  try {
    const parsed = parsePythonJson(raw),
      root = object(parsed.value),
      header = bundleSchema.parse(root)
    const original = object(root.transcript),
      transcript = transcriptSchema.parse(original)
    const rawSegments = original.segments
    if (!Array.isArray(rawSegments)) throw new EducationError('validation-failed', 'transcript segments are absent')
    let previous = -1
    const segments = transcript.segments.map((segment, index) => {
      if (
        segment.start < 0 ||
        segment.start < previous ||
        segment.end <= segment.start ||
        segment.end > transcript.duration_seconds + 0.1
      )
        throw new EducationError(
          'validation-failed',
          'transcript times overlap, are unordered, or exceed the supplied duration',
        )
      previous = segment.end
      const clean = { start: segment.start, end: segment.end, text: segment.text }
      const rawSegment = object(rawSegments[index])
      const fields = parsed.floatFields.get(rawSegment)
      if (fields !== undefined) parsed.floatFields.set(clean, fields)
      return clean
    })
    const joined = segments.map(segment => segment.text).join(' '),
      full = transcript.full_text ?? joined
    if (words(full) !== words(joined))
      throw new EducationError('validation-failed', 'transcript full text does not agree with its original segments')
    const originalAsr = original.asr === undefined || original.asr === null ? {} : object(original.asr)
    const asr = Object.fromEntries(Object.entries(originalAsr).filter(([key]) => asrFields.has(key)))
    const asrKinds = parsed.floatFields.get(originalAsr)
    if (asrKinds !== undefined) parsed.floatFields.set(asr, asrKinds)
    const normalized = {
      schema_version: 1,
      language: transcript.language || 'zh',
      duration_seconds: transcript.duration_seconds,
      segments,
      full_text: full,
      asr,
    }
    const kinds = parsed.floatFields.get(original)
    if (kinds?.has('duration_seconds')) parsed.floatFields.set(normalized, new Set(['duration_seconds']))
    const canonical = pythonCanonicalJson(normalized, parsed.floatFields),
      objectHash = sha(canonical)
    if (objectHash !== header.transcript_sha256)
      throw new EducationError('validation-failed', 'research transcript object digest does not match the V1 producer')
    const suppliedInfo = root.video_info === undefined || root.video_info === null ? {} : object(root.video_info)
    const videoInfo = Object.fromEntries(
      Object.entries(suppliedInfo).filter(
        ([key, value]) =>
          infoFields.has(key) &&
          (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'),
      ),
    )
    for (const [key, value] of Object.entries(videoInfo))
      if (
        counts.has(key) &&
        value !== null &&
        (typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value < 0 ||
          parsed.floatFields.get(suppliedInfo)?.has(key))
      )
        throw new EducationError('validation-failed', 'research video metrics must be nonnegative integers or null')
    const url = sourceUrl(videoInfo.source_url)
    return {
      title: header.title,
      body: full.replace(/\r\n/g, '\n'),
      evidence: {
        kind: 'transcript',
        durationSeconds: transcript.duration_seconds,
        units: segments.map((segment, index) => ({
          id: `seg_${String(index).padStart(2, '0')}`,
          ...segment,
          text: segment.text.replace(/\r\n/g, '\n'),
        })),
        language: normalized.language,
        asr,
      },
      origin: {
        originalTitle: header.title,
        externalSourceId: header.source_id,
        sourceUrl: url,
        fileSha256: sha(raw),
        transcriptObjectSha256: objectHash,
        videoInfo,
      },
      canonicalTranscript: canonical,
    }
  } catch (error) {
    if (error instanceof EducationError) throw error
    throw new EducationError(
      'validation-failed',
      'research-input V1 JSON is invalid or contains an unsupported media declaration',
      { cause: error },
    )
  }
}
