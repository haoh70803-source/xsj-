/** Structured research decoding and explicit quote/coverage validation; no language-runtime assertions are used. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SourceId, SourceVersionId, RunId } from './types.ts'
import type {
  LegacyResearchDocument,
  ResearchDocument,
  ResearchEvidence,
  ResearchOrigin,
  ResearchQuote,
  ResearchReport,
  ResearchSource,
} from './research-types.ts'
import { EducationError } from './error.ts'
import { normalizedTranscriptWords, paragraphEvidence } from './research-input.ts'

/** Safe field paths support a bounded repair prompt without exposing source text through error messages. */
export class ResearchValidationError extends EducationError {
  /**
   * @param issues - checked field paths and failed evidence requirements.
   * @param cause - internal parser failure, retained on the Host only.
   */
  constructor(
    readonly issues: readonly string[],
    cause?: unknown,
  ) {
    super(
      'validation-failed',
      'research report failed field or evidence checks',
      cause === undefined ? undefined : { cause },
    )
    this.name = 'ResearchValidationError'
  }
}

const text = z.string().refine(value => value.trim() !== '' && value.isWellFormed())
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const quote = z.strictObject({ source_id: text, quote: text })
const quotes = z.array(quote).min(1)
const reportSchema = z.strictObject({
  schema_version: z.literal(2),
  prompt_version: z.literal('content-research-v3.1'),
  overview: z.strictObject({ thesis: text, audience: text, purpose: text, pain: text, takeaway: text }),
  compact: z.strictObject({
    content_summary: text,
    main_summary: text,
    reasons: z
      .array(z.strictObject({ title: text, text }))
      .min(1)
      .max(3),
  }),
  propagation: z.strictObject({ summary: text, evidence: quotes }),
  opening: z.strictObject({ title_promise: text, opening_move: text, payoff: text, evidence: quotes }),
  ending: z.strictObject({ conclusion: text, cta: text, evidence: quotes }),
  sections: z
    .array(
      z.strictObject({
        source_ids: z.array(text).min(1),
        title: text,
        short_title: text,
        structure_tags: z.array(text).min(1).max(2),
        analysis_short: text,
        role: text,
        summary: text,
        analysis: text,
        evidence: quotes,
      }),
    )
    .min(1),
  mechanisms: z
    .array(
      z.strictObject({
        title: text,
        analysis: text,
        audience_reason: text,
        connection: text,
        learn: text,
        evidence: quotes,
      }),
    )
    .min(1)
    .max(3),
  sidebar_analysis: z.strictObject({
    blocks: z.array(z.strictObject({ title: text, text, source_ids: z.array(text).min(1) })).max(2),
  }),
  methods: z.array(z.strictObject({ title: text, how: text, example: text, condition: text, evidence: quotes })).max(2),
  creative_directions: z
    .array(
      z.strictObject({
        title: text,
        angle: text,
        basis: text,
        opening_idea: text,
        outline: z.array(text).min(2).max(5),
        what_to_keep: text,
        what_to_change: text,
        materials: z.array(text).min(1).max(3),
        evidence: quotes,
      }),
    )
    .max(3),
  issues: z.array(z.strictObject({ title: text, analysis: text, evidence: quotes })).max(3),
  creation_note: text.optional(),
})
const evidenceSchema: z.ZodType<ResearchEvidence> = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    units: z
      .array(z.strictObject({ id: text, text, startOffset: integer, endOffset: integer }))
      .min(1)
      .max(20_000),
  }),
  z.strictObject({
    kind: z.literal('transcript'),
    durationSeconds: z.number().positive(),
    language: text,
    asr: z.record(z.string(), z.json()),
    units: z
      .array(
        z.strictObject({
          id: text,
          text,
          start: z.number().nonnegative(),
          end: z.number().positive(),
        }),
      )
      .min(1)
      .max(20_000),
  }),
])
const originSchema: z.ZodType<ResearchOrigin> = z.strictObject({
  originalTitle: text.nullable(),
  externalSourceId: text.nullable(),
  sourceUrl: z.string(),
  fileSha256: hash.nullable(),
  transcriptObjectSha256: hash.nullable(),
  videoInfo: z.record(z.string(), z.json()),
})
const sourceSchema: z.ZodType<ResearchSource> = z.strictObject({
  source: z.strictObject({
    purpose: z.literal('reference-method').optional(),
    id: uuid.transform(value => brandString<SourceId>(value)),
    title: text,
    sourceUrl: z.string(),
    revision: integer.min(1),
    authorizationRevision: integer.min(1),
    authorized: z.literal(true),
    versionId: uuid.transform(value => brandString<SourceVersionId>(value)),
    body: z.string(),
    bodyHash: hash,
    createdAt: z.iso.datetime({ precision: 3 }),
  }),
  evidence: evidenceSchema,
  origin: originSchema,
})

/**
 * Check source evidence independently from the report's conclusions.
 * @param value - durable or fixed source record.
 * @returns verified source text and original evidence; current grants remain the repository's responsibility.
 */
