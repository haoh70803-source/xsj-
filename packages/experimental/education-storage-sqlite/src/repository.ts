/** Short SQLite transactions for employee-owned education resources, versions and receipts. */
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EducationError, decodeResearchDocument } from '@deepseek-ai/dsh-experimental-education-platform'
import { decodeRunSnapshot } from './creation-codec.ts'
import type { BasisSnapshot } from '@deepseek-ai/dsh-experimental-education-platform/types'
import type { ImportLegacyResearchInput } from '@deepseek-ai/dsh-experimental-education-platform/types'
import type {
  CreateLoginSessionInput,
  EducationRepository,
  ProvisionUserInput,
  UserCredentialRecord,
} from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  ActorContext,
  ArtifactDTO,
  DraftDTO,
  EducationProjectCommit,
  EducationResourceLimits,
  ArtifactId,
  ArtifactVersionDTO,
  ArtifactVersionId,
  ArtifactVersionSummary,
  BindSessionInput,
  CreateProjectInput,
  DraftCommitted,
  LoginSessionId,
  OrganizationId,
  Page,
  PageInput,
  ProjectCreated,
  ProjectDTO,
  ProjectId,
  ProjectState,
  RequestId,
  RestoreVersionInput,
  SaveVersionInput,
  SessionBindingDTO,
  SessionBound,
  SyncDraftInput,
  UserDTO,
  UserId,
  VersionSaved,
  WriteOperation,
  WriteResult,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import {
  artifactDTO,
  bindingDTO,
  digest,
  draftDTO,
  hash,
  id,
  integer,
  newId,
  parseObject,
  projectDTO,
  receiptResult,
  text,
  timestamp,
  versionDTO,
  versionSummary,
} from './codec.ts'
import type { Row } from './codec.ts'
import { EDUCATION_SCHEMA_VERSION, openEducationDatabase } from './schema.ts'
import type { ResolvedConfig } from './types.ts'
import { SqliteCreationRepository } from './creation.ts'
import { SqliteKnowledgeRepository } from './knowledge.ts'
import { SqliteResearchRepository } from './research.ts'
import { SqliteAnalyticsRepository } from './analytics.ts'
import { SqliteSyncRepository } from './sync.ts'
import { SqliteTransferRepository } from './transfers.ts'
import { decodeBasis } from './creation-codec.ts'

function failure(error: unknown): EducationError {
  if (error instanceof EducationError) return error
  const busy =
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    [5, 6].includes(error.errcode & 0xff)
  return new EducationError(
    busy ? 'storage-busy' : 'storage-unavailable',
    busy ? 'education storage is busy; retry with the original request identity' : 'education storage operation failed',
    { cause: error },
  )
}

function unavailable(): EducationError {
  return new EducationError('resource-unavailable', 'education resource is unavailable')
}

function expectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EducationError('validation-failed', 'draft revision must be a nonnegative safe integer')
  }
}

/** One process-owned repository; synchronous methods never await external work while a transaction holds locks. */
export class SqliteEducationRepository implements EducationRepository {
  readonly schemaVersion = EDUCATION_SCHEMA_VERSION
  private closed = false
  private readonly observers = new Set<(commit: EducationProjectCommit) => unknown>()
  readonly limits: EducationResourceLimits
  readonly creation: SqliteCreationRepository
  readonly knowledge: SqliteKnowledgeRepository
  readonly research: SqliteResearchRepository
  readonly analytics: SqliteAnalyticsRepository
  readonly sync: SqliteSyncRepository
  readonly transfers: SqliteTransferRepository

