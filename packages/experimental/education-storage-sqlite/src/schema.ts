/** Independent education database identity and atomic monotonic schema initialization. */
import { mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'
import type { ResolvedConfig } from './types.ts'
import { migrateStageThree } from './stage-three-schema.ts'

/** Physical layout version; future writers are rejected without modifying their schema. */
export const EDUCATION_SCHEMA_VERSION = 3
const APPLICATION_ID = 0x45445541
const MAX_INTEGER = 9007199254740991
const TABLES = [
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
]

const INITIAL_SCHEMA = `
  CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    username_normalized TEXT NOT NULL,
    credential_hash TEXT NOT NULL,
    credential_salt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    auth_revision INTEGER NOT NULL CHECK (auth_revision BETWEEN 0 AND ${MAX_INTEGER}),
    created_at TEXT NOT NULL,
    UNIQUE (organization_id, username_normalized),
    UNIQUE (id, organization_id)
  ) STRICT;
  CREATE TABLE login_sessions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    auth_revision INTEGER NOT NULL CHECK (auth_revision BETWEEN 0 AND ${MAX_INTEGER}),
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (user_id, organization_id) REFERENCES users(id, organization_id),
    UNIQUE (id, organization_id, user_id)
  ) STRICT;
  CREATE INDEX login_sessions_user ON login_sessions(organization_id, user_id);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    scenario TEXT NOT NULL CHECK (scenario = 'spoken-script'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (owner_id, organization_id) REFERENCES users(id, organization_id),
    UNIQUE (id, organization_id, owner_id)
  ) STRICT;
  CREATE INDEX projects_owner_activity ON projects(organization_id, owner_id, updated_at DESC, id DESC);
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind = 'spoken-script'),
    latest_version_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id, organization_id, owner_id) REFERENCES projects(id, organization_id, owner_id),
    FOREIGN KEY (latest_version_id, id, organization_id, owner_id)
      REFERENCES artifact_versions(id, artifact_id, organization_id, owner_id) DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (id, organization_id, owner_id),
    UNIQUE (id, project_id, organization_id, owner_id),
    UNIQUE (project_id, kind)
  ) STRICT;
  CREATE TABLE drafts (
    artifact_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    body TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND ${MAX_INTEGER}),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (artifact_id, organization_id, owner_id) REFERENCES artifacts(id, organization_id, owner_id)
  ) STRICT;
  CREATE TABLE artifact_versions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no BETWEEN 1 AND ${MAX_INTEGER}),
    body TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    basis_snapshot TEXT NOT NULL CHECK (json_valid(basis_snapshot)),
    saved_by TEXT NOT NULL CHECK (saved_by = owner_id),
    saved_at TEXT NOT NULL,
    FOREIGN KEY (artifact_id, organization_id, owner_id) REFERENCES artifacts(id, organization_id, owner_id),
    FOREIGN KEY (saved_by, organization_id) REFERENCES users(id, organization_id),
    UNIQUE (artifact_id, version_no),
    UNIQUE (id, artifact_id, organization_id, owner_id)
  ) STRICT;
  CREATE TRIGGER artifact_versions_no_update BEFORE UPDATE ON artifact_versions
    BEGIN SELECT RAISE(ABORT, 'immutable artifact version'); END;
  CREATE TRIGGER artifact_versions_no_delete BEFORE DELETE ON artifact_versions
    BEGIN SELECT RAISE(ABORT, 'immutable artifact version'); END;
  CREATE TABLE request_receipts (
    organization_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN (
      'projects.create', 'drafts.sync', 'artifacts.saveVersion', 'drafts.restoreVersion', 'sessions.bind')),
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (owner_id, organization_id) REFERENCES users(id, organization_id),
    PRIMARY KEY (organization_id, owner_id, operation, request_id)
  ) STRICT;
  CREATE TABLE session_bindings (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    harness_session_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'invalid')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (artifact_id, project_id, organization_id, owner_id)
      REFERENCES artifacts(id, project_id, organization_id, owner_id)
  ) STRICT;
  CREATE INDEX session_bindings_owner ON session_bindings(organization_id, owner_id);
  CREATE TABLE audit_records (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result = 'committed'),
    request_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    FOREIGN KEY (actor_id, organization_id) REFERENCES users(id, organization_id)
  ) STRICT;
  CREATE INDEX audit_records_actor_time ON audit_records(organization_id, actor_id, occurred_at);
`

const CREATION_SCHEMA = `
  CREATE TABLE profile_versions (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND ${MAX_INTEGER}),
    content_json TEXT NOT NULL CHECK(json_valid(content_json)), body_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(owner_id, organization_id) REFERENCES users(id, organization_id),
    UNIQUE(organization_id, owner_id, revision), UNIQUE(id, organization_id, owner_id)
  ) STRICT;
  CREATE TRIGGER profile_versions_no_update BEFORE UPDATE ON profile_versions BEGIN SELECT RAISE(ABORT,'immutable profile'); END;
  CREATE TRIGGER profile_versions_no_delete BEFORE DELETE ON profile_versions BEGIN SELECT RAISE(ABORT,'immutable profile'); END;
  CREATE TABLE sources (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_id TEXT NOT NULL, title TEXT NOT NULL, source_url TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND ${MAX_INTEGER}), current_version_id TEXT NOT NULL,
    authorization_revision INTEGER NOT NULL CHECK(authorization_revision BETWEEN 1 AND ${MAX_INTEGER}),
    authorized INTEGER NOT NULL CHECK(authorized IN(0,1)), created_at TEXT NOT NULL,
    FOREIGN KEY(owner_id, organization_id) REFERENCES users(id, organization_id),
    UNIQUE(id, organization_id, owner_id)
  ) STRICT;
  CREATE TABLE source_versions (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, organization_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND ${MAX_INTEGER}), body TEXT NOT NULL, body_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(source_id, organization_id, owner_id) REFERENCES sources(id, organization_id, owner_id),
    UNIQUE(source_id, revision), UNIQUE(id, source_id, organization_id, owner_id)
  ) STRICT;
  CREATE TRIGGER source_versions_no_update BEFORE UPDATE ON source_versions BEGIN SELECT RAISE(ABORT,'immutable source'); END;
  CREATE TRIGGER source_versions_no_delete BEFORE DELETE ON source_versions BEGIN SELECT RAISE(ABORT,'immutable source'); END;
  CREATE TABLE creation_runs (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_id TEXT NOT NULL, login_session_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL, project_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('pending','running','completed','failed','cancelled','interrupted')),
    expected_revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),
    session_id TEXT, candidate TEXT, explanation TEXT, error_code TEXT, draft_revision INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY(artifact_id, project_id, organization_id, owner_id) REFERENCES artifacts(id, project_id, organization_id, owner_id),
    FOREIGN KEY(login_session_id, organization_id, owner_id) REFERENCES login_sessions(id, organization_id, user_id),
    UNIQUE(organization_id, owner_id, request_id)
  ) STRICT;
  CREATE UNIQUE INDEX creation_one_active ON creation_runs(artifact_id) WHERE status IN('pending','running');
  CREATE INDEX creation_owner_artifact ON creation_runs(organization_id,owner_id,artifact_id,created_at DESC);
  CREATE TABLE creation_draft_context (
    artifact_id TEXT PRIMARY KEY REFERENCES drafts(artifact_id), basis_json TEXT NOT NULL CHECK(json_valid(basis_json))
  ) STRICT;
  CREATE TABLE creation_dialogue (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES creation_runs(id), role TEXT NOT NULL CHECK(role IN('user','assistant')),
    body TEXT NOT NULL, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE creation_receipts (
    organization_id TEXT NOT NULL, owner_id TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    FOREIGN KEY(owner_id, organization_id) REFERENCES users(id, organization_id),
    PRIMARY KEY(organization_id,owner_id,operation,request_id)
  ) STRICT;
`

function migrateCreation(db: DatabaseSync): void {
  // SQLite's documented table-rebuild procedure preserves every existing value and inbound FK name.
  for (const name of ['projects', 'artifacts']) {
    const definition = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name)?.sql
    if (typeof definition !== 'string')
      throw new EducationError('schema-mismatch', 'business table definition is missing')
    db.exec(
      definition
        .replace(`CREATE TABLE ${name}`, `CREATE TABLE ${name}_next`)
        .replace("scenario = 'spoken-script'", "scenario IN ('spoken-script','moments')")
        .replace("kind = 'spoken-script'", "kind IN ('spoken-script','moments')"),
    )
    db.exec(`INSERT INTO ${name}_next SELECT * FROM ${name}`)
    db.exec(`DROP TABLE ${name}`)
    db.exec(`ALTER TABLE ${name}_next RENAME TO ${name}`)
  }
  db.exec('CREATE INDEX projects_owner_activity ON projects(organization_id,owner_id,updated_at DESC,id DESC)')
  db.exec(CREATION_SCHEMA)
}

