/** Actual employee deployment, native credentials and Agent loop; model output is explicitly synthetic. */
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, readdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import type {
  ProfileVersion,
  ProjectCreated,
  ProjectState,
  RequestId,
  RunDTO,
  SourceDTO,
  StartCreationInput,
  VersionSaved,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { EmployeeFixture, contentReply } from './employee-fixture.ts'
import { SqliteEducationRepository } from '../../education-storage-sqlite/src/repository.ts'
import { resolveConfig } from '../../education-storage-sqlite/src/index.ts'

const owned: EmployeeFixture[] = []
afterEach(async () => {
  for (const fixture of owned.splice(0)) await fixture.dispose()
})
async function boot(timeout = 10_000) {
  const fixture = await EmployeeFixture.create([], timeout)
  owned.push(fixture)
  await fixture.start()
  return fixture
}
async function prepare(
  fixture: EmployeeFixture,
  cookie: string,
  scenario: 'spoken-script' | 'moments' = 'spoken-script',
) {
  const profile = await fixture.rpc<ProfileVersion>(cookie, 'profilesSaveVersion', {
    facts: '合成员工甲是教培从业者，今天整理一次课程观察；无业绩或效果承诺。',
    preferences: '口语自然，短句',
    prohibitedPromises: '不承诺提分或升学效果',
    expectedRevision: 0,
    requestId: randomUUID(),
  })
  const project = await fixture.rpc<ProjectCreated>(cookie, 'projectsCreate', {
    title: 'Native acceptance synthetic project',
    scenario,
    requestId: randomUUID(),
  })
  const input: StartCreationInput = {
    artifactId: project.artifactId,
    expectedDraftRevision: 0,
    requestId: brandString<RequestId>(randomUUID()),
    profileVersionId: profile.id,
    sourceVersionIds: [],
    instruction: '依据合成事实写一段短内容',
    mode: 'generate',
  }
  return { profile, project, input }
}
it('boots anonymous login, isolates two employees, denies native management and commits content through real Agents and logs', async () => {
  const fixture = await boot(),
    a = await fixture.login(),
    b = await fixture.login('employee-b')
  const anonymous = await fetch(fixture.origin, { redirect: 'manual' })
  expect(anonymous.status).toBe(303)
  expect(anonymous.headers.get('location')).toBe('/education/sign-in')
  const signIn = await fetch(`${fixture.origin}/education/sign-in`)
  expect(signIn.status).toBe(200)
  expect(await signIn.text()).not.toContain('window.__DSH_BOOT__')
  const { project, input } = await prepare(fixture, a)
  fixture.upstream.script.push(contentReply('明确标记的合成口播结果'))
  const [first, replay] = await Promise.all([
    fixture.rpc<RunDTO>(a, 'creationStart', input),
    fixture.rpc<RunDTO>(a, 'creationStart', input),
  ])
  expect(replay.id).toBe(first.id)
  const completed = await fixture.waitRun(a, first.id)
  expect(completed).toMatchObject({ status: 'completed', candidate: '明确标记的合成口播结果', draftRevision: 1 })
  expect(fixture.upstream.requests).toHaveLength(1)
  expect(fixture.upstream.headers[0]?.['x-api-key']).toBe('synthetic-native-key-one')
  const opened = await fixture.rpc<ProjectState>(a, 'projectsOpen', { projectId: project.projectId })
  expect(opened.draft.body).toBe('明确标记的合成口播结果')
  const foreign = await fixture.raw(b, 'education/projectsOpen', { projectId: project.projectId })
  expect(foreign.response.status).toBe(403)
  for (const method of ['credentials/describe', 'credentials/set', 'session/create'])
    expect((await fixture.raw(a, method, {})).response.status, method).toBe(403)
  for (const method of ['pluginManager/list', 'workspace/list'])
    expect((await fixture.raw(a, method, {})).response.status, method).toBe(404)
  expect(JSON.stringify(fixture.upstream.requests)).not.toContain('synthetic-native-key-one')
  const requestText = JSON.stringify(fixture.upstream.requests[0])
  expect(requestText).toContain('合成员工甲')
  expect(requestText).not.toContain('tool_bash')
  const sessionFiles = readdirSync(join(fixture.harnessHome, 'sessions'), { recursive: true }).filter(
    (name): name is string => typeof name === 'string' && name.endsWith('.jsonl'),
  )
  expect(sessionFiles.length).toBeGreaterThan(0)
  const logs = sessionFiles.map(name => readFileSync(join(fixture.harnessHome, 'sessions', name), 'utf8')).join('\n')
  expect(logs).toContain('合成员工甲')
  expect(logs).toContain('明确标记的合成口播结果')
  expect(logs).not.toContain('synthetic-native-key-one')
}, 60_000)

it('rotates native credentials between operations and rejects missing references without a new run', async () => {
  const fixture = await boot(),
    cookie = await fixture.login(),
    { input } = await prepare(fixture, cookie, 'moments')
  fixture.upstream.script.push(contentReply('合成朋友圈一'), contentReply('合成朋友圈二'))
  const first = await fixture.rpc<RunDTO>(cookie, 'creationStart', input)
  expect((await fixture.waitRun(cookie, first.id)).status).toBe('completed')
  await fixture.credential('synthetic-native-key-two')
  const second = await fixture.rpc<RunDTO>(cookie, 'creationStart', {
    ...input,
    expectedDraftRevision: 1,
    mode: 'modify',
    requestId: randomUUID(),
    instruction: '基于当前编辑稿修改',
  })
  expect((await fixture.waitRun(cookie, second.id)).status).toBe('completed')
  expect(fixture.upstream.headers.map(row => row['x-api-key'])).toEqual([
    'synthetic-native-key-one',
    'synthetic-native-key-two',
  ])
  await fixture.credential('')
  const missing = await fixture.raw(cookie, 'education/creationStart', {
    ...input,
    expectedDraftRevision: 2,
    requestId: randomUUID(),
  })
  expect(missing.result).toMatchObject({ ok: false, error: { code: 'education/PROVIDER_UNAVAILABLE' } })
  expect(fixture.upstream.requests).toHaveLength(2)
}, 60_000)

it('rechecks revocation at commit, hides old history and native Session access, and preserves immutable version bytes', async () => {
  const fixture = await boot(),
    cookie = await fixture.login(),
    { project, input } = await prepare(fixture, cookie)
  const source = await fixture.rpc<SourceDTO>(cookie, 'sourcesSaveVersion', {
    title: 'Synthetic private source',
    body: '唯一的合成资料标记',
    sourceUrl: '',
    expectedRevision: 0,
    requestId: randomUUID(),
  })
  fixture.upstream.script.push(contentReply('资料派生的合成正文', [source.versionId]))
  const first = await fixture.rpc<RunDTO>(cookie, 'creationStart', { ...input, sourceVersionIds: [source.versionId] })
  expect((await fixture.waitRun(cookie, first.id)).status).toBe('completed')
  const saved = await fixture.rpc<VersionSaved>(cookie, 'artifactsSaveVersion', {
    artifactId: project.artifactId,
    expectedDraftRevision: 1,
    expectedLatestVersionId: null,
    requestId: randomUUID(),
  })
  const slow = contentReply('不能提交的撤权后候选', [source.versionId])
  if (slow.kind === 'sse') slow.delayMs = 100
  fixture.upstream.script.push(slow)
  const run = await fixture.rpc<RunDTO>(cookie, 'creationStart', {
    ...input,
    expectedDraftRevision: 1,
    requestId: randomUUID(),
    mode: 'modify',
    sourceVersionIds: [source.versionId],
  })
  await fixture.rpc(cookie, 'sourcesSetAuthorization', {
    sourceId: source.id,
    authorized: false,
    expectedAuthorizationRevision: 1,
    requestId: randomUUID(),
  })
  expect(await fixture.waitRun(cookie, run.id)).toMatchObject({ status: 'failed', restricted: true, candidate: null })
  expect(await fixture.rpc(cookie, 'projectsOpen', { projectId: project.projectId })).toMatchObject({
    draft: { body: '', restricted: true },
  })
  const exported = await fetch(
    `${fixture.origin}/api/education/artifacts.exportText?artifactId=${project.artifactId}&target=version&versionId=${saved.versionId}`,
    { headers: { Cookie: cookie, Origin: fixture.origin } },
  )
  expect(exported.status).toBe(403)
  const read = new DatabaseSync(fixture.databasePath)
  try {
    expect(read.prepare('SELECT body FROM artifact_versions WHERE id=?').get(saved.versionId)?.body).toBe(
      '资料派生的合成正文',
    )
  } finally {
    read.close()
  }
}, 60_000)

it('keeps originals after stop and timeout and marks a killed process interrupted without replaying generation', async () => {
  const fixture = await boot(1000),
    cookie = await fixture.login(),
    { input, project } = await prepare(fixture, cookie)
  const delayed = contentReply('必须丢弃的部分输出')
  if (delayed.kind === 'sse') delayed.delayMs = 600
  fixture.upstream.script.push(delayed)
  const stopped = await fixture.rpc<RunDTO>(cookie, 'creationStart', input)
  const cancelled = await fixture.rpc<RunDTO>(cookie, 'creationCancel', { runId: stopped.id })
  expect(cancelled.status).toBe('cancelled')
  fixture.upstream.script.push(delayed)
  const timed = await fixture.rpc<RunDTO>(cookie, 'creationStart', { ...input, requestId: randomUUID() })
  expect(await fixture.waitRun(cookie, timed.id)).toMatchObject({ status: 'failed', errorCode: 'timeout' })
  fixture.upstream.script.push(delayed)
  const interrupted = await fixture.rpc<RunDTO>(cookie, 'creationStart', { ...input, requestId: randomUUID() })
  await fixture.stop()
  const calls = fixture.upstream.requests.length
  await fixture.start()
  expect(await fixture.rpc(cookie, 'creationGetRun', { runId: interrupted.id })).toMatchObject({
    status: 'interrupted',
  })
  expect(fixture.upstream.requests).toHaveLength(calls)
  expect(await fixture.rpc(cookie, 'projectsOpen', { projectId: project.projectId })).toMatchObject({
    draft: { revision: 0, body: '' },
  })
  await fixture.stop()
  const checkpoint = await SqliteEducationRepository.open(resolveConfig({ path: fixture.databasePath }))
  checkpoint.close()
  const backup = join(fixture.root, 'closed-backup.sqlite')
  copyFileSync(fixture.databasePath, backup)
  const restored = await SqliteEducationRepository.open(resolveConfig({ path: backup }))
  try {
    const token = cookie.split('=')[1]!,
      actor = restored.resolveLoginSession(createHash('sha256').update(token).digest('hex'))
    expect(actor).not.toBeNull()
    if (actor) expect(restored.openProject(actor, project.projectId).draft.body).toBe('')
  } finally {
    restored.close()
  }
}, 60_000)
