/** Frozen phase-B layout tests preserve old bytes and receipts rather than regenerating an expected schema. */
import type { RequestId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { stageFixture } from './stage-fixture.ts'
import { SqliteEducationRepository } from '../src/repository.ts'
import { resolveConfig } from '../src/index.ts'
import { newId, text } from '../src/codec.ts'

let f: Awaited<ReturnType<typeof stageFixture>>
beforeEach(async () => {
  f = await stageFixture()
})
afterEach(() => {
  f?.close()
})

function oldDatabase() {
  const project = f.repository.createProject(f.a, { title: '旧版主稿', scenario: 'moments', requestId: newId<RequestId>() })
  const draft = f.repository.syncDraft(f.a, {
    artifactId: project.artifactId,
    expectedDraftRevision: 0,
    requestId: newId<RequestId>(),
    body: '旧正文😀\n不重写历史',
  })
  const requestId = newId<RequestId>()
  const saved = f.repository.saveVersion(f.a, {
    artifactId: project.artifactId,
    expectedDraftRevision: draft.revision,
    expectedLatestVersionId: null,
    requestId,
  })
  const path = join(f.root, 'phase-b.sqlite'),
    db = new DatabaseSync(path)
  db.exec(readFileSync(new URL('./fixtures/schema-v2.sql', import.meta.url), 'utf8'))
  try {
    // The retained schema contains circular artifact/version references; validate the complete copy at commit.
    db.exec('BEGIN; PRAGMA defer_foreign_keys=ON')
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    for (const entry of tables) {
      const table = text(entry, 'name'),
        columns = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map(column => text(column, 'name'))
      for (const row of f.inspect.prepare(`SELECT * FROM ${table}`).all()) {
        db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(
          ...columns.map((column) => {
            const value = row[column]
            if (value === undefined) throw new Error('frozen schema field is absent')
            return value
          }),
        )
      }
    }
    db.exec('COMMIT')
    return {
      path,
      project,
      saved,
      requestId,
      oldVersion: db.prepare('SELECT * FROM artifact_versions WHERE id=?').get(saved.versionId),
      oldReceipt: db.prepare('SELECT result_json FROM request_receipts WHERE request_id=?').get(requestId)?.result_json,
    }
  } finally {
    db.close()
  }
}

it('preserves v2 formal bytes and original receipts and selects the stable primary when another artifact exists', async () => {
  const old = oldDatabase(),
    migrated = await SqliteEducationRepository.open(resolveConfig({ path: old.path })),
    inspect = new DatabaseSync(old.path)
  try {
    expect(migrated.schemaVersion).toBe(3)
    expect(inspect.prepare('SELECT * FROM artifact_versions WHERE id=?').get(old.saved.versionId)).toEqual(
      old.oldVersion,
    )
    expect(
      inspect.prepare('SELECT result_json FROM request_receipts WHERE request_id=?').get(old.requestId)?.result_json,
    ).toBe(old.oldReceipt)
    expect(migrated.openProject(f.a, old.project.projectId).project.primaryArtifactId).toBe(old.project.artifactId)
    const analysis = newId(),
      at = new Date().toISOString()
    inspect
      .prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,NULL,?,?)')
      .run(analysis, f.organizationId, f.a.userId, old.project.projectId, 'text-analysis', at, at)
    expect(migrated.openProject(f.a, old.project.projectId).artifact.id).toBe(old.project.artifactId)
    expect(() =>
      inspect.prepare('UPDATE projects SET primary_artifact_id=? WHERE id=?').run(analysis, old.project.projectId),
    ).toThrow('invalid primary artifact')
    expect(inspect.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    inspect.close()
    migrated.close()
  }
})

it('rolls back a failed v2 upgrade with its old layout, schema stamp and immutable rows intact', async () => {
  const old = oldDatabase(),
    broken = new DatabaseSync(old.path)
  broken.exec('CREATE TABLE sync_runs(deliberate_migration_conflict TEXT)')
  broken.close()
  await expect(SqliteEducationRepository.open(resolveConfig({ path: old.path }))).rejects.toMatchObject({
    code: 'migration-failed',
  })
  const read = new DatabaseSync(old.path)
  try {
    expect(read.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
    expect(
      read
        .prepare('PRAGMA table_info(projects)')
        .all()
        .some(column => column.name === 'primary_artifact_id'),
    ).toBe(false)
    expect(read.prepare("SELECT name FROM sqlite_schema WHERE name='source_evidence'").get()).toBeUndefined()
    expect(read.prepare('SELECT * FROM artifact_versions WHERE id=?').get(old.saved.versionId)).toEqual(old.oldVersion)
  } finally {
    read.close()
  }
})
