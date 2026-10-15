/** Explicitly synthetic report fixture shared by schema and native-loop integration tests. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResearchEvidence, ResearchReport, ResearchSource, SourceId, SourceVersionId } from '../src/types.ts'
import { paragraphEvidence } from '../src/research-input.ts'

export function researchSource(
  body = '这是第一段合成原文，用于验证真实引用。\n\n这是第二段合成原文，说明后续的表达关系。',
): ResearchSource {
  return {
    source: {
      id: brandString<SourceId>('00000000-0000-4000-8000-000000000001'),
      versionId: brandString<SourceVersionId>('00000000-0000-4000-8000-000000000002'),
      title: '合成原文',
      sourceUrl: '',
      revision: 1,
      authorizationRevision: 1,
      authorized: true,
      body,
      bodyHash: createHash('sha256').update(body).digest('hex'),
      createdAt: '2026-10-15T00:00:00.000Z',
    },
    evidence: paragraphEvidence(body),
    origin: {
      originalTitle: null,
      externalSourceId: null,
      sourceUrl: '',
      fileSha256: null,
      transcriptObjectSha256: null,
      videoInfo: {},
    },
  }
}

export function researchReport(evidence: ResearchEvidence): ResearchReport {
  const first = evidence.units[0]
  if (first === undefined) throw new Error('synthetic report requires evidence')
  const quotes = [{ source_id: first.id, quote: first.text }]
  return {
    schema_version: 2,
    prompt_version: 'content-research-v3.1',
    overview: {
      thesis: '合成原文的主张',
      audience: '关心该问题的读者',
      purpose: '理解原文提出的观点',
      pain: '如何把观点讲清楚',
      takeaway: '先说清一个具体问题',
    },
    compact: {
      content_summary: '合成内容概述',
      main_summary: '观点与后文的承接关系',
      reasons: [{ title: '具体观点', text: '从原文中的具体问题展开' }],
    },
    propagation: {
      summary: '合成分析：具体观点可能让相关读者关心后续解释，不代表已经验证传播效果。',
      evidence: quotes,
    },
    opening: {
      title_promise: '讲清原文的问题',
      opening_move: '先表达一个观点',
      payoff: '后续段落补充说明',
      evidence: quotes,
    },
    ending: { conclusion: '收束已表达的观点', cta: '未出现明确行动引导', evidence: quotes },
    sections: evidence.units.map(unit => ({
      source_ids: [unit.id],
      title: '原文中的表达',
      short_title: '具体表达',
      structure_tags: ['说明观点'],
      analysis_short: '用原文的具体说法承接问题',
      role: '说明当前观点',
      summary: '概括该段原文',
      analysis: '解释表达与前后关系，属于合成测试分析。',
      evidence: [{ source_id: unit.id, quote: unit.text }],
    })),
    mechanisms: [
      {
        title: '说清具体问题',
        analysis: '依据原文进行解释',
        audience_reason: '相关读者可能关心这个问题',
        connection: '前文提出问题，后文作出解释',
        learn: '换成自己的真实问题和材料',
        evidence: quotes,
      },
    ],
    sidebar_analysis: { blocks: [] },
    methods: [
      {
        title: '先明确问题',
        how: '先说一个真实且具体的问题，再解释',
        example: '围绕【自己的例子】说明问题',
        condition: '有真实原文和明确读者',
        evidence: quotes,
      },
    ],
    creative_directions: [
      {
        title: '把自己的问题讲清楚',
        angle: '使用本人真实材料',
        basis: '原文采用具体问题展开',
        opening_idea: '创作建议：从【自己的例子】开始',
        outline: ['提出自己的问题', '解释自己的真实材料'],
        what_to_keep: '具体表达的方式',
        what_to_change: '换成本人的事实与观点',
        materials: ['本人已确认的一个真实例子'],
        evidence: quotes,
      },
    ],
    issues: [],
  }
}
