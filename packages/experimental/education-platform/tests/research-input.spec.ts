/** Fixed Python-generated vectors independently pin V1 numeric serialization and import semantics. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { paragraphEvidence, parseResearchInputV1 } from '../src/research-input.ts'

const fixture = z
  .object({
    vectors: z.array(z.object({ name: z.string(), raw: z.string(), canonical: z.string(), objectHash: z.string() })),
  })
  .parse(JSON.parse(readFileSync(new URL('./fixtures/research-v1-python.json', import.meta.url), 'utf8')))
const first = fixture.vectors[0],
  floating = fixture.vectors.find(vector => vector.name === 'float-times')
if (first === undefined || floating === undefined) throw new Error('Python compatibility fixtures are missing')
const bound = 1_000_000
const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value)
const change = (raw: string, mutate: (value: Record<string, unknown>) => void) => {
  const value = object(JSON.parse(raw))
  mutate(value)
  return JSON.stringify(value)
}

it.each(fixture.vectors)('retains the Python V1 object bytes for $name', (vector) => {
  const parsed = parseResearchInputV1(vector.raw, bound)
  expect(parsed.canonicalTranscript).toBe(vector.canonical)
  expect(parsed.origin.transcriptObjectSha256).toBe(vector.objectHash)
  expect(parsed.origin.fileSha256).toBe(createHash('sha256').update(vector.raw).digest('hex'))
  expect(parsed.origin.fileSha256).not.toBe(parsed.origin.transcriptObjectSha256)
})

it('preserves original float categories while normalizing the schema-version field as Python does', () => {
  const raw = floating.raw.replaceAll('"schema_version":1', '"schema_version":1.0')
  expect(parseResearchInputV1(raw, bound).origin.transcriptObjectSha256).toBe(floating.objectHash)
  expect(parseResearchInputV1(floating.raw, bound).origin.transcriptObjectSha256).toBe(
    '5cd674e9e8ddee5799fad14c54596336ebdd59c52af24c6097a68ef54bdea603',
  )
})

it('does not accept JavaScript-reserialized numbers as a substitute for the producer’s V1 digest', () => {
  const collapsed = JSON.stringify(JSON.parse(floating.raw))
  expect(() => parseResearchInputV1(collapsed, bound)).toThrow('digest')
})

it('distinguishes file bytes from the normalized object and preserves zero and null video metrics', () => {
  const original = parseResearchInputV1(first.raw, bound),
    whitespace = parseResearchInputV1(first.raw + '\n ', bound)
  expect(whitespace.origin.transcriptObjectSha256).toBe(original.origin.transcriptObjectSha256)
  expect(whitespace.origin.fileSha256).not.toBe(original.origin.fileSha256)
  expect(original.origin.videoInfo).toMatchObject({ followers: 0, likes: null })
  expect(() => parseResearchInputV1(first.raw.replace('"followers":0', '"followers":0.0'), bound)).toThrow('metrics')
})

it('rejects changed full text, overlapping times, media declarations and unsupported format versions', () => {
  expect(() =>
    parseResearchInputV1(
      change(first.raw, (root) => {
        const transcript = object(root.transcript)
        transcript.full_text = '篡改内容'
        root.transcript = transcript
      }),
      bound,
    ),
  ).toThrow('full text')
  expect(() =>
    parseResearchInputV1(
      change(first.raw, (root) => {
        root.media_file = 'source.mp4'
      }),
      bound,
    ),
  ).toThrow('media')
  expect(() =>
    parseResearchInputV1(
      change(first.raw, (root) => {
        root.schema_version = 99
      }),
      bound,
    ),
  ).toThrow('invalid')
  expect(() =>
    parseResearchInputV1(
      change(first.raw, (root) => {
        const transcript = object(root.transcript)
        transcript.segments = [{ start: 0.5, end: 0.25, text: '无效时间' }]
        root.transcript = transcript
      }),
      bound,
    ),
  ).toThrow('times')
})

it('rejects a tampered digest, nonfinite numbers and an oversized file before analysis can begin', () => {
  expect(() =>
    parseResearchInputV1(
      change(first.raw, (root) => {
        root.transcript_sha256 = '0'.repeat(64)
      }),
      bound,
    ),
  ).toThrow('digest')
  expect(() =>
    parseResearchInputV1(first.raw.replace('"duration_seconds":1', '"duration_seconds":1e309'), bound),
  ).toThrow('nonfinite')
  expect(() => parseResearchInputV1(first.raw, 2)).toThrow('byte limit')
})

it('represents short original text as paragraphs with exact UTF-16 ranges and no fabricated timing', () => {
  const body = '先听😀再说。\n\n短句。',
    evidence = paragraphEvidence(body)
  expect(evidence.kind).toBe('text')
  if (evidence.kind !== 'text') throw new Error('plain text became a transcript')
  expect(evidence.units).toHaveLength(2)
  for (const unit of evidence.units) {
    expect(body.slice(unit.startOffset, unit.endOffset)).toBe(unit.text)
    expect(unit).not.toHaveProperty('start')
    expect(unit).not.toHaveProperty('end')
  }
  expect(() => paragraphEvidence(' \n ')).toThrow('empty')
})
