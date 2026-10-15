/** Additive phase-C layout. Existing primary artifacts, receipts and immutable bodies retain their identities. */
import type { DatabaseSync } from 'node:sqlite'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'

const SCHEMA = `
CREATE TABLE source_evidence (
  version_id TEXT PRIMARY KEY REFERENCES source_versions(id), kind TEXT NOT NULL CHECK(kind IN('text','transcript')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), file_hash TEXT, object_hash TEXT
) STRICT;
CREATE TABLE source_dependencies (
  version_id TEXT NOT NULL REFERENCES source_versions(id), kind TEXT NOT NULL CHECK(kind IN('account','source','report')),
  parent_id TEXT NOT NULL, parent_revision INTEGER NOT NULL CHECK(parent_revision>=0),
  PRIMARY KEY(version_id,kind,parent_id)
) STRICT;
CREATE INDEX source_dependencies_parent ON source_dependencies(kind,parent_id);
CREATE TABLE research_attempts (
  run_id TEXT NOT NULL REFERENCES creation_runs(id), attempt INTEGER NOT NULL CHECK(attempt>=1),
  binding_request_id TEXT NOT NULL UNIQUE, session_id TEXT, prompt_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('prepared','running','completed','failed','unknown')),
  validation_json TEXT NOT NULL CHECK(json_valid(validation_json)), created_at TEXT NOT NULL, finished_at TEXT,
  PRIMARY KEY(run_id,attempt)
) STRICT;
CREATE INDEX research_attempts_session ON research_attempts(session_id) WHERE session_id IS NOT NULL;
CREATE TABLE content_accounts (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN('douyin','xiaohongshu')), external_id TEXT NOT NULL, title TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), revision INTEGER NOT NULL CHECK(revision>=1), created_at TEXT NOT NULL,
  FOREIGN KEY(owner_id,organization_id) REFERENCES users(id,organization_id),
  UNIQUE(organization_id,owner_id,platform,external_id), UNIQUE(id,organization_id)
) STRICT;
CREATE TABLE account_grants (
  account_id TEXT NOT NULL, organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
  can_view INTEGER NOT NULL CHECK(can_view IN(0,1)), can_sync INTEGER NOT NULL CHECK(can_sync IN(0,1)),
  can_manage INTEGER NOT NULL CHECK(can_manage IN(0,1)), can_export INTEGER NOT NULL CHECK(can_export IN(0,1)),
  can_use_for_ai INTEGER NOT NULL CHECK(can_use_for_ai IN(0,1)), revision INTEGER NOT NULL CHECK(revision>=1),
  FOREIGN KEY(account_id,organization_id) REFERENCES content_accounts(id,organization_id),
  FOREIGN KEY(user_id,organization_id) REFERENCES users(id,organization_id), PRIMARY KEY(account_id,user_id)
) STRICT;
CREATE INDEX account_grants_user ON account_grants(organization_id,user_id,can_view);
CREATE TABLE account_snapshots (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES content_accounts(id), source TEXT NOT NULL,
  fields_json TEXT NOT NULL CHECK(json_valid(fields_json)), source_data_at TEXT, fetched_at TEXT NOT NULL,
  import_batch_id TEXT, provider_call_id TEXT, capability_json TEXT NOT NULL CHECK(json_valid(capability_json))
) STRICT;
CREATE INDEX account_snapshots_current ON account_snapshots(account_id,source,fetched_at DESC,id DESC);
CREATE TABLE external_contents (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES content_accounts(id), external_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('video','image','article','unknown')), title TEXT NOT NULL, url TEXT NOT NULL,
  published_at TEXT, pinned INTEGER CHECK(pinned IS NULL OR pinned IN(0,1)),
  UNIQUE(account_id,external_id), UNIQUE(id,account_id)
) STRICT;
CREATE TABLE content_snapshots (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, content_id TEXT NOT NULL, source TEXT NOT NULL,
  fields_json TEXT NOT NULL CHECK(json_valid(fields_json)), source_data_at TEXT, fetched_at TEXT NOT NULL,
  import_batch_id TEXT, provider_call_id TEXT, content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  FOREIGN KEY(content_id,account_id) REFERENCES external_contents(id,account_id)
) STRICT;
CREATE INDEX content_snapshots_current ON content_snapshots(account_id,source,content_id,fetched_at DESC,id DESC);
CREATE TABLE import_previews (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES content_accounts(id),
  file_hash TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, baseline_revision INTEGER NOT NULL,
  source TEXT NOT NULL, observed_at TEXT NOT NULL, preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
  status TEXT NOT NULL CHECK(status IN('preview','committed')), created_at TEXT NOT NULL,
  FOREIGN KEY(owner_id,organization_id) REFERENCES users(id,organization_id), UNIQUE(organization_id,owner_id,request_id)
) STRICT;
CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES content_accounts(id), owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL, request_hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
  principal_json TEXT NOT NULL CHECK(json_valid(principal_json)), parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
  status TEXT NOT NULL CHECK(status IN('pending','running','completed','partial','failed','cancelled','interrupted','unknown')),
  phase TEXT NOT NULL, checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json)), job_id TEXT, session_id TEXT,
  error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(owner_id,organization_id) REFERENCES users(id,organization_id), UNIQUE(organization_id,owner_id,request_id)
) STRICT;
CREATE UNIQUE INDEX sync_one_active ON sync_runs(account_id,fingerprint) WHERE status IN('pending','running','unknown');
CREATE TABLE sync_requests (
  organization_id TEXT NOT NULL, owner_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES sync_runs(id), FOREIGN KEY(owner_id,organization_id) REFERENCES users(id,organization_id),
  PRIMARY KEY(organization_id,owner_id,request_id)
) STRICT;
CREATE TABLE quota_pools (
  id TEXT PRIMARY KEY, configuration_hash TEXT NOT NULL, limits_json TEXT NOT NULL CHECK(json_valid(limits_json)), created_at TEXT NOT NULL,
  paused_reason TEXT, resume_epoch TEXT NOT NULL
) STRICT;
CREATE TABLE provider_calls (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES sync_runs(id), pool_id TEXT NOT NULL REFERENCES quota_pools(id),
  request_hash TEXT NOT NULL, operation TEXT NOT NULL, reserved_cost_micros INTEGER, actual_cost_micros INTEGER,
  status TEXT NOT NULL CHECK(status IN('reserved','sent','confirmed','unknown','cancelled')),
  provider_request_id TEXT, response_hash TEXT, error_code TEXT, reserved_at TEXT NOT NULL, dispatched_at TEXT, finished_at TEXT,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), UNIQUE(run_id,request_hash)
) STRICT;
CREATE INDEX provider_calls_pool ON provider_calls(pool_id,status,reserved_at);
CREATE TABLE analytics_schedules (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES content_accounts(id), owner_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL, account_revision INTEGER NOT NULL, user_auth_revision INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
  hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23), minute INTEGER NOT NULL CHECK(minute BETWEEN 0 AND 59), time_zone TEXT NOT NULL,
  next_at TEXT NOT NULL, last_local_date TEXT, revision INTEGER NOT NULL CHECK(revision>=1),
  FOREIGN KEY(owner_id,organization_id) REFERENCES users(id,organization_id), UNIQUE(account_id)
) STRICT;
CREATE TABLE stage_receipts (
  organization_id TEXT NOT NULL, owner_id TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  FOREIGN KEY(owner_id,organization_id) REFERENCES users(id,organization_id), PRIMARY KEY(organization_id,owner_id,operation,request_id)
) STRICT;
CREATE TRIGGER source_evidence_no_update BEFORE UPDATE ON source_evidence BEGIN SELECT RAISE(ABORT,'immutable source evidence'); END;
CREATE TRIGGER source_evidence_no_delete BEFORE DELETE ON source_evidence BEGIN SELECT RAISE(ABORT,'immutable source evidence'); END;
CREATE TRIGGER source_dependencies_no_update BEFORE UPDATE ON source_dependencies BEGIN SELECT RAISE(ABORT,'immutable source dependency'); END;
CREATE TRIGGER source_dependencies_no_delete BEFORE DELETE ON source_dependencies BEGIN SELECT RAISE(ABORT,'immutable source dependency'); END;
CREATE TRIGGER account_snapshots_no_update BEFORE UPDATE ON account_snapshots BEGIN SELECT RAISE(ABORT,'immutable account observation'); END;
CREATE TRIGGER account_snapshots_no_delete BEFORE DELETE ON account_snapshots BEGIN SELECT RAISE(ABORT,'immutable account observation'); END;
CREATE TRIGGER content_snapshots_no_update BEFORE UPDATE ON content_snapshots BEGIN SELECT RAISE(ABORT,'immutable content observation'); END;
CREATE TRIGGER content_snapshots_no_delete BEFORE DELETE ON content_snapshots BEGIN SELECT RAISE(ABORT,'immutable content observation'); END;
`

