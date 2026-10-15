/** Opt-in live account/API validation. The on-disk budget survives reruns and caps this task at six attempts. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type {
  ArtifactId,
  ProfileVersion,
  ProjectCreated,
  ProjectState,
  RunDTO,
  SourceDTO,
  StartCreationInput,
  VersionSaved,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { EmployeeFixture } from './employee-fixture.ts'
import { SqliteEducationRepository } from '../../education-storage-sqlite/src/repository.ts'
import { resolveConfig } from '../../education-storage-sqlite/src/index.ts'

const enabled = process.env.EDUCATION_LIVE_TESTS === '1'
const proof = fileURLToPath(new URL('../../../../.cache/education-real-model-proof', import.meta.url))
function readBudget(path: string): { attempts: number } {
  const value: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { attempts: 0 }
  if (typeof value !== 'object' || value === null || !('attempts' in value) || typeof value.attempts !== 'number') {
    throw new Error('Invalid live-model budget record')
  }
  return { attempts: value.attempts }
}
it.skipIf(!enabled)(
  'evaluates actual spoken, full revision, Unicode selection and moments outputs through the employee profile',
  { timeout: 300_000, retry: 0 },
  async () => {
    mkdirSync(proof, { recursive: true, mode: 0o700 })
    const credentials = process.env.EDUCATION_CREDENTIALS_PATH ?? join(homedir(), '.dsh/.credentials.yaml')
    if (!existsSync(credentials))
      throw new Error('Configure the existing native model credential store before live acceptance')
    const records: Array<{ scenario: string; run: RunDTO; body: string }> = []
    const budgetPath = join(proof, 'call-budget.json')
    const budget = readBudget(budgetPath)
    if (!Number.isSafeInteger(budget.attempts) || budget.attempts < 0 || budget.attempts > 6)
      throw new Error('Invalid persisted live-model budget; do not reset it to bypass the approved cap')
    const fixture = await EmployeeFixture.create([], 120_000)
    try {
      await fixture.start(`
- id: credentials
  config:
    path: ${JSON.stringify(credentials)}
- id: education-controller
  config:
    creationEnabled: true
    provider: ${JSON.stringify(process.env.EDUCATION_MODEL_PROVIDER ?? 'deepseek-account')}
    model: ${JSON.stringify(process.env.EDUCATION_MODEL ?? 'deepseek-flash')}
    generationTimeoutMs: 120000
    maxTokens: 2048
- id: fixture-credential-host
  disabled: true
- id: fixture-settings-controller
  disabled: true
`)
      const cookie = await fixture.login()
      const availability = await fixture.rpc<{ configured: boolean; provider: string; model: string }>(
        cookie,
        'creationAvailability',
        {},
      )
      expect(availability.configured).toBe(true)
      const profile = await fixture.rpc<ProfileVersion>(cookie, 'profilesSaveVersion', {
        facts:
          '这是获准的合成验收样例。我是教培机构内容运营，今天整理了一次课堂观察：老师先请学生复述题意，再一起梳理解法。没有确认的教学年限、个人教学经历、经营业绩或学生成绩。',
        preferences: '写给家长，短句、自然口语，清楚讲一件事。',
        prohibitedPromises: '不得编造数字、身份、资历、学生案例或结果；不得承诺提分、录取或升学效果。',
        expectedRevision: 0,
        requestId: randomUUID(),
      })
      const source = await fixture.rpc<SourceDTO>(cookie, 'sourcesSaveVersion', {
        title: '课堂观察（合成授权样例）',
        body: '合成观察记录：教师先请学生复述题意，再一起梳理解法。本记录不包含任何效果统计或具体学生信息。',
        sourceUrl: '',
        expectedRevision: 0,
        requestId: randomUUID(),
      })
      const create = (title: string, scenario: 'spoken-script' | 'moments') =>
        fixture.rpc<ProjectCreated>(cookie, 'projectsCreate', { title, scenario, requestId: randomUUID() })
      const generate = async (
        scenario: string,
        artifactId: ArtifactId,
        expectedDraftRevision: number,
        instruction: string,
        mode: StartCreationInput['mode'] = 'generate',
        selection?: StartCreationInput['selection'],
      ) => {
        if (budget.attempts >= 6) throw new Error('Approved six-call live-model budget is exhausted')
        budget.attempts++
        writeFileSync(budgetPath, JSON.stringify(budget) + '\n', { mode: 0o600 })
        const run = await fixture.rpc<RunDTO>(cookie, 'creationStart', {
          artifactId,
          expectedDraftRevision,
          instruction,
          mode,
          profileVersionId: profile.id,
          sourceVersionIds: [source.versionId],
          requestId: randomUUID(),
          ...(selection ? { selection } : {}),
        })
        const settled = await fixture.waitRun(cookie, run.id)
        expect(settled.status, `Live ${scenario}: ${settled.errorCode}`).toBe('completed')
        const state = await fixture.rpc<ProjectState>(cookie, 'projectsOpen', { projectId: settled.projectId })
        records.push({ scenario, run: settled, body: state.draft.body })
        writeFileSync(
          join(proof, 'results.json'),
          JSON.stringify({ availability, attempts: budget.attempts, records }, null, 2),
          { mode: 0o600 },
        )
        console.log(
          `LIVE_MODEL_RESULT ${scenario} ${JSON.stringify({ body: state.draft.body, explanation: settled.explanation })}`,
        )
        expect(state.draft.body.trim()).not.toBe('')
        expect(state.draft.body).not.toMatch(/\d+\s*(?:年教龄|名学生|%的|分以上)/)
        return state
      }
      const spoken = await create('真实模型合成口播验收', 'spoken-script')
      const first = await generate(
        'spoken-script',
        spoken.artifactId,
        0,
        '仅用已确认的合成课堂观察，写一条约45秒、可以直接拍摄的口播稿。不要增加动作、地点、人数、对话或亲历细节。',
      )
      const v1 = await fixture.rpc<VersionSaved>(cookie, 'artifactsSaveVersion', {
        artifactId: spoken.artifactId,
        expectedDraftRevision: first.draft.revision,
        expectedLatestVersionId: null,
        requestId: randomUUID(),
      })
      const manual = first.draft.body + '\n我的补充：我更关心孩子能把想法讲清楚。'
      await fixture.rpc(cookie, 'draftsSync', {
        artifactId: spoken.artifactId,
        body: manual,
        expectedDraftRevision: first.draft.revision,
        requestId: randomUUID(),
      })
      const revised = await generate(
        'full-revision',
        spoken.artifactId,
        first.draft.revision + 1,
        '缩短到200字以内，原样保留“我的补充：我更关心孩子能把想法讲清楚。”这一句，其余内容更自然。',
        'modify',
      )
      expect(revised.draft.body).toContain('我的补充：我更关心孩子能把想法讲清楚。')
      const start = revised.draft.body.indexOf('我的补充：'),
        end = revised.draft.body.length
      const selected = await generate(
        'selection',
        spoken.artifactId,
        revised.draft.revision,
        '把选区改成一句简短、自然的口播，不新增事实；只返回选区替换文字。',
        'selection',
        { start, end, bodyHash: revised.draft.bodyHash, original: revised.draft.body.slice(start, end) },
      )
      expect(selected.draft.body.slice(0, start)).toBe(revised.draft.body.slice(0, start))
      await fixture.rpc(cookie, 'artifactsSaveVersion', {
        artifactId: spoken.artifactId,
        expectedDraftRevision: selected.draft.revision,
        expectedLatestVersionId: v1.versionId,
        requestId: randomUUID(),
      })
      const moments = await create('真实模型合成朋友圈验收', 'moments')
      await generate(
        'moments',
        moments.artifactId,
        0,
        '用内容运营的视角，围绕今天整理的这次合成课堂观察，写一段100字左右的朋友圈。不要冒充亲自授课，不要增加对话、动作、地点、人数或效果。',
      )
      expect(records).toHaveLength(4)
      expect(fixture.upstream.requests).toHaveLength(0)
    } finally {
      await fixture.stop()
      const sessions = join(fixture.harnessHome, 'sessions')
      if (existsSync(sessions)) {
        mkdirSync(join(proof, 'sessions'), { recursive: true, mode: 0o700 })
        for (const name of readdirSync(sessions, { recursive: true }))
          if (typeof name === 'string' && name.endsWith('.jsonl')) {
            const text = readFileSync(join(sessions, name), 'utf8')
            expect(text).not.toContain('"name":"bash"')
            expect(text).not.toContain('"name":"pwsh"')
            copyFileSync(join(sessions, name), join(proof, 'sessions', name.replaceAll(/[\\/]/g, '_')))
          }
      }
      const checkpoint = await SqliteEducationRepository.open(resolveConfig({ path: fixture.databasePath }))
      checkpoint.close()
      copyFileSync(fixture.databasePath, join(proof, 'business.sqlite'))
      await fixture.dispose()
    }
  },
)

it.skipIf(!enabled)(
  'rechecks fact-grounded spoken and moments quality with the final two approved model calls',
  { timeout: 180_000, retry: 0 },
  async () => {
    mkdirSync(proof, { recursive: true, mode: 0o700 })
    const budgetPath = join(proof, 'call-budget.json')
    const budget = readBudget(budgetPath)
    if (!Number.isSafeInteger(budget.attempts) || budget.attempts < 0 || budget.attempts > 4)
      throw new Error('Two quality calls do not fit the remaining approved budget')
    const credentials = process.env.EDUCATION_CREDENTIALS_PATH ?? join(homedir(), '.dsh/.credentials.yaml')
    const fixture = await EmployeeFixture.create([], 120_000)
    const records: Array<{ scenario: string; run: RunDTO; body: string }> = []
    const facts =
      '合成验收样例。身份：教培机构内容运营。今天的已确认事项：整理一条课堂观察记录。记录里的已确认事件只有：老师请学生复述题意，然后一起梳理解法。没有其他已确认的个人经历、从业年限、人物性别、动作或效果。'
    try {
      await fixture.start(`
- id: credentials
  config:
    path: ${JSON.stringify(credentials)}
- id: education-controller
  config:
    creationEnabled: true
    provider: deepseek-account
    model: deepseek-flash
    generationTimeoutMs: 120000
    maxTokens: 1024
- id: fixture-credential-host
  disabled: true
- id: fixture-settings-controller
  disabled: true
`)
      const cookie = await fixture.login()
      const profile = await fixture.rpc<ProfileVersion>(cookie, 'profilesSaveVersion', {
        facts,
        preferences: '写给家长，短句、自然口语。可以表达一般想法，但不把它当作发生过的事实。',
        prohibitedPromises: '禁止捏造经历、性别、动作、成绩、人数、年限或效果；禁止提分和录取承诺。',
        expectedRevision: 0,
        requestId: randomUUID(),
      })
      const source = await fixture.rpc<SourceDTO>(cookie, 'sourcesSaveVersion', {
        title: '合成课堂观察',
        body: '已确认的记录：老师请学生复述题意，然后一起梳理解法。记录没有其他细节，也没有效果统计。',
        sourceUrl: '',
        expectedRevision: 0,
        requestId: randomUUID(),
      })
      for (const scenario of ['spoken-script', 'moments'] as const) {
        if (budget.attempts >= 6) throw new Error('Approved model budget exhausted')
        const project = await fixture.rpc<ProjectCreated>(cookie, 'projectsCreate', {
          title: `真实模型最终质量复验 ${scenario}`,
          scenario,
          requestId: randomUUID(),
        })
        budget.attempts++
        writeFileSync(budgetPath, JSON.stringify(budget) + '\n', { mode: 0o600 })
        const instruction =
          scenario === 'spoken-script'
            ? '写一条约30秒、可直接拍摄的口播。事件段只复述记录中的两项内容；可以补充一般想法，不能添加课堂动作、性别、经历或效果。不用“她/他”“在旁边听”“做久了”等未确认细节。'
            : '写一段约100字的朋友圈，记录内容运营今天整理的这条课堂观察，再表达一个一般想法。不要添加经历、性别、动作或效果，不要写“做久了”“多年”“她/他”“在旁边听”。'
        const started = await fixture.rpc<RunDTO>(cookie, 'creationStart', {
          artifactId: project.artifactId,
          expectedDraftRevision: 0,
          profileVersionId: profile.id,
          sourceVersionIds: [source.versionId],
          instruction,
          mode: 'generate',
          requestId: randomUUID(),
        })
        const run = await fixture.waitRun(cookie, started.id)
        expect(run.status, run.errorCode ?? scenario).toBe('completed')
        const state = await fixture.rpc<ProjectState>(cookie, 'projectsOpen', { projectId: project.projectId })
        records.push({ scenario, run, body: state.draft.body })
        writeFileSync(
          join(proof, 'quality-v3.json'),
          JSON.stringify({ facts, attempts: budget.attempts, records }, null, 2),
          { mode: 0o600 },
        )
        expect(state.draft.body).not.toMatch(
          /她|他先|他在|他们|做久了|从业多年|多年教学|在旁边听|我(?:带过|教过|任教|带班)/,
        )
        expect(state.draft.body.trim().length).toBeGreaterThan(30)
      }
      expect(fixture.upstream.requests).toHaveLength(0)
    } finally {
      await fixture.stop()
      const sessions = join(fixture.harnessHome, 'sessions')
      if (existsSync(sessions))
        for (const name of readdirSync(sessions, { recursive: true }))
          if (typeof name === 'string' && name.endsWith('.jsonl')) {
            mkdirSync(join(proof, 'sessions'), { recursive: true, mode: 0o700 })
            copyFileSync(join(sessions, name), join(proof, 'sessions', name.replaceAll(/[\\/]/g, '_')))
          }
      const checkpoint = await SqliteEducationRepository.open(resolveConfig({ path: fixture.databasePath }))
      checkpoint.close()
      copyFileSync(fixture.databasePath, join(proof, 'business-v3.sqlite'))
      await fixture.dispose()
    }
  },
)
