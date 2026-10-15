/** Real SQLite tests for immutable context, optimistic concurrency and authorization at commit. */
import { beforeEach, afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ActorContext,
  ProfileVersion,
  RequestId,
  StartCreationInput,
  SourceDTO,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { resolveConfig } from '../src/index.ts'
import { SqliteEducationRepository } from '../src/repository.ts'
import { digest, newId, text } from '../src/codec.ts'

const cache = fileURLToPath(new URL('../../../../.cache/education-creation-tests', import.meta.url))
let root: string, path: string, repository: SqliteEducationRepository, inspect: DatabaseSync
let a: ActorContext, b: ActorContext, profile: ProfileVersion
function employee(username: string, organizationId = a.organizationId): ActorContext {
  const user = repository.provisionUser({
    organizationId,
    usernameNormalized: username,
    credentialSalt: '1'.repeat(32),
    credentialHash: '2'.repeat(128),
  })
  const tokenHash = digest(username)
  repository.createLoginSession({
    organizationId,
    userId: user.id,
    tokenHash,
    authRevision: 0,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })
  const actor = repository.resolveLoginSession(tokenHash)
  if (actor === null) throw new Error('test login missing')
  return actor
}
function source(body = '本人确认的教学观察'): SourceDTO {
  return repository.creation.saveSource(a, {
    title: '合成授权资料',
    body,
    sourceUrl: '',
    expectedRevision: 0,
    requestId: newId(),
  })
}
function request(
  sources: readonly SourceDTO[] = [],
  scenario: 'spoken-script' | 'moments' = 'spoken-script',
): StartCreationInput {
  const project = repository.createProject(a, { title: '合成创作', scenario, requestId: newId() })
  return {
    artifactId: project.artifactId,
    expectedDraftRevision: 0,
    requestId: newId(),
    profileVersionId: profile.id,
    sourceVersionIds: sources.map(row => row.versionId),
    instruction: '只依据所给事实，写一条简短内容',
    mode: 'generate',
  }
}
function start(input: StartCreationInput) {
  return repository.creation.start(a, input, 'synthetic-policy-v1', 120_000)
}
beforeEach(async () => {
  mkdirSync(cache, { recursive: true })
  root = mkdtempSync(join(cache, 'owned-'))
  path = join(root, 'education.sqlite')
  repository = await SqliteEducationRepository.open(resolveConfig({ path }))
  const organizationId = repository.provisionOrganization('合成创作测试组织')
  a = employee('creator-a', organizationId)
  b = employee('creator-b', organizationId)
  profile = repository.creation.saveProfile(a, {
    facts: '我是教培从业者，只确认这条合成事实。',
    preferences: '清楚自然',
    prohibitedPromises: '不承诺分数或升学效果',
    expectedRevision: 0,
    requestId: newId(),
  })
  inspect = new DatabaseSync(path)
})
afterEach(() => {
  inspect?.close()
  repository?.close()
  if (dirname(resolve(root)) !== resolve(cache) || !root.startsWith(join(cache, 'owned-')))
    throw new Error('cleanup outside owned fixture')
  rmSync(root, { recursive: true, force: true })
})

it('appends immutable owner profiles and rejects stale revisions and foreign IDs', () => {
  expect(repository.creation.readProfile(b)).toBeNull()
  const input = {
    facts: '本人新增事实',
    preferences: '',
    prohibitedPromises: '',
    expectedRevision: 1,
    requestId: newId<RequestId>(),
  }
  const next = repository.creation.saveProfile(a, input)
  expect(next.revision).toBe(2)
  expect(repository.creation.saveProfile(a, input)).toEqual(next)
  expect(() => repository.creation.saveProfile(a, { ...input, requestId: newId() })).toThrow(
    expect.objectContaining({ code: 'draft-conflict' }),
  )
  expect(() => inspect.prepare('UPDATE profile_versions SET revision=5 WHERE id=?').run(profile.id)).toThrow()
  expect(() => repository.creation.start(b, request(), 'policy', 120_000)).toThrow(
    expect.objectContaining({ code: 'resource-unavailable' }),
  )
})
it('keeps source versions immutable and authorization independent; old receipts cannot restore revoked text', () => {
  const material = source('旧正文')
  const input = {
    sourceId: material.id,
    title: '更新标题',
    body: '新正文',
    sourceUrl: '',
    expectedRevision: 1,
    requestId: newId<RequestId>(),
  }
  const next = repository.creation.saveSource(a, input)
  expect(next.versionId).not.toBe(material.versionId)
  expect(inspect.prepare('SELECT body FROM source_versions WHERE id=?').get(material.versionId)?.body).toBe('旧正文')
  repository.creation.authorizeSource(a, {
    sourceId: material.id,
    authorized: false,
    expectedAuthorizationRevision: 1,
    requestId: newId(),
  })
  expect(repository.creation.saveSource(a, input).body).toBe('')
  expect(repository.creation.listSources(b)).toEqual([])
  expect(() => inspect.prepare('DELETE FROM source_versions WHERE id=?').run(material.versionId)).toThrow()
})
it('uses one durable run for a request, rejects changed retries and blocks conflicting writes', () => {
  const input = request(),
    run = start(input)
  expect(start(input).id).toBe(run.id)
  expect(() => start({ ...input, instruction: 'changed' })).toThrow(
    expect.objectContaining({ code: 'idempotency-conflict' }),
  )
  expect(() =>
    repository.syncDraft(a, {
      artifactId: input.artifactId,
      body: 'conflict',
      expectedDraftRevision: 0,
      requestId: newId(),
    }),
  ).toThrow(expect.objectContaining({ code: 'draft-conflict' }))
  expect(() =>
    repository.saveVersion(a, {
      artifactId: input.artifactId,
      expectedDraftRevision: 0,
      expectedLatestVersionId: null,
      requestId: newId(),
    }),
  ).toThrow(expect.objectContaining({ code: 'draft-conflict' }))
  expect(() => start({ ...input, requestId: newId() })).toThrow(expect.objectContaining({ code: 'draft-conflict' }))
  expect(start(request()).status).toBe('pending')
})
it('commits complete candidates as drafts, preserves immutable V1/V2 and fixes source evidence', () => {
  const material = source(),
    input = request([material], 'moments'),
    run = start(input)
  expect(repository.creation.complete(a, run.id, '朋友圈初稿', '解释').status).toBe('completed')
  const v1 = repository.saveVersion(a, {
    artifactId: input.artifactId,
    expectedDraftRevision: 1,
    expectedLatestVersionId: null,
    requestId: newId(),
  })
  repository.syncDraft(a, {
    artifactId: input.artifactId,
    body: '用户直接编辑',
    expectedDraftRevision: 1,
    requestId: newId(),
  })
  const v2 = repository.saveVersion(a, {
    artifactId: input.artifactId,
    expectedDraftRevision: 2,
    expectedLatestVersionId: v1.versionId,
    requestId: newId(),
  })
  expect(repository.readVersion(a, input.artifactId, v1.versionId)).toMatchObject({
    body: '朋友圈初稿',
    basisSnapshot: { source: 'creation-context', materialVersionIds: [material.versionId] },
  })
  expect(repository.readVersion(a, input.artifactId, v2.versionId).body).toBe('用户直接编辑')
  repository.restoreVersion(a, {
    artifactId: input.artifactId,
    versionId: v1.versionId,
    expectedDraftRevision: 2,
    requestId: newId(),
  })
  expect(
    repository.saveVersion(a, {
      artifactId: input.artifactId,
      expectedDraftRevision: 3,
      expectedLatestVersionId: v2.versionId,
      requestId: newId(),
    }).versionNo,
  ).toBe(3)
  expect(repository.openProject(a, run.projectId).project.scenario).toBe('moments')
})
it('redacts revoked derivatives, conversations and run candidates; prohibits restore, export reads and reuse', () => {
  const material = source(),
    input = request([material]),
    run = start(input)
  repository.creation.complete(a, run.id, '引用资料的正文', '引用说明')
  const version = repository.saveVersion(a, {
    artifactId: input.artifactId,
    expectedDraftRevision: 1,
    expectedLatestVersionId: null,
    requestId: newId(),
  })
  repository.creation.authorizeSource(a, {
    sourceId: material.id,
    authorized: false,
    expectedAuthorizationRevision: 1,
    requestId: newId(),
  })
  expect(repository.readDraft(a, input.artifactId)).toMatchObject({ body: '', restricted: true })
  expect(repository.readVersion(a, input.artifactId, version.versionId)).toMatchObject({ body: '', restricted: true })
  expect(repository.creation.getRun(a, run.id)).toMatchObject({ candidate: null, explanation: null, restricted: true })
  expect(
    repository.creation
      .readState(a, input.artifactId)
      .dialogue.every(message => message.body === '' && message.restricted),
  ).toBe(true)
  expect(() =>
    repository.restoreVersion(a, {
      artifactId: input.artifactId,
      versionId: version.versionId,
      expectedDraftRevision: 1,
      requestId: newId(),
    }),
  ).toThrow()
  expect(() => start({ ...input, expectedDraftRevision: 1, requestId: newId() })).toThrow()
  expect(inspect.prepare('SELECT body FROM artifact_versions WHERE id=?').get(version.versionId)?.body).toBe(
    '引用资料的正文',
  )
})
it('rechecks a revoked grant before candidate commit and cannot revive old grants after reauthorization', () => {
  const material = source(),
    input = request([material]),
    run = start(input)
  repository.creation.authorizeSource(a, {
    sourceId: material.id,
    authorized: false,
    expectedAuthorizationRevision: 1,
    requestId: newId(),
  })
  const result = repository.creation.complete(a, run.id, '禁止提交', '说明')
  expect(result).toMatchObject({ status: 'failed', restricted: true, candidate: null })
  expect(repository.readDraft(a, input.artifactId).body).toBe('')
  repository.creation.authorizeSource(a, {
    sourceId: material.id,
    authorized: true,
    expectedAuthorizationRevision: 2,
    requestId: newId(),
  })
  expect(repository.creation.getRun(a, run.id).restricted).toBe(true)
})
it('changes context on new facts and rejects in-flight results using the old profile', () => {
  const input = request(),
    run = start(input)
  const next = repository.creation.saveProfile(a, {
    facts: '新的已确认事实',
    preferences: '',
    prohibitedPromises: '',
    expectedRevision: 1,
    requestId: newId(),
  })
  expect(repository.creation.complete(a, run.id, '旧事实候选', '说明')).toMatchObject({
    status: 'failed',
    errorCode: 'draft-conflict',
  })
  const nextRun = start({ ...input, requestId: newId(), profileVersionId: next.id })
  expect(nextRun.contextFingerprint).not.toBe(run.contextFingerprint)
  expect(repository.creation.input(a, nextRun.id).profile.facts).toBe(next.facts)
})
it('preserves every character outside a Chinese/emoji selection on the normalized LF draft', () => {
  const input = request()
  repository.syncDraft(a, {
    artifactId: input.artifactId,
    body: '前😀\r\n只改这里\r\n结尾',
    expectedDraftRevision: 0,
    requestId: newId(),
  })
  const draft = repository.readDraft(a, input.artifactId),
    startIndex = draft.body.indexOf('只改')
  const run = start({
    ...input,
    expectedDraftRevision: 1,
    mode: 'selection',
    selection: { start: startIndex, end: startIndex + 4, original: '只改这里', bodyHash: draft.bodyHash },
  })
  repository.creation.complete(a, run.id, '更新片段✨', '只改选区')
  expect(repository.readDraft(a, input.artifactId).body).toBe('前😀\n更新片段✨\n结尾')
})
it('rejects surrogate splits, mismatched fragments and stale hashes without creating a run', () => {
  const input = request()
  repository.syncDraft(a, {
    artifactId: input.artifactId,
    body: '前😀后',
    expectedDraftRevision: 0,
    requestId: newId(),
  })
  const draft = repository.readDraft(a, input.artifactId)
  for (const selection of [
    { start: 2, end: 3, original: '\ude00', bodyHash: draft.bodyHash },
    { start: 1, end: 3, original: '😀', bodyHash: digest('stale') },
    { start: 1, end: 3, original: 'wrong', bodyHash: draft.bodyHash },
  ]) {
    expect(() =>
      start({ ...input, expectedDraftRevision: 1, mode: 'selection', selection, requestId: newId() }),
    ).toThrow(expect.objectContaining({ code: 'validation-failed' }))
  }
  expect(repository.creation.readState(a, input.artifactId).run).toBeNull()
})
it('releases failed/cancelled occupancy and prevents late partial output from overwriting the original', () => {
  const input = request(),
    run = start(input)
  repository.creation.fail(a, run.id, 'cancelled', 'user')
  expect(repository.creation.complete(a, run.id, 'late partial', '')).toMatchObject({
    status: 'cancelled',
    candidate: null,
  })
  expect(repository.readDraft(a, input.artifactId).revision).toBe(0)
  expect(start({ ...input, requestId: newId() }).status).toBe('pending')
})
it('settles a runtime-owned abandoned run even when its initiating login was revoked', () => {
  const input = request(),
    run = start(input)
  repository.revokeLoginSession(a.loginSessionId)
  expect(() => repository.creation.getRun(a, run.id)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  repository.creation.abandon(run.id, 'interrupted', 'identity-revoked')
  expect(inspect.prepare('SELECT status FROM creation_runs WHERE id=?').get(run.id)?.status).toBe('interrupted')
})
it('marks only unsettled runs interrupted after reopening and never creates model work', async () => {
  const first = start(request()),
    second = start(request())
  repository.creation.complete(a, second.id, '保留稿件', '说明')
  repository.close()
  repository = await SqliteEducationRepository.open(resolveConfig({ path }))
  expect(repository.creation.interruptPending()).toBe(1)
  expect(repository.creation.getRun(a, first.id).status).toBe('interrupted')
  expect(repository.creation.getRun(a, second.id).status).toBe('completed')
  expect(repository.creation.interruptPending()).toBe(0)
})
it('rolls back all candidate, draft, dialogue and outcome changes when commit auditing fails', () => {
  const input = request(),
    run = start(input)
  inspect.exec(
    "CREATE TRIGGER reject_creation BEFORE INSERT ON audit_records WHEN NEW.action='creation.complete' BEGIN SELECT RAISE(ABORT,'synthetic fault'); END",
  )
  expect(() => repository.creation.complete(a, run.id, '不能部分提交', '说明')).toThrow()
  expect(repository.readDraft(a, input.artifactId).revision).toBe(0)
  expect(repository.creation.getRun(a, run.id)).toMatchObject({ status: 'pending', candidate: null })
  expect(repository.creation.readState(a, input.artifactId).dialogue).toHaveLength(1)
})
it('bounds the complete input and rejects foreign source versions, without replacing old drafts', () => {
  const material = source(),
    input = request([material])
  expect(() => repository.creation.start(a, input, 'policy', 10)).toThrow(
    expect.objectContaining({ code: 'validation-failed' }),
  )
  const otherProfile = repository.creation.saveProfile(b, {
    facts: 'other synthetic profile',
    preferences: '',
    prohibitedPromises: '',
    expectedRevision: 0,
    requestId: newId(),
  })
  const project = repository.createProject(b, { title: 'B', scenario: 'spoken-script', requestId: newId() })
  expect(() =>
    repository.creation.start(
      b,
      { ...input, artifactId: project.artifactId, profileVersionId: otherProfile.id },
      'policy',
      120_000,
    ),
  ).toThrow(expect.objectContaining({ code: 'resource-unavailable' }))
})

it('starts an empty safe branch in the same project after revocation while preserving hidden immutable history', () => {
  const material = source('撤权后的原文不能出现在新会话'),
    input = request([material]),
    run = start(input)
  repository.creation.complete(a, run.id, '依赖旧来源的正文', '解释')
  const version = repository.saveVersion(a, {
    artifactId: input.artifactId,
    expectedDraftRevision: 1,
    expectedLatestVersionId: null,
    requestId: newId(),
  })
  repository.creation.authorizeSource(a, {
    sourceId: material.id,
    authorized: false,
    expectedAuthorizationRevision: 1,
    requestId: newId(),
  })
  const requestId = newId<RequestId>()
  const reset = repository.creation.resetContext(a, input.artifactId, 1, requestId)
  expect(repository.creation.resetContext(a, input.artifactId, 1, requestId)).toEqual(reset)
  expect(repository.creation.mutationResult(a, 'context.reset', requestId)).toEqual(reset)
  expect(repository.creation.mutationResult(b, 'context.reset', requestId)).toBeNull()
  const next = start({ ...input, expectedDraftRevision: 2, sourceVersionIds: [], requestId: newId() })
  const snapshot = repository.creation.input(a, next.id)
  expect(snapshot.draft).toBe('')
  expect(snapshot.sources).toEqual([])
  expect(JSON.stringify(snapshot)).not.toContain('撤权后的原文')
  expect(next.projectId).toBe(run.projectId)
  expect(repository.readVersion(a, input.artifactId, version.versionId)).toMatchObject({ restricted: true, body: '' })
})
it('requires an explicit safe branch before sending old derived text with a changed profile', () => {
  const input = request(),
    run = start(input)
  repository.creation.complete(a, run.id, '旧事实生成的稿件', '说明')
  const nextProfile = repository.creation.saveProfile(a, {
    facts: '仅有新的已确认事实',
    preferences: '',
    prohibitedPromises: '',
    expectedRevision: 1,
    requestId: newId(),
  })
  const next = { ...input, profileVersionId: nextProfile.id, expectedDraftRevision: 1, requestId: newId<RequestId>() }
  expect(() => start(next)).toThrow(expect.objectContaining({ code: 'draft-conflict' }))
  repository.creation.resetContext(a, input.artifactId, 1, newId())
  const branch = start({ ...next, expectedDraftRevision: 2 })
  expect(repository.creation.input(a, branch.id)).toMatchObject({ draft: '', profile: { facts: '仅有新的已确认事实' } })
})

async function oldDatabase() {
  const project = repository.createProject(a, { title: '旧版基础验证', scenario: 'spoken-script', requestId: newId() })
  repository.syncDraft(a, {
    artifactId: project.artifactId,
    body: '原有正式版本\n空依据不得回填',
    expectedDraftRevision: 0,
    requestId: newId(),
  })
  const saved = repository.saveVersion(a, {
    artifactId: project.artifactId,
    expectedDraftRevision: 1,
    expectedLatestVersionId: null,
    requestId: newId(),
  })
  const oldPath = join(root, 'stage-a-v1.sqlite'),
    old = new DatabaseSync(oldPath)
  old.exec(readFileSync(new URL('./fixtures/schema-v1.sql', import.meta.url), 'utf8'))
  try {
    old.exec('BEGIN; PRAGMA defer_foreign_keys=ON')
    for (const table of [
      'organizations',
      'users',
      'login_sessions',
      'projects',
      'artifacts',
      'drafts',
      'artifact_versions',
      'request_receipts',
      'session_bindings',
      'audit_records',
    ]) {
      const columns = old
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(column => text(column, 'name'))
      for (const row of inspect.prepare(`SELECT * FROM ${table}`).all())
        old.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(
          ...columns.map((column) => {
            const value = row[column]
            if (value === undefined) throw new Error('old fixture column is missing')
            return value
          }),
        )
    }
    old.exec('COMMIT')
    const version = old.prepare('SELECT * FROM artifact_versions WHERE id=?').get(saved.versionId)
    return { oldPath, project, saved, version }
  } finally {
    old.close()
  }
}
it('migrates a frozen v1 database without changing old versions, receipts or foundation evidence', async () => {
  const { oldPath, project, saved, version } = await oldDatabase()
  const migrated = await SqliteEducationRepository.open(resolveConfig({ path: oldPath }))
  try {
    expect(migrated.readVersion(a, project.artifactId, saved.versionId)).toMatchObject({
      body: '原有正式版本\n空依据不得回填',
      basisSnapshot: { source: 'foundation-validation', profileVersionIds: [], materialVersionIds: [] },
    })
    const read = new DatabaseSync(oldPath)
    try {
      expect(read.prepare('SELECT * FROM artifact_versions WHERE id=?').get(saved.versionId)).toEqual(version)
      expect(read.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      read.close()
    }
    const moments = migrated.createProject(a, { title: '升级后的朋友圈', scenario: 'moments', requestId: newId() })
    expect(migrated.openProject(a, moments.projectId).artifact.kind).toBe('moments')
  } finally {
    migrated.close()
  }
})
it('rolls back a failed v1 table rebuild without changing the old version or schema stamp', async () => {
  const { oldPath, saved, version } = await oldDatabase()
  const old = new DatabaseSync(oldPath)
  old.exec('CREATE VIEW projects_next AS SELECT id FROM projects')
  old.close()
  await expect(SqliteEducationRepository.open(resolveConfig({ path: oldPath }))).rejects.toMatchObject({
    code: 'migration-failed',
  })
  const read = new DatabaseSync(oldPath)
  try {
    expect(read.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    expect(read.prepare('SELECT * FROM artifact_versions WHERE id=?').get(saved.versionId)).toEqual(version)
  } finally {
    read.close()
  }
})
