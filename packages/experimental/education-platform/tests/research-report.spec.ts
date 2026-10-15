/** Explicit report validation closes missing, false, duplicate and cross-chapter evidence paths. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResearchDocument, RunId } from '../src/types.ts'
import { decodeResearchDocument, validateResearchReport, validateResearchSource } from '../src/research-report.ts'
import { researchReport, researchSource } from './research-fixture.ts'

const input = researchSource(),
  report = researchReport(input.evidence)
it('validates dynamic sections and source evidence without a creator profile or fabricated times', () => {
  expect(validateResearchSource(input)).toEqual(input)
  expect(validateResearchReport(report, input.evidence).sections).toHaveLength(2)
  expect(input).not.toHaveProperty('profile')
  expect(input.evidence.units[0]).not.toHaveProperty('start')
})
it('allows a complete quote from a legitimate source shorter than eight characters', () => {
  const short = researchSource('先听再说。')
  expect(validateResearchReport(researchReport(short.evidence), short.evidence).sections).toHaveLength(1)
})
it('rejects a quote that changes or concatenates author text', () => {
  const changed = {
    ...report,
    propagation: { ...report.propagation, evidence: [{ source_id: 'p_0000', quote: '这不是作者说过的话。' }] },
  }
  expect(() => validateResearchReport(changed, input.evidence)).toThrow('evidence checks')
})
it('rejects repeated or omitted chapter assignments instead of using a disabled assertion', () => {
  expect(() => validateResearchReport({ ...report, sections: report.sections.slice(1) }, input.evidence)).toThrow(
    'evidence checks',
  )
  expect(() =>
    validateResearchReport({ ...report, sections: [...report.sections, ...report.sections] }, input.evidence),
  ).toThrow('evidence checks')
})
it('rejects a globally valid quote when it belongs to a different chapter', () => {
  const first = report.sections[0],
    second = report.sections[1]
  if (first === undefined || second === undefined) throw new Error('expected two synthetic sections')
  const crossed = [{ ...first, evidence: second.evidence }, second]
  expect(() => validateResearchReport({ ...report, sections: crossed }, input.evidence)).toThrow('evidence checks')
})
it('rejects duplicate evidence within a group and unsupported report fields or versions', () => {
  expect(() =>
    validateResearchReport(
      {
        ...report,
        propagation: {
          ...report.propagation,
          evidence: [...report.propagation.evidence, ...report.propagation.evidence],
        },
      },
      input.evidence,
    ),
  ).toThrow('evidence checks')
  expect(() => validateResearchReport({ ...report, schema_version: 1 }, input.evidence)).toThrow('field or evidence')
  expect(() => validateResearchReport({ ...report, invented_field: 'unrecognized' }, input.evidence)).toThrow(
    'field or evidence',
  )
})
it('requires an explanation when material does not support any creative direction', () => {
  expect(() => validateResearchReport({ ...report, creative_directions: [] }, input.evidence)).toThrow(
    'evidence checks',
  )
  expect(
    validateResearchReport(
      { ...report, creative_directions: [], creation_note: '材料不足，先核实原文，不虚构选题。' },
      input.evidence,
    ).creative_directions,
  ).toEqual([])
})
it('rejects body tampering and invented paragraph ranges before a report can be read or saved', () => {
  expect(() => validateResearchSource({ ...input, source: { ...input.source, body: '篡改正文' } })).toThrow(
    'evidence checks',
  )
  expect(() =>
    validateResearchSource({
      ...input,
      evidence: { kind: 'text', units: [{ id: 'p_0000', text: '虚构段落', startOffset: 0, endOffset: 4 }] },
    }),
  ).toThrow('evidence checks')
})
it('keeps saved structured reports separate from explicitly labeled legacy text', () => {
  const document: ResearchDocument = {
    kind: 'research-report',
    version: 1,
    input,
    report,
    generated: {
      runId: brandString<RunId>('00000000-0000-4000-8000-000000000003'),
      policyVersion: 'synthetic-policy',
      provider: 'synthetic',
      model: 'synthetic',
      createdAt: '2026-10-15T00:00:00.000Z',
    },
  }
  expect(decodeResearchDocument(JSON.stringify(document))).toEqual(document)
  expect(
    decodeResearchDocument(
      JSON.stringify({ kind: 'legacy-text', version: 1, text: '原型旧稿', originId: 'synthetic-prototype-work' }),
    ),
  ).toMatchObject({ kind: 'legacy-text', text: '原型旧稿' })
  expect(() => decodeResearchDocument('旧自由文本不能冒充新版报告')).toThrow('evidence checks')
})