  private constructor(
    private readonly db: DatabaseSync,
    private readonly config: ResolvedConfig,
  ) {
    this.limits = Object.freeze({
      maxBodyBytes: config.maxBodyBytes,
      maxTitleBytes: config.maxTitleBytes,
      maxPageSize: config.maxPageSize,
    })
    this.analytics = new SqliteAnalyticsRepository(db, {
      transaction: (actor, work, write) => this.authorized(actor, work, write),
      maxBodyBytes: config.maxBodyBytes,
      maxTitleBytes: config.maxTitleBytes,
      maxPageSize: config.maxPageSize,
      maxImportRows: config.maxImportRows,
      maxAnalyticsItems: config.maxAnalyticsItems,
      maxExternalUrlBytes: config.maxExternalUrlBytes,
    })
    this.sync = new SqliteSyncRepository(
      db,
      {
        transaction: (actor, work, write) => this.authorized(actor, work, write),
        system: work => this.transaction(work),
        assertActor: (actor) =>{  this.assertActor(actor) },
        maxPageSize: config.maxPageSize,
      },
      this.analytics,
    )
    this.knowledge = new SqliteKnowledgeRepository(db, {
      transaction: (actor, work) => this.authorized(actor, work),
      maxPageSize: config.maxPageSize,
      maxQueryBytes: config.maxTitleBytes,
    })
    this.creation = new SqliteCreationRepository(db, {
      transaction: (actor, work, write) => this.authorized(actor, work, write),
      artifact: (actor, artifactId) => this.ownedArtifact(actor, artifactId),
      maxBodyBytes: config.maxBodyBytes,
      maxTitleBytes: config.maxTitleBytes,
      maxPageSize: config.maxPageSize,
      system: work => this.transaction(work),
      sourcePermitted: (actor, versionId, permission = 'use_for_ai') =>
        this.knowledge.sourcePermitted(actor, versionId, permission),
      validateBody: (actor, artifactId, body, basis) =>{  this.validateAnalysisBody(actor, artifactId, body, basis) },
    })
    this.research = new SqliteResearchRepository(
      db,
      {
        writeLegacy: (actor, input) => this.importLegacy(actor, input),
        transaction: (actor, work, write) => this.authorized(actor, work, write),
        system: work => this.transaction(work),
        artifact: (actor, artifactId) => this.ownedArtifact(actor, artifactId),
        project: (actor, projectId) => this.ownedProject(actor, projectId),
        draft: (actor, artifactId) => this.ownedDraft(actor, artifactId),
        maxBodyBytes: config.maxBodyBytes,
        validateBody: (actor, artifactId, body, basis) =>{
          this.validateStoredAnalysisBody(actor, artifactId, body, basis) },
        createArtifact: (actor, input, perform) => {
          const result = this.write(actor, 'artifacts.create', input.requestId, { projectId: input.projectId }, perform)
          if (result.operation !== 'artifacts.create') throw failure(undefined)
          return result
        },
      },
      this.creation,
      this.knowledge,
    )
    this.transfers = new SqliteTransferRepository(
      db,
      {
        validateBody: (actor, artifactId, body, basis) => this.validateStoredAnalysisBody(actor, artifactId, body, basis),
        transaction: (actor, work) => this.authorized(actor, work),
        project: (actor, projectId) => this.ownedProject(actor, projectId),
        artifact: (actor, artifactId) => this.ownedArtifact(actor, artifactId),
        version: (actor, artifactId, versionId) => this.ownedVersion(actor, artifactId, versionId),
      },
      this.creation,
      this.analytics,
    )
  }

  onProjectCommit(listener: (commit: EducationProjectCommit) => unknown): () => void {
    if (this.closed) throw new EducationError('closed', 'education repository is closed')
    this.observers.add(listener)
    return () => {
      this.observers.delete(listener)
    }
  }

  readArtifact(actor: ActorContext, artifactId: ArtifactId): ArtifactDTO {
    return this.authorized(actor, () => artifactDTO(this.ownedArtifact(actor, artifactId)))
  }

  readDraft(actor: ActorContext, artifactId: ArtifactId): DraftDTO {
    return this.authorized(actor, () => this.draftView(actor, artifactId))
  }
  requireArtifactExport(actor: ActorContext, artifactId: ArtifactId, versionId: ArtifactVersionId | null): void {
    this.authorized(actor, () => {
      this.ownedArtifact(actor, artifactId)
      const basis =
        versionId === null
          ? this.creation.basis(actor, artifactId)
          : versionDTO(this.ownedVersion(actor, artifactId, versionId)).basisSnapshot
      if (!this.creation.permitted(actor, basis, 'view') || !this.creation.permitted(actor, basis, 'export'))
        throw new EducationError('forbidden', 'current origin grants do not permit export')
    })
  }

  /**
   * Open the independent medium and publish only a ready repository.
   * @param config - fully resolved storage configuration.
   * @returns repository only after successful schema initialization.
   */
  static async open(config: ResolvedConfig): Promise<SqliteEducationRepository> {
    try {
      return new SqliteEducationRepository(await openEducationDatabase(config), config)
    } catch (error) {
      throw failure(error)
    }
  }