export function validateResearchSource(value: unknown): ResearchSource {
  const checked = sourceSchema.safeParse(value)
  if (!checked.success)
    throw new ResearchValidationError(['input: malformed source or evidence metadata'], checked.error)
  const input = checked.data
  if (createHash('sha256').update(input.source.body).digest('hex') !== input.source.bodyHash)
    throw new ResearchValidationError(['input: source body digest mismatch'])
  const ids = input.evidence.units.map(unit => unit.id)
  if (new Set(ids).size !== ids.length)
    throw new ResearchValidationError(['input: duplicate evidence-unit identifiers'])
  if (input.evidence.kind === 'text') {
    if (JSON.stringify(input.evidence) !== JSON.stringify(paragraphEvidence(input.source.body)))
      throw new ResearchValidationError(['input: paragraphs do not match the original source ranges'])
  } else {
    let previous = -1
    for (const unit of input.evidence.units) {
      if (unit.start < previous || unit.end <= unit.start || unit.end > input.evidence.durationSeconds + 0.1)
        throw new ResearchValidationError(['input: transcript segment bounds are invalid'])
      previous = unit.end
    }
    if (
      normalizedTranscriptWords(input.evidence.units.map(unit => unit.text).join(' ')) !==
      normalizedTranscriptWords(input.source.body)
    )
      throw new ResearchValidationError(['input: transcript and full text disagree'])
  }
  return input
}

/**
 * Validate the complete report, exact quotes and ordered chapter coverage.
 * @param value - complete untrusted model object.
 * @param evidence - original fixed source units.
 * @returns checked report; malformed fields, false quotes and cross-chapter evidence never pass silently.
 */
export function validateResearchReport(value: unknown, evidence: ResearchEvidence): ResearchReport {
  const decoded = reportSchema.safeParse(value)
  if (!decoded.success)
    throw new ResearchValidationError(
      decoded.error.issues.map(issue => `${issue.path.join('.') || 'report'}: ${issue.message}`),
      decoded.error,
    )
  const report = decoded.data,
    lookup = new Map(evidence.units.map(unit => [unit.id, unit.text])),
    issues: string[] = []
  const assigned = report.sections.flatMap(section => section.source_ids),
    expected = evidence.units.map(unit => unit.id)
  if (assigned.length !== expected.length || assigned.some((id, index) => id !== expected[index]))
    issues.push('sections.source_ids: cover every original unit once, in order')
  function check(group: readonly ResearchQuote[], path: string, allowed?: ReadonlySet<string>): void {
    const seen = new Set<string>()
    for (const [index, entry] of group.entries()) {
      const original = lookup.get(entry.source_id),
        marker = JSON.stringify([entry.source_id, entry.quote])
      if (original === undefined || !original.includes(entry.quote))
        issues.push(`${path}.${index}: quote is not verbatim from its source unit`)
      else if (Array.from(entry.quote.trim()).length < Math.min(8, Array.from(original.trim()).length))
        issues.push(`${path}.${index}: quote is too short for this source unit`)
      if (allowed !== undefined && !allowed.has(entry.source_id))
        issues.push(`${path}.${index}: quote belongs to another chapter`)
      if (seen.has(marker)) issues.push(`${path}.${index}: duplicate quote in one evidence group`)
      seen.add(marker)
    }
  }
  for (const [index, section] of report.sections.entries())
    check(section.evidence, `sections.${index}.evidence`, new Set(section.source_ids))
  for (const key of ['mechanisms', 'methods', 'creative_directions', 'issues'] as const)
    for (const [index, entry] of report[key].entries()) check(entry.evidence, `${key}.${index}.evidence`)
  check(report.propagation.evidence, 'propagation.evidence')
  check(report.opening.evidence, 'opening.evidence')
  check(report.ending.evidence, 'ending.evidence')
  for (const [index, block] of report.sidebar_analysis.blocks.entries())
    if (block.source_ids.some(id => !lookup.has(id)) || new Set(block.source_ids).size !== block.source_ids.length)
      issues.push(`sidebar_analysis.blocks.${index}: unknown or duplicate source unit`)
  if (report.creative_directions.length === 0 && report.creation_note === undefined)
    issues.push('creation_note: explain why no supported creative direction is available')
  if (issues.length !== 0) throw new ResearchValidationError(issues)
  const { creation_note, ...required } = report
  return { ...required, ...(creation_note === undefined ? {} : { creation_note }) }
}

/**
 * Decode a saved analysis body without treating legacy free text as a structured report.
 * @param body - existing string draft or immutable version body.
 * @returns checked report or explicit legacy-text envelope; invalid reports cannot bypass controlled writes.
 */
export function decodeResearchDocument(body: string): ResearchDocument | LegacyResearchDocument {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (error) {
    throw new ResearchValidationError(['body: report must be a versioned JSON envelope'], error)
  }
  const legacy = z
    .strictObject({ kind: z.literal('legacy-text'), version: z.literal(1), text: z.string(), originId: text })
    .safeParse(value)
  if (legacy.success) return legacy.data
  const checked = z
    .strictObject({
      kind: z.literal('research-report'),
      version: z.literal(1),
      report: z.unknown(),
      input: sourceSchema,
      generated: z.strictObject({
        runId: uuid.transform(entry => brandString<RunId>(entry)),
        policyVersion: text,
        provider: text,
        model: text,
        createdAt: z.iso.datetime({ precision: 3 }),
      }),
    })
    .safeParse(value)
  if (!checked.success) throw new ResearchValidationError(['body: malformed report envelope'], checked.error)
  const input = validateResearchSource(checked.data.input),
    report = validateResearchReport(checked.data.report, input.evidence)
  return { ...checked.data, input, report }
}