function pragmaInteger(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const value = db.prepare(`PRAGMA ${name}`).get()?.[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new EducationError('schema-mismatch', 'education database metadata is invalid')
  }
  return value
}

function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN IMMEDIATE')
  try {
    const applicationId = pragmaInteger(db, 'application_id')
    const version = pragmaInteger(db, 'user_version')
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    if (
      version > EDUCATION_SCHEMA_VERSION ||
      (applicationId !== 0 && applicationId !== APPLICATION_ID) ||
      (applicationId === 0 && (version !== 0 || tables.length !== 0))
    ) {
      throw new EducationError(
        'schema-mismatch',
        'database identity or schema version is incompatible with education storage',
      )
    }
    if (version === 0) {
      try {
        db.exec(INITIAL_SCHEMA)
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
        db.exec('PRAGMA user_version = 1')
      } catch (error) {
        throw new EducationError(
          'migration-failed',
          'education schema initialization failed; no migration was committed',
          { cause: error },
        )
      }
    } else if (applicationId !== APPLICATION_ID || TABLES.some(name => !tables.some(row => row.name === name))) {
      throw new EducationError('schema-mismatch', 'education schema is incomplete')
    }
    if (version < 2) {
      try {
        migrateCreation(db)
        db.exec('PRAGMA user_version = 2')
      } catch (error) {
        throw new EducationError('migration-failed', 'creation migration failed; existing records are unchanged', {
          cause: error,
        })
      }
    }
    if (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='creation_runs'").get() === undefined) {
      throw new EducationError('schema-mismatch', 'creation schema is incomplete')
    }
    if (version < 3) {
      try {
        migrateStageThree(db)
        db.exec('PRAGMA user_version = 3')
      } catch (error) {
        throw new EducationError('migration-failed', 'phase-C migration failed; existing records are unchanged', {
          cause: error,
        })
      }
    }
    if (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='sync_runs'").get() === undefined) {
      throw new EducationError('schema-mismatch', 'phase-C schema is incomplete')
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new EducationError('schema-mismatch', 'education database contains invalid resource associations')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

/**
 * Initialize and validate an isolated medium before publishing a repository.
 * @param config - fully resolved deployment configuration.
 * @returns ready database; initialization failures close the connection and preserve migration atomicity.
 */
export async function openEducationDatabase(config: ResolvedConfig): Promise<DatabaseSync> {
  if (config.path !== ':memory:') {
    if (!isAbsolute(config.path))
      throw new EducationError('validation-failed', 'education database path must be absolute')
    await mkdir(dirname(config.path), { recursive: true, mode: 0o700 })
    try {
      const file = await open(config.path, 'wx', 0o600)
      await file.close()
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
  }
  const db = new DatabaseSync(config.path)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(`PRAGMA busy_timeout = ${config.busyTimeoutMs}`)
    // Validate identity before changing journal settings on a possibly foreign database.
    migrate(db)
    const journal = db.prepare(`PRAGMA journal_mode = ${config.journalMode}`).get()?.journal_mode
    if (journal !== config.journalMode && !(config.path === ':memory:' && journal === 'memory')) {
      throw new EducationError('storage-unavailable', 'education database could not select the configured journal mode')
    }
    db.exec('PRAGMA synchronous = FULL')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