/**
 * Upgrade inside the caller's migration transaction with foreign-key checks restored before commit.
 * @param db - exclusively owned migration connection with foreign_keys disabled outside the transaction.
 */
export function migrateStageThree(db: DatabaseSync): void {
  const artifact = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='artifacts'").get()?.sql
  const receipts = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='request_receipts'").get()?.sql
  if (typeof artifact !== 'string' || typeof receipts !== 'string')
    throw new EducationError('schema-mismatch', 'phase-B tables are incomplete')
  const nextArtifact = artifact
    .replace(/CREATE TABLE (?:"artifacts"|artifacts)/, 'CREATE TABLE artifacts_next')
    .replace(/CHECK\s*\(kind IN\s*\(([^)]+)\)\)/, "CHECK(kind IN($1,'text-analysis'))")
  if (!nextArtifact.includes("'text-analysis'"))
    throw new EducationError('schema-mismatch', 'artifact kinds do not match the phase-B layout')
  db.exec(nextArtifact)
  db.exec('INSERT INTO artifacts_next SELECT * FROM artifacts')
  db.exec('DROP TABLE artifacts')
  db.exec('ALTER TABLE artifacts_next RENAME TO artifacts')
  db.exec(
    receipts
      .replace(/CREATE TABLE (?:"request_receipts"|request_receipts)/, 'CREATE TABLE request_receipts_next')
      .replace("'sessions.bind'", "'sessions.bind','artifacts.create'"),
  )
  db.exec('INSERT INTO request_receipts_next SELECT * FROM request_receipts')
  db.exec('DROP TABLE request_receipts')
  db.exec('ALTER TABLE request_receipts_next RENAME TO request_receipts')
  db.exec(
    'ALTER TABLE projects ADD COLUMN primary_artifact_id TEXT REFERENCES artifacts(id) DEFERRABLE INITIALLY DEFERRED',
  )
  db.exec(
    'UPDATE projects SET primary_artifact_id=(SELECT id FROM artifacts WHERE project_id=projects.id AND organization_id=projects.organization_id AND owner_id=projects.owner_id AND kind=projects.scenario)',
  )
  if (db.prepare('SELECT id FROM projects WHERE primary_artifact_id IS NULL').get() !== undefined)
    throw new EducationError('schema-mismatch', 'project has no unique primary artifact')
  db.exec(`CREATE TRIGGER projects_primary_guard BEFORE UPDATE OF primary_artifact_id ON projects WHEN NEW.primary_artifact_id IS NOT NULL BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM artifacts WHERE id=NEW.primary_artifact_id AND project_id=NEW.id AND owner_id=NEW.owner_id AND organization_id=NEW.organization_id AND kind=NEW.scenario)
      THEN RAISE(ABORT,'invalid primary artifact') END; END;`)
  db.exec(SCHEMA)
}
