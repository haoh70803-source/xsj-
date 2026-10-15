/** Real isolated SQLite media; only clock movement and SQLite abort triggers are synthetic. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ActorContext,
  ArtifactVersionId,
  ProjectCreated,
  RequestId,
  UserId,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, resolveConfig } from '../src/index.ts'
import { SqliteEducationRepository } from '../src/repository.ts'
import { digest, newId } from '../src/codec.ts'

const cache = fileURLToPath(new URL('../../../../.cache/education-storage-tests/', import.meta.url))
let root: string
let path: string
let repository: SqliteEducationRepository
let inspect: DatabaseSync
let a: ActorContext
let b: ActorContext
let otherOrganization: ActorContext

function actor(username: string, organizationId = a?.organizationId): ActorContext {
  const user = repository.provisionUser({
    organizationId,
    usernameNormalized: username,
    credentialHash: '1'.repeat(128),
    credentialSalt: '2'.repeat(32),
  })
  const tokenHash = digest(`synthetic-test-token:${username}`)
  repository.createLoginSession({
    organizationId,
    userId: user.id,
    tokenHash,
    authRevision: 0,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })
  const result = repository.resolveLoginSession(tokenHash)
  if (result === null) throw new Error('test login did not resolve')
  return result
}

function create(who = a, title = '仅用于阶段 A 测试'): ProjectCreated {
  return repository.createProject(who, { title, scenario: 'spoken-script', requestId: newId<RequestId>() })
}

function sync(project: ProjectCreated, body: string, revision: number, who = a) {
  return repository.syncDraft(who, {
    artifactId: project.artifactId,
    body,
    expectedDraftRevision: revision,
    requestId: newId(),
  })
}

function save(project: ProjectCreated, revision: number, pointer: ArtifactVersionId | null, who = a) {
  return repository.saveVersion(who, {
    artifactId: project.artifactId,
    expectedDraftRevision: revision,
    expectedLatestVersionId: pointer,
    requestId: newId(),
  })
}

function counts() {
  return [
    'projects',
    'artifacts',
    'drafts',
    'artifact_versions',
    'request_receipts',
    'audit_records',
    'session_bindings',
  ].map(table => inspect.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count)
}

beforeEach(async () => {
  mkdirSync(cache, { recursive: true })
  root = mkdtempSync(join(cache, 'owned-'))
  path = join(root, 'business.sqlite')
  repository = await SqliteEducationRepository.open(resolveConfig({ path, busyTimeoutMs: 20 }))
  const organizationId = repository.provisionOrganization('阶段 A 合成测试组织')
  a = actor('employee-a', organizationId)
  b = actor('employee-b', organizationId)
  otherOrganization = actor('employee-c', repository.provisionOrganization('其他合成组织'))
  inspect = new DatabaseSync(path)
  inspect.exec('PRAGMA foreign_keys = ON')
})

afterEach(() => {
  vi.useRealTimers()
  inspect?.close()
  repository?.close()
  if (dirname(resolve(root)) !== resolve(cache) || !root.startsWith(join(cache, 'owned-')))
    throw new Error('fixture cleanup outside owned root')
  rmSync(root, { recursive: true, force: true })
})

describe('database initialization and lifecycle', () => {
  it('rolls back binding revocation when its audit commit fails', () => {
    const project = create()
    const sessionId = brandString<SessionId>(randomUUID())
    repository.bindSession(a, {
      projectId: project.projectId,
      artifactId: project.artifactId,
      harnessSessionId: sessionId,
      requestId: newId(),
    })
    inspect.exec(`CREATE TRIGGER reject_binding_audit BEFORE INSERT ON audit_records
      WHEN NEW.action = 'sessions.invalidate' BEGIN SELECT RAISE(ABORT, 'synthetic audit fault'); END`)
    expect(() => {
      repository.invalidateSessionBinding(a, sessionId)
    }).toThrow(expect.objectContaining({ code: 'storage-unavailable' }))
    expect(repository.getSessionBinding(a, sessionId).status).toBe('active')
  })

  it('invalidates only an owned binding, audits the commit and rejects stale binding receipts', () => {
    const project = create()
    const sessionId = brandString<SessionId>(randomUUID())
    const input = {
      projectId: project.projectId,
      artifactId: project.artifactId,
      harnessSessionId: sessionId,
      requestId: newId<RequestId>(),
    }
    repository.bindSession(a, input)
    for (const denied of [b, otherOrganization]) {
      expect(() => {
        repository.invalidateSessionBinding(denied, sessionId)
      }).toThrow(expect.objectContaining({ code: 'resource-unavailable' }))
    }
    repository.invalidateSessionBinding(a, sessionId)
    expect(() => repository.getSessionBinding(a, sessionId)).toThrow(
      expect.objectContaining({ code: 'resource-unavailable' }),
    )
    expect(() => repository.bindSession(a, input)).toThrow(expect.objectContaining({ code: 'resource-unavailable' }))
    expect(inspect.prepare("SELECT action FROM audit_records WHERE action = 'sessions.invalidate'").all()).toHaveLength(
      1,
    )
    expect(
      inspect.prepare('SELECT status FROM session_bindings WHERE harness_session_id = ?').get(sessionId)?.status,
    ).toBe('invalid')
  })
  it('creates the independent schema with foreign keys, WAL and all minimum tables', () => {
    expect(repository.schemaVersion).toBe(3)
    expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(3)
    expect(inspect.prepare('PRAGMA application_id').get()?.application_id).toBe(0x45445541)
    expect(inspect.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
    expect(inspect.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
    expect(
      inspect.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all(),
    ).toHaveLength(32)
    expect(inspect.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('reopens repeatedly without reinitializing durable data', async () => {
    const project = create()
    repository.close()
    repository = await SqliteEducationRepository.open(resolveConfig({ path }))
    expect(repository.openProject(a, project.projectId).draft.revision).toBe(0)
    repository.close()
    repository = await SqliteEducationRepository.open(resolveConfig({ path }))
    expect(repository.listProjects(a, { limit: 10 }).items.map(row => row.id)).toEqual([project.projectId])
  })

  it('rejects a future version and leaves its stamp and journal unchanged', async () => {
    repository.close()
    inspect.exec('PRAGMA user_version = 4')
    await expect(SqliteEducationRepository.open(resolveConfig({ path, journalMode: 'delete' }))).rejects.toMatchObject({
      code: 'schema-mismatch',
    })
    expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(4)
    expect(inspect.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
  })

  it('refuses an existing native KV database instead of appropriating it', async () => {
    const nativePath = join(root, 'native.sqlite')
    const native = new DatabaseSync(nativePath)
    native.exec('CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT')
    native.close()
    await expect(SqliteEducationRepository.open(resolveConfig({ path: nativePath }))).rejects.toMatchObject({
      code: 'schema-mismatch',
    })
    const unchanged = new DatabaseSync(nativePath)
    try {
      expect(unchanged.prepare('PRAGMA user_version').get()?.user_version).toBe(0)
      expect(unchanged.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([{ name: 'units' }])
    } finally {
      unchanged.close()
    }
  })

  it('rolls back schema creation and version stamps when migration fails', async () => {
    const badPath = join(root, 'obstructed.sqlite')
    const bad = new DatabaseSync(badPath)
    bad.exec('PRAGMA application_id = 1162106177; CREATE TABLE organizations (obstruction TEXT) STRICT')
    bad.close()
    await expect(SqliteEducationRepository.open(resolveConfig({ path: badPath }))).rejects.toMatchObject({
      code: 'migration-failed',
    })
    const unchanged = new DatabaseSync(badPath)
    try {
      expect(unchanged.prepare('PRAGMA user_version').get()?.user_version).toBe(0)
      expect(unchanged.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([
        { name: 'organizations' },
      ])
    } finally {
      unchanged.close()
    }
  })

  it('rejects an incomplete current schema', async () => {
    repository.close()
    inspect.exec('DROP TABLE audit_records')
    await expect(SqliteEducationRepository.open(resolveConfig({ path }))).rejects.toMatchObject({
      code: 'schema-mismatch',
    })
  })

  it('rejects relative paths and invalid deployment limits', async () => {
    await expect(SqliteEducationRepository.open(resolveConfig({ path: 'business.sqlite' }))).rejects.toMatchObject({
      code: 'validation-failed',
    })
    for (const fields of [{ busyTimeoutMs: 0 }, { busyTimeoutMs: 60_001 }, { maxBodyBytes: 0 }, { maxPageSize: 0 }]) {
      expect(() => Config({ path, ...fields })).toThrow()
    }
    expect(Config['~standard'].validate({ path, journalMode: 'off' })).toHaveProperty('issues')
  })

  it('closes idempotently and refuses subsequent reads and writes', () => {
    repository.close()
    repository.close()
    expect(() => repository.listProjects(a, { limit: 10 })).toThrow(expect.objectContaining({ code: 'closed' }))
    expect(() => create()).toThrow(expect.objectContaining({ code: 'closed' }))
  })

  it.each(['delete', 'truncate', 'persist'] as const)(
    'opens the configured durable %s journal',
    async (journalMode) => {
      repository.close()
      inspect.close()
      repository = await SqliteEducationRepository.open(resolveConfig({ path, journalMode }))
      inspect = new DatabaseSync(path)
      const project = create()
      // Rollback modes belong to the writer connection; verify their committed file effects.
      const journalPath = `${path}-journal`
      if (journalMode === 'delete') {
        expect(existsSync(journalPath)).toBe(false)
      } else {
        expect(existsSync(journalPath)).toBe(true)
        if (journalMode === 'truncate') expect(statSync(journalPath).size).toBe(0)
        else {
          expect(statSync(journalPath).size).toBeGreaterThan(28)
          expect(readFileSync(journalPath).subarray(0, 28)).toEqual(Buffer.alloc(28))
        }
      }
      expect(inspect.prepare('SELECT id FROM projects').get()?.id).toBe(project.projectId)
    },
  )

  it('supports an explicitly in-memory repository for isolated tests', async () => {
    const memory = await SqliteEducationRepository.open(resolveConfig({ path: ':memory:' }))
    try {
      expect(memory.provisionOrganization('内存测试组织')).toBeDefined()
    } finally {
      memory.close()
    }
  })
})

describe('atomic private drafts and versions', () => {
  it('rejects revision and version number overflow before committing effects', () => {
    const project = create()
    inspect
      .prepare('UPDATE drafts SET revision = ? WHERE artifact_id = ?')
      .run(Number.MAX_SAFE_INTEGER, project.artifactId)
    const before = counts()
    expect(() => sync(project, 'overflow draft', Number.MAX_SAFE_INTEGER)).toThrow(
      expect.objectContaining({ code: 'storage-unavailable' }),
    )
    expect(counts()).toEqual(before)
    expect(repository.readDraft(a, project.artifactId).revision).toBe(Number.MAX_SAFE_INTEGER)
    const versionId = newId<ArtifactVersionId>()
    inspect
      .prepare('INSERT INTO artifact_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        versionId,
        project.artifactId,
        a.organizationId,
        a.userId,
        Number.MAX_SAFE_INTEGER,
        '',
        digest(''),
        JSON.stringify({ source: 'foundation-validation', profileVersionIds: [], materialVersionIds: [] }),
        a.userId,
        new Date().toISOString(),
      )
    inspect.prepare('UPDATE artifacts SET latest_version_id = ? WHERE id = ?').run(versionId, project.artifactId)
    const after = counts()
    expect(() => save(project, Number.MAX_SAFE_INTEGER, versionId)).toThrow(
      expect.objectContaining({ code: 'storage-unavailable' }),
    )
    expect(counts()).toEqual(after)
  })

  it('publishes only new committed writes and contains failed observers', async () => {
    const observed = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const release = repository.onProjectCommit(observed)
    repository.onProjectCommit(() => {
      throw new Error('synthetic-notification-secret')
    })
    repository.onProjectCommit(async () => {
      throw new Error('synthetic-async-notification-secret')
    })
    try {
      const requestId = newId<RequestId>()
      const input = { title: 'commit test', scenario: 'spoken-script' as const, requestId }
      const project = repository.createProject(a, input)
      expect(repository.createProject(a, input)).toEqual(project)
      expect(observed).toHaveBeenCalledTimes(1)
      expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: project.projectId, requestId }))
      expect(() => sync(project, 'stale', 9)).toThrow()
      expect(observed).toHaveBeenCalledTimes(1)
      await Promise.resolve()
      expect(warn).toHaveBeenCalled()
      expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-notification-secret')
      release()
      sync(project, 'new body', 0)
      expect(observed).toHaveBeenCalledTimes(1)
      await Promise.resolve()
    } finally {
      warn.mockRestore()
    }
  })

  it('reopens authoritative version and binding metadata without writing', () => {
    const project = create()
    const version = save(project, 0, null)
    expect(repository.openProject(a, project.projectId)).toMatchObject({
      latestVersion: { id: version.versionId },
      sessionBindings: [],
    })
    const sessionId = brandString<SessionId>(randomUUID())
    repository.bindSession(a, { ...project, harnessSessionId: sessionId, requestId: newId() })
    repository.invalidateSessionBinding(a, sessionId)
    expect(repository.openProject(a, project.projectId).sessionBindings).toMatchObject([
      { harnessSessionId: sessionId, status: 'invalid' },
    ])
    const before = counts()
    repository.openProject(a, project.projectId)
    expect(counts()).toEqual(before)
  })

  it('rejects malformed Unicode and forged cursor values as invalid input', () => {
    const project = create()
    expect(() => sync(project, '\ud800', 0)).toThrow(expect.objectContaining({ code: 'validation-failed' }))
    const cursor = Buffer.from(
      JSON.stringify({
        organizationId: a.organizationId,
        userId: a.userId,
        scope: 'projects',
        at: 'invalid',
        id: project.projectId,
      }),
    ).toString('base64url')
    expect(() => repository.listProjects(a, { limit: 1, cursor })).toThrow(
      expect.objectContaining({ code: 'validation-failed' }),
    )
  })
  it('creates project, artifact, empty draft, receipt and audit as one write', () => {
    const requestId = newId<RequestId>()
    const input = { title: '测试项目', scenario: 'spoken-script' as const, requestId }
    const result = repository.createProject(a, input)
    expect(repository.createProject(a, input)).toEqual(result)
    const opened = repository.openProject(a, result.projectId)
    expect(opened.draft).toMatchObject({ artifactId: result.artifactId, body: '', bodyHash: digest(''), revision: 0 })
    expect(opened.artifact.latestVersionId).toBeNull()
    expect(counts()).toEqual([1, 1, 1, 0, 1, 1, 0])
    expect(() => repository.createProject(a, { ...input, title: '同键不同参数' })).toThrow(
      expect.objectContaining({ code: 'idempotency-conflict' }),
    )
    expect(repository.getResult(a, 'projects.create', requestId)).toEqual(result)
  })

  it('rolls back partial project creation on a draft insertion fault', () => {
    inspect.exec("CREATE TRIGGER fault BEFORE INSERT ON drafts BEGIN SELECT RAISE(ABORT, 'synthetic fault'); END")
    expect(() => create()).toThrow(expect.objectContaining({ code: 'storage-unavailable' }))
    expect(counts()).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('revalidates authorization at commit and rolls back all business effects when it becomes invalid', () => {
    inspect.exec(`CREATE TRIGGER expire_at_commit AFTER INSERT ON request_receipts
      BEGIN UPDATE login_sessions SET expires_at = '1970-01-01T00:00:00.000Z' WHERE user_id = NEW.owner_id; END`)
    expect(() => create()).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
    expect(counts()).toEqual([0, 0, 0, 0, 0, 0, 0])
    inspect.exec('DROP TRIGGER expire_at_commit')
    expect(create().projectId).toBeDefined()
  })

  it('normalizes only CRLF and preserves spaces, Unicode and lone carriage returns', () => {
    const project = create()
    const input = {
      artifactId: project.artifactId,
      body: '  中文😀\r\n尾部 \r',
      expectedDraftRevision: 0,
      requestId: newId<RequestId>(),
    }
    const result = repository.syncDraft(a, input)
    expect(repository.syncDraft(a, { ...input, body: '  中文😀\n尾部 \r' })).toEqual(result)
    expect(repository.openProject(a, project.projectId).draft).toMatchObject({ body: '  中文😀\n尾部 \r', revision: 1 })
    expect(repository.listVersions(a, project.artifactId, { limit: 10 }).items).toEqual([])
  })

  it('keeps original draft receipts when newer edits are committed', () => {
    const project = create()
    const requestId = newId<RequestId>()
    const input = { artifactId: project.artifactId, body: '第一份私有正文', expectedDraftRevision: 0, requestId }
    const first = repository.syncDraft(a, input)
    sync(project, '后来正文', 1)
    expect(repository.syncDraft(a, input)).toEqual(first)
    expect(repository.getResult(a, 'drafts.sync', requestId)).toEqual(first)
    expect(repository.openProject(a, project.projectId).draft.body).toBe('后来正文')
    expect(
      inspect
        .prepare('SELECT result_json FROM request_receipts')
        .all()
        .map(row => row.result_json)
        .join(''),
    ).not.toContain('第一份私有正文')
    expect(JSON.stringify(inspect.prepare('SELECT * FROM audit_records').all())).not.toContain('后来正文')
  })

  it('rejects a stale window without silently overwriting the draft', () => {
    const project = create()
    sync(project, '已确认正文', 0)
    const before = counts()
    expect(() => sync(project, '旧窗口正文', 0)).toThrow(expect.objectContaining({ code: 'draft-conflict' }))
    expect(repository.openProject(a, project.projectId).draft.body).toBe('已确认正文')
    expect(counts()).toEqual(before)
  })

  it('saves immutable V1 and V2, restores V1 as a draft, and then appends V3', () => {
    const project = create()
    sync(project, 'V1 合成正文', 0)
    const v1 = save(project, 1, null)
    sync(project, 'V2 合成正文', 1)
    const v2 = save(project, 2, v1.versionId)
    const beforeRead = repository.openProject(a, project.projectId)
    expect(repository.readVersion(a, project.artifactId, v1.versionId).body).toBe('V1 合成正文')
    expect(repository.openProject(a, project.projectId)).toEqual(beforeRead)
    const restore = {
      artifactId: project.artifactId,
      versionId: v1.versionId,
      expectedDraftRevision: 2,
      requestId: newId<RequestId>(),
    }
    expect(repository.restoreVersion(a, restore).revision).toBe(3)
    expect(repository.restoreVersion(a, restore).revision).toBe(3)
    expect(repository.openProject(a, project.projectId).artifact.latestVersionId).toBe(v2.versionId)
    const v3 = save(project, 3, v2.versionId)
    expect(v3.versionNo).toBe(3)
    expect(repository.readVersion(a, project.artifactId, v3.versionId).body).toBe('V1 合成正文')
    expect(repository.readVersion(a, project.artifactId, v2.versionId).body).toBe('V2 合成正文')
    expect(repository.readVersion(a, project.artifactId, v1.versionId).basisSnapshot).toEqual({
      source: 'foundation-validation',
      profileVersionIds: [],
      materialVersionIds: [],
    })
  })

  it('checks the formal pointer even when saving did not change the draft revision', () => {
    const project = create()
    sync(project, '两窗口共用草稿', 0)
    const first = save(project, 1, null)
    expect(repository.openProject(a, project.projectId).draft.revision).toBe(1)
    expect(() => save(project, 1, null)).toThrow(expect.objectContaining({ code: 'version-conflict' }))
    expect(repository.openProject(a, project.projectId).artifact.latestVersionId).toBe(first.versionId)
    expect(repository.listVersions(a, project.artifactId, { limit: 10 }).items).toHaveLength(1)
    expect(() => save(project, 0, first.versionId)).toThrow(expect.objectContaining({ code: 'draft-conflict' }))
  })

  it('replays a save before checking a pointer changed by a later save', () => {
    const project = create()
    sync(project, 'V1', 0)
    const input = {
      artifactId: project.artifactId,
      expectedDraftRevision: 1,
      expectedLatestVersionId: null,
      requestId: newId<RequestId>(),
    }
    const first = repository.saveVersion(a, input)
    const second = save(project, 1, first.versionId)
    expect(repository.saveVersion(a, input)).toEqual(first)
    expect(repository.openProject(a, project.projectId).artifact.latestVersionId).toBe(second.versionId)
    expect(repository.listVersions(a, project.artifactId, { limit: 10 }).items).toHaveLength(2)
  })

  it.each(['request_receipts', 'audit_records'])(
    'rolls back a new version and pointer if %s insertion fails',
    (table) => {
      const project = create()
      sync(project, '已提交草稿', 0)
      const first = save(project, 1, null)
      const before = counts()
      inspect.exec(`CREATE TRIGGER fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic fault'); END`)
      const requestId = newId<RequestId>()
      const input = {
        artifactId: project.artifactId,
        expectedDraftRevision: 1,
        expectedLatestVersionId: first.versionId,
        requestId,
      }
      expect(() => repository.saveVersion(a, input)).toThrow(expect.objectContaining({ code: 'storage-unavailable' }))
      expect(counts()).toEqual(before)
      expect(repository.openProject(a, project.projectId).artifact.latestVersionId).toBe(first.versionId)
      expect(repository.getResult(a, 'artifacts.saveVersion', requestId)).toBeNull()
      inspect.exec('DROP TRIGGER fault')
      expect(repository.saveVersion(a, input).versionNo).toBe(2)
    },
  )

  it('prevents direct historical updates, deletes and foreign formal pointers', () => {
    const project = create()
    const first = save(project, 0, null)
    const secondProject = create()
    const second = save(secondProject, 0, null)
    expect(() =>
      inspect.prepare('UPDATE artifact_versions SET body = ? WHERE id = ?').run('overwrite', first.versionId),
    ).toThrow()
    expect(() => inspect.prepare('DELETE FROM artifact_versions WHERE id = ?').run(first.versionId)).toThrow()
    expect(() =>
      inspect
        .prepare('UPDATE artifacts SET latest_version_id = ? WHERE id = ?')
        .run(second.versionId, project.artifactId),
    ).toThrow()
    expect(repository.openProject(a, project.projectId).artifact.latestVersionId).toBe(first.versionId)
  })

  it('uses finite lock waiting and permits same-key retry once the competing writer releases', () => {
    const requestId = newId<RequestId>()
    const input = { title: '锁释放后的测试项目', scenario: 'spoken-script' as const, requestId }
    inspect.exec('BEGIN IMMEDIATE')
    try {
      const start = performance.now()
      expect(() => repository.createProject(a, input)).toThrow(expect.objectContaining({ code: 'storage-busy' }))
      expect(performance.now() - start).toBeLessThan(2_000)
    } finally {
      inspect.exec('ROLLBACK')
    }
    expect(counts()).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(repository.createProject(a, input)).toEqual(repository.createProject(a, input))
    expect(counts()).toEqual([1, 1, 1, 0, 1, 1, 0])
  })

  it('validates complete UTF-8 byte limits and binds SQL values as parameters', async () => {
    repository.close()
    repository = await SqliteEducationRepository.open(resolveConfig({ path, maxBodyBytes: 4, maxTitleBytes: 100 }))
    const title = "测试'); DROP TABLE users; --"
    const project = create(a, title)
    expect(repository.openProject(a, project.projectId).project.title).toBe(title)
    expect(sync(project, '😀', 0).revision).toBe(1)
    expect(() => sync(project, '中文', 1)).toThrow(expect.objectContaining({ code: 'validation-failed' }))
    expect(() => sync(project, 'x', -1)).toThrow(expect.objectContaining({ code: 'validation-failed' }))
    expect(inspect.prepare('SELECT COUNT(*) AS count FROM users').get()?.count).toBe(3)
  })

  it('checks the entire UTF-8 title byte limit, including multibyte input', async () => {
    repository.close()
    repository = await SqliteEducationRepository.open(resolveConfig({ path, maxTitleBytes: 6 }))
    expect(repository.openProject(a, create(a, '  中文  ').projectId).project.title).toBe('中文')
    const before = counts()
    expect(() => create(a, '中文字')).toThrow(expect.objectContaining({ code: 'validation-failed' }))
    expect(() => repository.provisionOrganization('组织名')).toThrow(
      expect.objectContaining({ code: 'validation-failed' }),
    )
    expect(counts()).toEqual(before)
  })

  it('restores a closed-file backup into a separate directory with intact hashes and ownership', async () => {
    const project = create()
    sync(project, '可核查的恢复测试正文', 0)
    const version = save(project, 1, null)
    const before = repository.openProject(a, project.projectId)
    inspect.close()
    repository.close()
    const restorePath = join(root, 'restore', 'business.sqlite')
    mkdirSync(dirname(restorePath))
    copyFileSync(path, restorePath)
    repository = await SqliteEducationRepository.open(resolveConfig({ path: restorePath }))
    inspect = new DatabaseSync(restorePath)
    expect(repository.openProject(a, project.projectId)).toEqual(before)
    expect(repository.readVersion(a, project.artifactId, version.versionId).bodyHash).toBe(
      digest('可核查的恢复测试正文'),
    )
    expect(repository.listProjects(b, { limit: 10 }).items).toEqual([])
    expect(inspect.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
    expect(inspect.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(counts()).toEqual([1, 1, 1, 1, 3, 3, 0])
  })
})

describe('durable authorization and query isolation', () => {
  it('rejects other employees and organizations even with real project and version identities', () => {
    const project = create()
    const version = save(project, 0, null)
    for (const who of [b, otherOrganization]) {
      expect(repository.listProjects(who, { limit: 10 }).items).toEqual([])
      expect(() => repository.openProject(who, project.projectId)).toThrow(
        expect.objectContaining({ code: 'resource-unavailable' }),
      )
      expect(() => sync(project, '不能覆盖', 0, who)).toThrow(expect.objectContaining({ code: 'resource-unavailable' }))
      expect(() => save(project, 0, version.versionId, who)).toThrow(
        expect.objectContaining({ code: 'resource-unavailable' }),
      )
      expect(() => repository.readVersion(who, project.artifactId, version.versionId)).toThrow(
        expect.objectContaining({ code: 'resource-unavailable' }),
      )
    }
    expect(() => repository.openProject({ ...a, userId: b.userId }, project.projectId)).toThrow(
      expect.objectContaining({ code: 'unauthenticated' }),
    )
    expect(() =>
      repository.openProject({ ...a, organizationId: otherOrganization.organizationId }, project.projectId),
    ).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  })

  it('enforces composite ownership in foreign keys even for direct database writes', () => {
    const project = create()
    expect(() =>
      inspect
        .prepare('UPDATE projects SET organization_id = ? WHERE id = ?')
        .run(otherOrganization.organizationId, project.projectId),
    ).toThrow()
    expect(() =>
      inspect.prepare('UPDATE artifacts SET owner_id = ? WHERE id = ?').run(b.userId, project.artifactId),
    ).toThrow()
    expect(() =>
      inspect.prepare('UPDATE drafts SET owner_id = ? WHERE artifact_id = ?').run(b.userId, project.artifactId),
    ).toThrow()
    expect(inspect.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('scopes request identities by employee and operation and never reveals others receipts', () => {
    const requestId = newId<RequestId>()
    const input = { title: '各自的测试项目', scenario: 'spoken-script' as const, requestId }
    const first = repository.createProject(a, input)
    expect(repository.getResult(b, 'projects.create', requestId)).toBeNull()
    const second = repository.createProject(b, input)
    expect(second.projectId).not.toBe(first.projectId)
    expect(repository.getResult(a, 'artifacts.saveVersion', requestId)).toBeNull()
    expect(repository.getResult(a, 'projects.create', requestId)).toEqual(first)
  })

  it('rejects a same-owner version from another artifact during restoration', () => {
    const first = create()
    const second = create()
    const version = save(second, 0, null)
    expect(() =>
      repository.restoreVersion(a, {
        artifactId: first.artifactId,
        versionId: version.versionId,
        expectedDraftRevision: 0,
        requestId: newId(),
      }),
    ).toThrow(expect.objectContaining({ code: 'resource-unavailable' }))
    expect(repository.openProject(a, first.projectId).draft.revision).toBe(0)
  })

  it('revokes one login without invalidating another employee or another login', () => {
    const extraToken = digest('another-synthetic-login-for-a')
    const extraId = repository.createLoginSession({
      organizationId: a.organizationId,
      userId: a.userId,
      tokenHash: extraToken,
      authRevision: a.authRevision,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const extra: ActorContext = { ...a, loginSessionId: extraId }
    const project = create()
    repository.revokeLoginSession(a.loginSessionId)
    repository.revokeLoginSession(a.loginSessionId)
    expect(() => repository.openProject(a, project.projectId)).toThrow(
      expect.objectContaining({ code: 'unauthenticated' }),
    )
    expect(repository.openProject(extra, project.projectId).project.id).toBe(project.projectId)
    expect(create(b).projectId).toBeDefined()
    expect(repository.resolveLoginSession(digest('synthetic-test-token:employee-a'))).toBeNull()
  })

  it('rejects expired logins at the exact expiration boundary', () => {
    const expiry = inspect
      .prepare('SELECT expires_at FROM login_sessions WHERE id = ?')
      .get(a.loginSessionId)?.expires_at
    if (typeof expiry !== 'string') throw new Error('missing expiry')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(expiry))
    expect(() => create()).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
    expect(repository.resolveLoginSession(digest('synthetic-test-token:employee-a'))).toBeNull()
  })

  it('invalidates existing logins on disable and does not revive them on re-enable', () => {
    repository.setUserStatus(a.organizationId, a.userId, 'disabled')
    expect(() => create()).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
    expect(create(b).projectId).toBeDefined()
    repository.setUserStatus(a.organizationId, a.userId, 'active')
    expect(() => create()).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
    expect(repository.findUserCredentials(a.organizationId, 'employee-a')?.authRevision).toBe(2)
  })

  it('rechecks organization status rather than trusting a previously resolved actor', () => {
    inspect.prepare("UPDATE organizations SET status = 'disabled' WHERE id = ?").run(a.organizationId)
    expect(() => create()).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
    expect(create(otherOrganization).projectId).toBeDefined()
  })

  it('binds one native session to a single owner and same-project artifact', () => {
    const project = create()
    const others = create(b)
    const harnessSessionId = brandString<SessionId>('synthetic-native-session-a')
    const input = {
      projectId: project.projectId,
      artifactId: project.artifactId,
      harnessSessionId,
      requestId: newId<RequestId>(),
    }
    const bound = repository.bindSession(a, input)
    expect(repository.bindSession(a, input)).toEqual(bound)
    expect(repository.getSessionBinding(a, harnessSessionId)).toEqual(bound.binding)
    expect(() => repository.getSessionBinding(b, harnessSessionId)).toThrow(
      expect.objectContaining({ code: 'resource-unavailable' }),
    )
    expect(() =>
      repository.bindSession(b, {
        ...input,
        projectId: others.projectId,
        artifactId: others.artifactId,
        requestId: newId(),
      }),
    ).toThrow(expect.objectContaining({ code: 'resource-unavailable' }))
    const another = create()
    expect(() =>
      repository.bindSession(a, {
        ...input,
        artifactId: another.artifactId,
        harnessSessionId: brandString<SessionId>('synthetic-wrong-project'),
        requestId: newId(),
      }),
    ).toThrow(expect.objectContaining({ code: 'resource-unavailable' }))
  })

  it('pages private projects and version summaries with owner and query-bound cursors', () => {
    const projects = [create(), create(), create()]
    create(b)
    const first = repository.listProjects(a, { limit: 2 })
    expect(first.items).toHaveLength(2)
    if (first.nextCursor === null) throw new Error('missing project cursor')
    const next = repository.listProjects(a, { limit: 2, cursor: first.nextCursor })
    expect(next.items).toHaveLength(1)
    expect(new Set([...first.items, ...next.items].map(row => row.id)).size).toBe(3)
    expect(next.nextCursor).toBeNull()
    expect(() => repository.listProjects(b, { limit: 2, cursor: first.nextCursor! })).toThrow(
      expect.objectContaining({ code: 'validation-failed' }),
    )
    const project = projects[0]!
    const v1 = save(project, 0, null)
    save(project, 0, v1.versionId)
    const versions = repository.listVersions(a, project.artifactId, { limit: 1 })
    expect(versions.items[0]?.versionNo).toBe(2)
    expect(versions.items[0]).not.toHaveProperty('body')
    if (versions.nextCursor === null) throw new Error('missing version cursor')
    expect(
      repository.listVersions(a, project.artifactId, { limit: 1, cursor: versions.nextCursor }).items[0]?.versionNo,
    ).toBe(1)
    expect(() =>
      repository.listVersions(a, projects[1]!.artifactId, { limit: 1, cursor: versions.nextCursor! }),
    ).toThrow(expect.objectContaining({ code: 'validation-failed' }))
    expect(() => repository.listProjects(a, { limit: 0 })).toThrow(
      expect.objectContaining({ code: 'validation-failed' }),
    )
  })

  it('fails closed on corrupted text and does not create a version from it', () => {
    const project = create()
    inspect
      .prepare('UPDATE drafts SET body = ? WHERE artifact_id = ?')
      .run('corrupt synthetic text', project.artifactId)
    expect(() => repository.openProject(a, project.projectId)).toThrow(
      expect.objectContaining({ code: 'storage-unavailable' }),
    )
    expect(() => save(project, 0, null)).toThrow(expect.objectContaining({ code: 'storage-unavailable' }))
    expect(inspect.prepare('SELECT COUNT(*) AS count FROM artifact_versions').get()?.count).toBe(0)
  })

  it('validates durable receipt JSON and rejects credentials from ordinary DTOs', () => {
    const requestId = newId<RequestId>()
    const result = repository.createProject(a, { title: 'DTO 测试', scenario: 'spoken-script', requestId })
    expect(JSON.stringify(repository.openProject(a, result.projectId))).not.toContain('credential')
    inspect
      .prepare('UPDATE request_receipts SET result_json = ? WHERE request_id = ?')
      .run('{"operation":"unrecognized"}', requestId)
    expect(() => repository.getResult(a, 'projects.create', requestId)).toThrow(
      expect.objectContaining({ code: 'storage-unavailable' }),
    )
    expect(repository.getResult(b, 'projects.create', requestId)).toBeNull()
    expect(repository.findUserCredentials(a.organizationId, 'not-a-user')).toBeNull()
    expect(() => {
      repository.setUserStatus(a.organizationId, newId<UserId>(), 'disabled')
    }).toThrow(expect.objectContaining({ code: 'resource-unavailable' }))
  })
})