  requireActiveOrganization(organizationId: OrganizationId): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT id FROM organizations WHERE id = ? AND status = 'active'").get(organizationId)
      if (row === undefined)
        throw new EducationError('identity-unavailable', 'configured identity organization is unavailable')
    }, false)
  }

  readSelf(actor: ActorContext): UserDTO {
    return this.authorized(actor, () => {
      const row = this.db
        .prepare('SELECT id, organization_id, username_normalized FROM users WHERE id = ? AND organization_id = ?')
        .get(actor.userId, actor.organizationId)
      if (row === undefined) throw unavailable()
      return { id: id(row.id), organizationId: id(row.organization_id), username: text(row, 'username_normalized') }
    })
  }

  provisionOrganization(name: string): OrganizationId {
    if (name.trim() === '' || Buffer.byteLength(name.trim(), 'utf8') > this.config.maxTitleBytes) {
      throw new EducationError('validation-failed', 'organization name is empty or too long')
    }
    return this.transaction(() => {
      const organizationId = newId<OrganizationId>()
      this.db
        .prepare('INSERT INTO organizations VALUES (?, ?, ?, ?)')
        .run(organizationId, name.trim(), 'active', this.now())
      return organizationId
    })
  }

  provisionUser(input: ProvisionUserInput): UserDTO {
    if (
      !/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(input.usernameNormalized) ||
      !/^[a-f0-9]{128}$/.test(input.credentialHash) ||
      !/^[a-f0-9]{32}$/.test(input.credentialSalt)
    ) {
      throw new EducationError(
        'validation-failed',
        'controlled account requires normalized username and scrypt credential fields',
      )
    }
    return this.transaction(() => {
      const user: UserDTO = {
        id: newId<UserId>(),
        organizationId: input.organizationId,
        username: input.usernameNormalized,
      }
      this.db
        .prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, 'active', 0, ?)")
        .run(user.id, user.organizationId, user.username, input.credentialHash, input.credentialSalt, this.now())
      return user
    })
  }

  findUserCredentials(organizationId: OrganizationId, username: string): UserCredentialRecord | null {
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM users WHERE organization_id = ? AND username_normalized = ?')
        .get(organizationId, username)
      if (row === undefined) return null
      if (row.status !== 'active' && row.status !== 'disabled') throw failure(undefined)
      const credentialHash = text(row, 'credential_hash')
      const credentialSalt = text(row, 'credential_salt')
      if (!/^[a-f0-9]{128}$/.test(credentialHash) || !/^[a-f0-9]{32}$/.test(credentialSalt)) throw failure(undefined)
      return {
        user: { id: id(row.id), organizationId: id(row.organization_id), username: text(row, 'username_normalized') },
        credentialHash,
        credentialSalt,
        status: row.status,
        authRevision: integer(row.auth_revision),
      }
    }, false)
  }

  createLoginSession(input: CreateLoginSessionInput): LoginSessionId {
    hash(input.tokenHash)
    timestamp(input.expiresAt)
    expectedRevision(input.authRevision)
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT u.id FROM users u JOIN organizations o ON o.id = u.organization_id
        WHERE u.id = ? AND u.organization_id = ? AND u.status = 'active' AND o.status = 'active' AND u.auth_revision = ?`,
        )
        .get(input.userId, input.organizationId, input.authRevision)
      if (row === undefined || input.expiresAt <= this.now())
        throw new EducationError('unauthenticated', 'employee authorization is no longer valid')
      const loginSessionId = newId<LoginSessionId>()
      this.db
        .prepare('INSERT INTO login_sessions VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(loginSessionId, input.organizationId, input.userId, input.tokenHash, input.authRevision, input.expiresAt)
      return loginSessionId
    })
  }

  resolveLoginSession(tokenHash: string): ActorContext | null {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT l.id, l.organization_id, l.user_id, l.auth_revision
        FROM login_sessions l JOIN users u ON u.id = l.user_id AND u.organization_id = l.organization_id
        JOIN organizations o ON o.id = l.organization_id
        WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > ?
        AND l.auth_revision = u.auth_revision AND u.status = 'active' AND o.status = 'active'`,
        )
        .get(tokenHash, this.now())
      return row === undefined
        ? null
        : {
          loginSessionId: id(row.id),
          organizationId: id(row.organization_id),
          userId: id(row.user_id),
          authRevision: integer(row.auth_revision),
        }
    }, false)
  }

  revokeLoginSession(loginSessionId: LoginSessionId): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE login_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
        .run(this.now(), loginSessionId)
    })
  }

  setUserStatus(organizationId: OrganizationId, userId: UserId, status: 'active' | 'disabled'): void {
    this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE users SET status = ?, auth_revision = auth_revision + 1
        WHERE id = ? AND organization_id = ?`,
        )
        .run(status, userId, organizationId)
      if (result.changes !== 1) throw unavailable()
    })
  }

  createProject(actor: ActorContext, input: CreateProjectInput): ProjectCreated {
    const title = input.title.trim()
    if (!title.isWellFormed() || title === '' || Buffer.byteLength(title, 'utf8') > this.config.maxTitleBytes) {
      throw new EducationError('validation-failed', 'project title or scenario is invalid')
    }
    const result = this.write(actor, 'projects.create', input.requestId, { title, scenario: input.scenario }, () => {
      const projectId = newId<ProjectId>()
      const artifactId = newId<ArtifactId>()
      const now = this.now()
      this.db
        .prepare(
          'INSERT INTO projects(id,organization_id,owner_id,title,scenario,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(projectId, actor.organizationId, actor.userId, title, input.scenario, now, now)
      this.db
        .prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
        .run(artifactId, actor.organizationId, actor.userId, projectId, input.scenario, now, now)
      this.db.prepare('UPDATE projects SET primary_artifact_id=? WHERE id=?').run(artifactId, projectId)
      this.db
        .prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, 0, ?)')
        .run(artifactId, actor.organizationId, actor.userId, '', digest(''), now)
      return { operation: 'projects.create', projectId, artifactId, draftRevision: 0 }
    })
    if (result.operation !== 'projects.create') throw failure(undefined)
    return result
  }

  listProjects(actor: ActorContext, input: PageInput): Page<ProjectDTO> {
    this.pageSize(input.limit)
    return this.authorized(actor, () => {
      const cursor = this.cursor(actor, input.cursor, 'projects')
      const at = cursor === null ? null : timestamp(cursor.at)
      const afterId = cursor === null ? null : id<ProjectId>(cursor.id)
      const rows = this.db
        .prepare(
          `SELECT * FROM projects WHERE organization_id = ? AND owner_id = ?
        AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
        ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(actor.organizationId, actor.userId, at, at, at, afterId, input.limit + 1)
      const items = rows.slice(0, input.limit).map(projectDTO)
      const last = items.at(-1)
      return {
        items,
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? this.encodeCursor(actor, { scope: 'projects', at: last.updatedAt, id: last.id })
            : null,
      }
    })
  }

  openProject(actor: ActorContext, projectId: ProjectId): ProjectState {
    return this.authorized(actor, () => {
      const row = this.ownedProject(actor, projectId)
      const artifact = this.db
        .prepare('SELECT * FROM artifacts WHERE id=? AND project_id = ? AND organization_id = ? AND owner_id = ?')
        .get(id(row.primary_artifact_id), projectId, actor.organizationId, actor.userId)
      if (artifact === undefined) throw failure(undefined)
      const metadata = artifactDTO(artifact)
      const bindings = this.db
        .prepare(
          `SELECT * FROM session_bindings WHERE project_id = ? AND artifact_id = ?
        AND organization_id = ? AND owner_id = ? ORDER BY created_at, id`,
        )
        .all(projectId, metadata.id, actor.organizationId, actor.userId)
        .map(bindingDTO)
      return {
        project: projectDTO(row),
        artifact: metadata,
        draft: this.draftView(actor, metadata.id),
        latestVersion:
          metadata.latestVersionId === null
            ? null
            : versionSummary(this.ownedVersion(actor, metadata.id, metadata.latestVersionId)),
        sessionBindings: bindings,
      }
    })
  }

  syncDraft(actor: ActorContext, input: SyncDraftInput): DraftCommitted {
    expectedRevision(input.expectedDraftRevision)
    const body = input.body.replaceAll('\r\n', '\n')
    if (!body.isWellFormed() || Buffer.byteLength(body, 'utf8') > this.config.maxBodyBytes) {
      throw new EducationError('validation-failed', 'draft text exceeds the configured UTF-8 byte limit')
    }
    const result = this.write(
      actor,
      'drafts.sync',
      input.requestId,
      { artifactId: input.artifactId, body, expectedDraftRevision: input.expectedDraftRevision },
      () => {
        this.creation.assertWritable(actor, input.artifactId)
        if (this.ownedArtifact(actor, input.artifactId).kind === 'text-analysis')
          throw new EducationError('forbidden', 'structured analysis cannot be written through the plain-text editor')
        const draft = draftDTO(this.ownedDraft(actor, input.artifactId))
        this.checkDraftRevision(draft.revision, input.expectedDraftRevision)
        return this.updateDraft(actor, input.artifactId, body, draft.revision, 'drafts.sync')
      },
    )
    if (result.operation !== 'drafts.sync') throw failure(undefined)
    return result
  }

  private importLegacy(actor: ActorContext, input: ImportLegacyResearchInput): DraftCommitted {
    expectedRevision(input.expectedDraftRevision)
    const body = JSON.stringify({
      kind: 'legacy-text',
      version: 1,
      text: input.text.replaceAll('\r\n', '\n'),
      originId: input.originId,
    })
    if (
      !z.literal(true).safeParse(input.confirmed).success ||
      !input.text.trim() ||
      !body.isWellFormed() ||
      Buffer.byteLength(body) > this.config.maxBodyBytes ||
      Buffer.byteLength(input.originId) > this.config.maxTitleBytes
    )
      throw new EducationError('validation-failed', 'confirmed legacy text exceeds its configured bounds')
    decodeResearchDocument(body)
    const result = this.write(actor, 'drafts.sync', input.requestId, { ...input, kind: 'legacy-text' }, () => {
      this.creation.assertWritable(actor, input.artifactId)
      const artifact = artifactDTO(this.ownedArtifact(actor, input.artifactId)),
        draft = draftDTO(this.ownedDraft(actor, input.artifactId))
      if (artifact.kind !== 'text-analysis') throw unavailable()
      this.checkDraftRevision(draft.revision, input.expectedDraftRevision)
      if (artifact.latestVersionId !== input.expectedLatestVersionId)
        throw new EducationError('version-conflict', 'formal report changed before legacy migration')
      this.creation.setBasis(input.artifactId, {
        source: 'foundation-validation',
        profileVersionIds: [],
        materialVersionIds: [],
      })
      return this.updateDraft(actor, input.artifactId, body, draft.revision, 'drafts.sync')
    })
    if (result.operation !== 'drafts.sync') throw failure(undefined)
    return result
  }

  saveVersion(actor: ActorContext, input: SaveVersionInput): VersionSaved {
    expectedRevision(input.expectedDraftRevision)
    const result = this.write(
      actor,
      'artifacts.saveVersion',
      input.requestId,
      {
        artifactId: input.artifactId,
        expectedDraftRevision: input.expectedDraftRevision,
        expectedLatestVersionId: input.expectedLatestVersionId,
      },
      () => {
        this.creation.assertWritable(actor, input.artifactId)
        const artifact = artifactDTO(this.ownedArtifact(actor, input.artifactId))
        const draft = draftDTO(this.ownedDraft(actor, input.artifactId))
        this.checkDraftRevision(draft.revision, input.expectedDraftRevision)
        if (artifact.latestVersionId !== input.expectedLatestVersionId) {
          throw new EducationError(
            'version-conflict',
            'formal version changed; reload its current pointer before saving',
          )
        }
        this.validateStoredAnalysisBody(
          actor,
          input.artifactId,
          draft.body,
          this.creation.basis(actor, input.artifactId),
        )
        const count = this.db
          .prepare('SELECT COALESCE(MAX(version_no), 0) AS last FROM artifact_versions WHERE artifact_id = ?')
          .get(input.artifactId)
        const versionNo = integer(integer(count?.last) + 1)
        const versionId = newId<ArtifactVersionId>()
        const now = this.now()
        this.db
          .prepare('INSERT INTO artifact_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            versionId,
            input.artifactId,
            actor.organizationId,
            actor.userId,
            versionNo,
            draft.body,
            draft.bodyHash,
            JSON.stringify(this.creation.basis(actor, input.artifactId)),
            actor.userId,
            now,
          )
        const updated = this.db
          .prepare(
            `UPDATE artifacts SET latest_version_id = ?, updated_at = ?
          WHERE id = ? AND organization_id = ? AND owner_id = ? AND latest_version_id IS ?`,
          )
          .run(versionId, now, input.artifactId, actor.organizationId, actor.userId, input.expectedLatestVersionId)
        if (updated.changes !== 1) throw new EducationError('version-conflict', 'formal version changed during saving')
        this.touchProject(actor, artifact.projectId, now)
        return {
          operation: 'artifacts.saveVersion',
          artifactId: input.artifactId,
          versionId,
          versionNo,
          draftRevision: draft.revision,
        }
      },
    )
    if (result.operation !== 'artifacts.saveVersion') throw failure(undefined)
    return result
  }

  listVersions(actor: ActorContext, artifactId: ArtifactId, input: PageInput): Page<ArtifactVersionSummary> {
    this.pageSize(input.limit)
    return this.authorized(actor, () => {
      this.ownedArtifact(actor, artifactId)
      const cursor = this.cursor(actor, input.cursor, 'versions', artifactId)
      const after = cursor === null ? null : integer(cursor.number)
      const rows = this.db
        .prepare(
          `SELECT id, artifact_id, version_no, body_hash, saved_by, saved_at
        FROM artifact_versions WHERE artifact_id = ? AND organization_id = ? AND owner_id = ?
        AND (? IS NULL OR version_no < ?) ORDER BY version_no DESC LIMIT ?`,
        )
        .all(artifactId, actor.organizationId, actor.userId, after, after, input.limit + 1)
      const items = rows.slice(0, input.limit).map(versionSummary)
      const last = items.at(-1)
      return {
        items,
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? this.encodeCursor(actor, { scope: 'versions', artifactId, number: last.versionNo })
            : null,
      }
    })
  }

  readVersion(actor: ActorContext, artifactId: ArtifactId, versionId: ArtifactVersionId): ArtifactVersionDTO {
    return this.authorized(actor, () => {
      const version = versionDTO(this.ownedVersion(actor, artifactId, versionId))
      if (!this.creation.permitted(actor, version.basisSnapshot)) return { ...version, body: '', restricted: true }
      this.validateStoredAnalysisBody(actor, artifactId, version.body, version.basisSnapshot)
      return version
    })
  }

  restoreVersion(actor: ActorContext, input: RestoreVersionInput): DraftCommitted {
    expectedRevision(input.expectedDraftRevision)
    const result = this.write(
      actor,
      'drafts.restoreVersion',
      input.requestId,
      { artifactId: input.artifactId, versionId: input.versionId, expectedDraftRevision: input.expectedDraftRevision },
      () => {
        this.creation.assertWritable(actor, input.artifactId)
        const version = versionDTO(this.ownedVersion(actor, input.artifactId, input.versionId))
        if (!this.creation.permitted(actor, version.basisSnapshot)) throw unavailable()
        this.validateStoredAnalysisBody(actor, input.artifactId, version.body, version.basisSnapshot)
        const draft = draftDTO(this.ownedDraft(actor, input.artifactId))
        this.checkDraftRevision(draft.revision, input.expectedDraftRevision)
        const result = this.updateDraft(actor, input.artifactId, version.body, draft.revision, 'drafts.restoreVersion')
        this.creation.setBasis(input.artifactId, version.basisSnapshot)
        return result
      },
    )
    if (result.operation !== 'drafts.restoreVersion') throw failure(undefined)
    return result
  }

  getResult(actor: ActorContext, operation: WriteOperation, requestId: RequestId): WriteResult | null {
    return this.authorized(actor, () => {
      const row = this.receipt(actor, operation, requestId)
      return row === undefined ? null : this.checkedResult(actor, operation, text(row, 'result_json'))
    })
  }

  bindSession(actor: ActorContext, input: BindSessionInput): SessionBound {
    if (input.harnessSessionId.trim() === '' || input.harnessSessionId.length > 200) {
      throw new EducationError('validation-failed', 'native session identity is invalid')
    }
    const result = this.write(
      actor,
      'sessions.bind',
      input.requestId,
      { projectId: input.projectId, artifactId: input.artifactId, harnessSessionId: input.harnessSessionId },
      () => {
        this.ownedProject(actor, input.projectId)
        const artifact = artifactDTO(this.ownedArtifact(actor, input.artifactId))
        if (artifact.projectId !== input.projectId) throw unavailable()
        if (
          this.db
            .prepare('SELECT id FROM session_bindings WHERE harness_session_id = ?')
            .get(input.harnessSessionId) !== undefined
        )
          throw unavailable()
        const binding: SessionBindingDTO = {
          id: newId(),
          projectId: input.projectId,
          artifactId: input.artifactId,
          harnessSessionId: input.harnessSessionId,
          status: 'active',
          createdAt: this.now(),
        }
        this.db
          .prepare('INSERT INTO session_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            binding.id,
            actor.organizationId,
            actor.userId,
            binding.projectId,
            binding.artifactId,
            binding.harnessSessionId,
            binding.status,
            binding.createdAt,
          )
        return { operation: 'sessions.bind', binding }
      },
    )
    if (result.operation !== 'sessions.bind') throw failure(undefined)
    return result
  }

  getSessionBinding(actor: ActorContext, harnessSessionId: SessionId): SessionBindingDTO {
    return this.authorized(actor, () => {
      const row = this.db
        .prepare(
          `SELECT * FROM session_bindings
        WHERE harness_session_id = ? AND organization_id = ? AND owner_id = ? AND status = 'active'`,
        )
        .get(harnessSessionId, actor.organizationId, actor.userId)
      if (row === undefined) throw unavailable()
      const run = this.db
        .prepare(
          `SELECT r.basis_json FROM creation_runs r LEFT JOIN research_attempts a ON a.run_id=r.id
        WHERE r.session_id=? OR a.session_id=? LIMIT 1`,
        )
        .get(harnessSessionId, harnessSessionId)
      if (run !== undefined && !this.creation.permitted(actor, decodeBasis(text(run, 'basis_json'))))
        throw unavailable()
      return bindingDTO(row)
    })
  }

  invalidateSessionBinding(actor: ActorContext, harnessSessionId: SessionId): void {
    const commit = this.authorized(
      actor,
      () => {
        const row = this.db
          .prepare(
            `SELECT * FROM session_bindings
        WHERE harness_session_id = ? AND organization_id = ? AND owner_id = ?`,
          )
          .get(harnessSessionId, actor.organizationId, actor.userId)
        if (row === undefined) throw unavailable()
        const requestId = newId<RequestId>()
        this.db
          .prepare(
            `UPDATE session_bindings SET status = ?
        WHERE harness_session_id = ? AND organization_id = ? AND owner_id = ?`,
          )
          .run('invalid', harnessSessionId, actor.organizationId, actor.userId)
        this.db
          .prepare('INSERT INTO audit_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            newId(),
            actor.organizationId,
            actor.userId,
            'sessions.invalidate',
            'session',
            harnessSessionId,
            'committed',
            requestId,
            this.now(),
          )
        return {
          organizationId: actor.organizationId,
          userId: actor.userId,
          projectId: id<ProjectId>(row.project_id),
          operation: 'sessions.invalidate' as const,
          requestId,
        }
      },
      true,
    )
    this.notify(commit)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.observers.clear()
    this.analytics.dispose()
    this.db.close()
  }

  private now(): string {
    return new Date().toISOString()
  }

  private draftView(actor: ActorContext, artifactId: ArtifactId): DraftDTO {
    const draft = draftDTO(this.ownedDraft(actor, artifactId))
    const basis = this.creation.basis(actor, artifactId)
    if (!this.creation.permitted(actor, basis)) return { ...draft, body: '', restricted: true }
    if (draft.body !== '') this.validateStoredAnalysisBody(actor, artifactId, draft.body, basis)
    return draft
  }

  private validateAnalysisBody(actor: ActorContext, artifactId: ArtifactId, body: string, basis: BasisSnapshot): void {
    if (this.ownedArtifact(actor, artifactId).kind !== 'text-analysis') return
    const document = decodeResearchDocument(body)
    if (document.kind === 'legacy-text') {
      if (basis.source !== 'foundation-validation')
        throw new EducationError('validation-failed', 'legacy text cannot claim verified research evidence')
      return
    }
    if (basis.source !== 'research-context' || basis.runId !== document.generated.runId)
      throw new EducationError('validation-failed', 'report does not match its original research run')
    const row = this.db
      .prepare(
        'SELECT snapshot_json FROM creation_runs WHERE id=? AND artifact_id=? AND organization_id=? AND owner_id=?',
      )
      .get(document.generated.runId, artifactId, actor.organizationId, actor.userId)
    if (row === undefined) throw new EducationError('validation-failed', 'report has no owned original run')
    const input = decodeRunSnapshot(text(row, 'snapshot_json'))
    if (
      input.scenario !== 'text-analysis' ||
      JSON.stringify(document.input) !== JSON.stringify(input.input) ||
      document.generated.policyVersion !== input.policyVersion ||
      document.generated.provider !== input.execution.provider ||
      document.generated.model !== input.execution.model
    )
      throw new EducationError('validation-failed', 'report source or model metadata differs from the fixed input')
  }

  private validateStoredAnalysisBody(
    actor: ActorContext,
    artifactId: ArtifactId,
    body: string,
    basis: BasisSnapshot,
  ): void {
    try {
      this.validateAnalysisBody(actor, artifactId, body, basis)
    } catch (error) {
      throw new EducationError(
        'storage-unavailable',
        'stored research report is invalid; dependent writes have stopped',
        { cause: error },
      )
    }
  }

  private transaction<T>(work: () => T, write = true): T {
    if (this.closed) throw new EducationError('closed', 'education repository is closed')
    try {
      this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
    } catch (error) {
      throw failure(error)
    }
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch (rollbackError) {
        this.close()
        throw new EducationError('storage-unavailable', 'education rollback failed; repository is closed', {
          cause: new AggregateError([error, rollbackError]),
        })
      }
      throw failure(error)
    }
  }

  private authorized<T>(actor: ActorContext, work: () => T, write = false): T {
    return this.transaction(() => {
      this.assertActor(actor)
      const result = work()
      this.assertActor(actor)
      return result
    }, write)
  }

  private assertActor(actor: ActorContext): void {
    const row = this.db
      .prepare(
        `SELECT l.id FROM login_sessions l
      JOIN users u ON u.id = l.user_id AND u.organization_id = l.organization_id
      JOIN organizations o ON o.id = l.organization_id
      WHERE l.id = ? AND l.organization_id = ? AND l.user_id = ? AND l.auth_revision = ?
      AND u.auth_revision = l.auth_revision AND l.revoked_at IS NULL AND l.expires_at > ?
      AND u.status = 'active' AND o.status = 'active'`,
      )
      .get(actor.loginSessionId, actor.organizationId, actor.userId, actor.authRevision, this.now())
    if (row === undefined) throw new EducationError('unauthenticated', 'employee login is expired, revoked or invalid')
  }

  private write(
    actor: ActorContext,
    operation: WriteOperation,
    requestId: RequestId,
    parameters: object,
    perform: () => WriteResult,
  ): WriteResult {
    let commit: EducationProjectCommit | undefined
    const result = this.authorized(
      actor,
      () => {
        const requestHash = digest(JSON.stringify(parameters))
        const prior = this.receipt(actor, operation, requestId)
        if (prior !== undefined) {
          if (text(prior, 'request_hash') !== requestHash) {
            throw new EducationError(
              'idempotency-conflict',
              'request identity was already used with different parameters',
            )
          }
          return this.checkedResult(actor, operation, text(prior, 'result_json'))
        }
        const result = perform()
        const resourceId =
          result.operation === 'projects.create'
            ? result.projectId
            : result.operation === 'sessions.bind'
              ? result.binding.id
              : result.artifactId
        const resourceType =
          result.operation === 'projects.create'
            ? 'project'
            : result.operation === 'sessions.bind'
              ? 'session-binding'
              : 'artifact'
        const now = this.now()
        this.db
          .prepare('INSERT INTO request_receipts VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(actor.organizationId, actor.userId, operation, requestId, requestHash, JSON.stringify(result), now)
        this.db
          .prepare('INSERT INTO audit_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            newId(),
            actor.organizationId,
            actor.userId,
            operation,
            resourceType,
            resourceId,
            'committed',
            requestId,
            now,
          )
        commit = {
          organizationId: actor.organizationId,
          userId: actor.userId,
          projectId:
            result.operation === 'projects.create'
              ? result.projectId
              : result.operation === 'sessions.bind'
                ? result.binding.projectId
                : id<ProjectId>(this.ownedArtifact(actor, result.artifactId).project_id),
          operation,
          requestId,
        }
        return result
      },
      true,
    )
    if (commit !== undefined) this.notify(commit)
    return result
  }

  private notify(commit: EducationProjectCommit): void {
    for (const observer of [...this.observers]) {
      try {
        const settled: unknown = observer(Object.freeze(commit))
        void Promise.resolve(settled).catch(reportNotificationFailure)
      } catch (error) {
        reportNotificationFailure(error)
      }
    }
  }

  private receipt(actor: ActorContext, operation: WriteOperation, requestId: RequestId): Row | undefined {
    return this.db
      .prepare(
        `SELECT request_hash, result_json FROM request_receipts
      WHERE organization_id = ? AND owner_id = ? AND operation = ? AND request_id = ?`,
      )
      .get(actor.organizationId, actor.userId, operation, requestId)
  }

  private checkedResult(actor: ActorContext, operation: WriteOperation, serialized: string): WriteResult {
    const result = receiptResult(serialized)
    if (result.operation !== operation) throw failure(undefined)
    switch (result.operation) {
      case 'projects.create':
        this.ownedProject(actor, result.projectId)
        if (this.ownedArtifact(actor, result.artifactId).project_id !== result.projectId) throw failure(undefined)
        break
      case 'artifacts.create': {
        const artifact = this.ownedArtifact(actor, result.artifactId)
        if (
          artifact.kind !== 'text-analysis' ||
          artifact.project_id !== result.projectId ||
          this.ownedProject(actor, result.projectId).primary_artifact_id !== result.primaryArtifactId
        )
          throw failure(undefined)
        break
      }
      case 'artifacts.saveVersion':
        this.ownedVersion(actor, result.artifactId, result.versionId)
        break
      case 'drafts.sync':
      case 'drafts.restoreVersion':
        this.ownedArtifact(actor, result.artifactId)
        break
      case 'sessions.bind': {
        const binding = this.db
          .prepare(
            `SELECT id FROM session_bindings WHERE id = ?
          AND organization_id = ? AND owner_id = ? AND status = 'active'`,
          )
          .get(result.binding.id, actor.organizationId, actor.userId)
        if (binding === undefined) throw unavailable()
        break
      }
    }
    return result
  }

  private ownedProject(actor: ActorContext, projectId: ProjectId): Row {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ? AND organization_id = ? AND owner_id = ?')
      .get(projectId, actor.organizationId, actor.userId)
    if (row === undefined) throw unavailable()
    return row
  }

  private ownedArtifact(actor: ActorContext, artifactId: ArtifactId): Row {
    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE id = ? AND organization_id = ? AND owner_id = ?')
      .get(artifactId, actor.organizationId, actor.userId)
    if (row === undefined) throw unavailable()
    return row
  }

  private ownedDraft(actor: ActorContext, artifactId: ArtifactId): Row {
    this.ownedArtifact(actor, artifactId)
    const row = this.db
      .prepare('SELECT * FROM drafts WHERE artifact_id = ? AND organization_id = ? AND owner_id = ?')
      .get(artifactId, actor.organizationId, actor.userId)
    if (row === undefined) throw failure(undefined)
    return row
  }

  private ownedVersion(actor: ActorContext, artifactId: ArtifactId, versionId: ArtifactVersionId): Row {
    this.ownedArtifact(actor, artifactId)
    const row = this.db
      .prepare(
        `SELECT * FROM artifact_versions
      WHERE id = ? AND artifact_id = ? AND organization_id = ? AND owner_id = ?`,
      )
      .get(versionId, artifactId, actor.organizationId, actor.userId)
    if (row === undefined) throw unavailable()
    return row
  }

  private checkDraftRevision(actual: number, expected: number): void {
    if (actual !== expected)
      throw new EducationError('draft-conflict', 'draft changed; reload its current revision before writing')
  }

  private updateDraft(
    actor: ActorContext,
    artifactId: ArtifactId,
    body: string,
    revision: number,
    operation: DraftCommitted['operation'],
  ): DraftCommitted {
    const result: DraftCommitted = {
      operation,
      artifactId,
      revision: integer(revision + 1),
      bodyHash: digest(body),
      updatedAt: this.now(),
    }
    const updated = this.db
      .prepare(
        `UPDATE drafts SET body = ?, body_hash = ?, revision = ?, updated_at = ?
      WHERE artifact_id = ? AND organization_id = ? AND owner_id = ? AND revision = ?`,
      )
      .run(
        body,
        result.bodyHash,
        result.revision,
        result.updatedAt,
        artifactId,
        actor.organizationId,
        actor.userId,
        revision,
      )
    if (updated.changes !== 1) throw new EducationError('draft-conflict', 'draft changed during synchronization')
    const artifact = artifactDTO(this.ownedArtifact(actor, artifactId))
    this.db.prepare('UPDATE artifacts SET updated_at = ? WHERE id = ?').run(result.updatedAt, artifactId)
    this.touchProject(actor, artifact.projectId, result.updatedAt)
    return result
  }

  private touchProject(actor: ActorContext, projectId: ProjectId, now: string): void {
    this.db
      .prepare('UPDATE projects SET updated_at = ? WHERE id = ? AND organization_id = ? AND owner_id = ?')
      .run(now, projectId, actor.organizationId, actor.userId)
  }

  private pageSize(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.config.maxPageSize) {
      throw new EducationError('validation-failed', 'page size exceeds the configured range')
    }
  }

  private encodeCursor(actor: ActorContext, fields: object): string {
    return Buffer.from(
      JSON.stringify({ organizationId: actor.organizationId, userId: actor.userId, ...fields }),
    ).toString('base64url')
  }

  private cursor(
    actor: ActorContext,
    value: string | undefined,
    scope: 'projects' | 'versions',
    artifactId?: ArtifactId,
  ): Record<string, unknown> | null {
    if (value === undefined) return null
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new EducationError('validation-failed', 'pagination cursor is invalid')
    try {
      const decoded = parseObject(Buffer.from(value, 'base64url').toString('utf8'))
      if (
        decoded.organizationId !== actor.organizationId ||
        decoded.userId !== actor.userId ||
        decoded.scope !== scope ||
        (scope === 'versions' && decoded.artifactId !== artifactId)
      )
        throw new Error('cursor query mismatch')
      if (scope === 'projects') {
        timestamp(decoded.at)
        id<ProjectId>(decoded.id)
      } else if (integer(decoded.number) === 0) throw new Error('invalid version cursor')
      return decoded
    } catch (error) {
      throw new EducationError('validation-failed', 'pagination cursor does not belong to this query', { cause: error })
    }
  }
}

function reportNotificationFailure(error: unknown): void {
  // Notification failure cannot turn a committed write into a reported failure.
  console.warn(
    'Education commit notification failed after commit; reload current state.',
    error instanceof Error ? error.name : 'non-error rejection',
  )
}
