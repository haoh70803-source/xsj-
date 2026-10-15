/** Actual employee Profile, shared SQLite and native Agent; only model response text is supplied by the local test server. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type {
  ProjectCreated,
  ResearchArtifactCreated,
  ResearchSource,
  ResearchState,
  RunDTO,
  SourceDTO,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { EmployeeFixture, nativeReply } from './employee-fixture.ts'
import { researchReport } from '../../education-platform/tests/research-fixture.ts'

const owned: EmployeeFixture[] = []
afterEach(async () => {
  for (const fixture of owned.splice(0)) await fixture.dispose()
})
async function prepare(timeoutMs = 10_000) {
  const fixture = await EmployeeFixture.create([], timeoutMs)
  owned.push(fixture)
  await fixture.start()
  const cookie = await fixture.login()
  const project = await fixture.rpc<ProjectCreated>(cookie, 'projectsCreate', {
    title: 'Synthetic source-only research',
    scenario: 'spoken-script',
    requestId: randomUUID(),
  })
  const source = await fixture.rpc<SourceDTO>(cookie, 'researchImportSource', {
    format: 'text',
    title: 'Synthetic original',
    content: '这是第一段合成原文，说明一个具体观点。\n\n这是第二段合成原文，继续解释前后的表达关系。',
    sourceUrl: '',
    expectedRevision: 0,
    requestId: randomUUID(),
    confirmed: true,
  })
  const input = await fixture.rpc<ResearchSource>(cookie, 'researchReadSource', { versionId: source.versionId })
  const artifact = await fixture.rpc<ResearchArtifactCreated>(cookie, 'researchEnsureArtifact', {
    projectId: project.projectId,
    requestId: randomUUID(),
  })
  const request = {
    artifactId: artifact.artifactId,
    sourceVersionId: source.versionId,
    expectedDraftRevision: 0,
    expectedLatestVersionId: null,
    requestId: randomUUID(),
    instruction: '',
  }
  return { fixture, cookie, project, source, input, artifact, request }
}

it('runs research without a personal profile, preserves the primary draft and logs only fixed source evidence', async () => {
  const value = await prepare(),
    { fixture, cookie } = value
  expect(await fixture.rpc(cookie, 'profilesReadSelf', {})).toBeNull()
  fixture.upstream.script.push(nativeReply(JSON.stringify(researchReport(value.input.evidence))))
  const [run, replay] = await Promise.all([
    fixture.rpc<RunDTO>(cookie, 'researchStart', value.request),
    fixture.rpc<RunDTO>(cookie, 'researchStart', value.request),
  ])
  expect(replay.id).toBe(run.id)
  expect(await fixture.waitRun(cookie, run.id)).toMatchObject({ status: 'completed', draftRevision: 1 })
  const opened = await fixture.rpc<ResearchState>(cookie, 'researchOpen', { artifactId: value.artifact.artifactId })
  expect(opened).toMatchObject({
    primaryArtifactId: value.project.artifactId,
    document: { kind: 'research-report', input: { evidence: { kind: 'text' } } },
  })
  expect(fixture.upstream.requests).toHaveLength(1)
  const request = JSON.stringify(fixture.upstream.requests[0])
  expect(request).toContain('第一段合成原文')
  expect(request).not.toContain('synthetic-native-key-one')
  expect(request).not.toContain('Instructions from: AGENTS.md')
  expect(request).not.toContain('"name":"pwsh"')
  if (process.env.EDUCATION_CAPTURE_RESEARCH_SNAPSHOT === 'true') {
    const target = fileURLToPath(new URL('../../../../.cache/education-stage-c-headless-source/', import.meta.url))
    mkdirSync(target, { recursive: true })
    const selected = readdirSync(join(fixture.harnessHome, 'sessions'), { recursive: true }).find((name): name is string => typeof name === 'string' && name.includes(String(run.id)) && name.endsWith('.jsonl'))
    if (selected === undefined) throw new Error('synthetic native research session was not persisted')
    const path = join(target, 'session.jsonl')
    if (existsSync(path)) throw new Error('refuse to overwrite the captured synthetic research session')
    writeFileSync(path, readFileSync(join(fixture.harnessHome, 'sessions', selected)), { mode: 0o600 })
  }
  const b = await fixture.login('employee-b')
  expect(
    (await fixture.raw(b, 'education/researchOpen', { artifactId: value.artifact.artifactId })).response.status,
  ).toBe(403)
}, 60_000)

it('records one bounded repair after a completed invalid report and retains the exact repair prompt in a second private Session', async () => {
  const value = await prepare(),
    { fixture, cookie } = value
  const good = researchReport(value.input.evidence),
    bad = {
      ...good,
      propagation: { ...good.propagation, evidence: [{ source_id: 'p_0000', quote: '不是原话，必须拒绝。' }] },
    }
  fixture.upstream.script.push(nativeReply(JSON.stringify(bad)), nativeReply(JSON.stringify(good)))
  const run = await fixture.rpc<RunDTO>(cookie, 'researchStart', value.request)
  expect(await fixture.waitRun(cookie, run.id)).toMatchObject({ status: 'completed' })
  expect(fixture.upstream.requests).toHaveLength(2)
  expect(JSON.stringify(fixture.upstream.requests[1])).toContain('上次完整输出的校验错误')
  const sessions = join(fixture.harnessHome, 'sessions')
  const logs = readdirSync(sessions, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.jsonl'))
    .map(name => readFileSync(join(sessions, name), 'utf8'))
    .join('\n')
  expect(logs).toContain('不是原话，必须拒绝')
  expect(logs).toContain('上次完整输出的校验错误')
  expect(logs).not.toContain('synthetic-native-key-one')
}, 60_000)

it('does not exceed captured repair attempts or commit malformed output', async () => {
  const value = await prepare(),
    { fixture, cookie } = value
  fixture.upstream.script.push(nativeReply('not-json'), nativeReply('still-not-json'))
  const run = await fixture.rpc<RunDTO>(cookie, 'researchStart', value.request)
  expect(await fixture.waitRun(cookie, run.id)).toMatchObject({ status: 'failed', errorCode: 'validation-failed' })
  expect(fixture.upstream.requests).toHaveLength(2)
  expect(await fixture.rpc(cookie, 'researchOpen', { artifactId: value.artifact.artifactId })).toMatchObject({
    draft: { body: '', revision: 0 },
    document: null,
    latestVersion: null,
  })
}, 60_000)

it('cancels an owned research interval without publishing partial report text', async () => {
  const value = await prepare(),
    { fixture, cookie } = value,
    delayed = nativeReply(JSON.stringify(researchReport(value.input.evidence)))
  if (delayed.kind === 'sse') delayed.delayMs = 100
  fixture.upstream.script.push(delayed)
  const run = await fixture.rpc<RunDTO>(cookie, 'researchStart', value.request)
  expect(await fixture.rpc(cookie, 'creationCancel', { runId: run.id })).toMatchObject({ status: 'cancelled' })
  expect(await fixture.rpc(cookie, 'researchOpen', { artifactId: value.artifact.artifactId })).toMatchObject({
    draft: { body: '', revision: 0 },
    document: null,
  })
}, 60_000)
