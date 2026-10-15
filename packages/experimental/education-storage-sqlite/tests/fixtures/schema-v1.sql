-- Frozen stage-A physical schema used to verify forward migration.
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
    auth_revision INTEGER NOT NULL CHECK (auth_revision BETWEEN 0 AND 9007199254740991),
    created_at TEXT NOT NULL,
    UNIQUE (organization_id, username_normalized),
    UNIQUE (id, organization_id)
  ) STRICT;
  CREATE TABLE login_sessions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    auth_revision INTEGER NOT NULL CHECK (auth_revision BETWEEN 0 AND 9007199254740991),
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
    revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (artifact_id, organization_id, owner_id) REFERENCES artifacts(id, organization_id, owner_id)
  ) STRICT;
  CREATE TABLE artifact_versions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no BETWEEN 1 AND 9007199254740991),
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
PRAGMA application_id = 1162106177;
PRAGMA user_version = 1;
