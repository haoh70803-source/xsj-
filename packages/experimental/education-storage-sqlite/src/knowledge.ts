/** Query-layer authorization for private text, transitive source references and account-derived material. */
import type { DatabaseSync } from 'node:sqlite'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  ActorContext,
  KnowledgeItem,
  KnowledgeRepository,
  KnowledgeSearch,
  Page,
  SourceDTO,
  SourceVersionId,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { digest, id, integer, parseObject, text, timestamp } from './codec.ts'
import { sourceView } from './source-view.ts'

interface Owner {
  transaction<T>(actor: ActorContext, work: () => T): T
  readonly maxPageSize: number
  readonly maxQueryBytes: number
}

// UNION, rather than UNION ALL, bounds propagation through a damaged cyclic dependency graph.
const AUTHORIZED_SOURCES = `WITH RECURSIVE
  scope(org,owner,permission) AS (VALUES(?,?,?)),
  edges(child,parent) AS (
    SELECT d.version_id,d.parent_id FROM source_dependencies d JOIN source_versions c ON c.id=d.version_id JOIN scope p
      WHERE d.kind='source' AND c.organization_id=p.org AND c.owner_id=p.owner
    UNION
    SELECT d.version_id,json_extract(r.value,'$.versionId') FROM source_dependencies d
      JOIN source_versions c ON c.id=d.version_id JOIN artifact_versions v ON v.id=d.parent_id
      JOIN json_each(v.basis_snapshot,'$.references') r JOIN scope p
      WHERE d.kind='report' AND c.organization_id=p.org AND c.owner_id=p.owner AND v.organization_id=p.org AND v.owner_id=p.owner
  ),
  forbidden(version_id) AS (
    SELECT v.id FROM source_versions v JOIN sources s ON s.id=v.source_id JOIN scope p
      WHERE v.organization_id=p.org AND v.owner_id=p.owner AND s.authorized=0
    UNION
    SELECT d.version_id FROM source_dependencies d JOIN source_versions c ON c.id=d.version_id JOIN scope p
      LEFT JOIN content_accounts a ON a.id=d.parent_id AND a.organization_id=p.org
      LEFT JOIN account_grants g ON g.account_id=a.id AND g.user_id=p.owner AND g.organization_id=p.org
      WHERE d.kind='account' AND c.organization_id=p.org AND c.owner_id=p.owner
        AND (a.id IS NULL OR a.enabled=0 OR g.account_id IS NULL OR g.revision<>d.parent_revision
          OR (p.permission='view' AND g.can_view=0) OR (p.permission='use_for_ai' AND g.can_use_for_ai=0) OR (p.permission='export' AND g.can_export=0))
    UNION
    SELECT d.version_id FROM source_dependencies d JOIN source_versions c ON c.id=d.version_id JOIN scope p
      LEFT JOIN source_versions v ON v.id=d.parent_id AND v.organization_id=p.org AND v.owner_id=p.owner
      LEFT JOIN sources s ON s.id=v.source_id
      WHERE d.kind='source' AND c.organization_id=p.org AND c.owner_id=p.owner
        AND (v.id IS NULL OR s.authorized=0 OR s.authorization_revision<>d.parent_revision)
    UNION
    SELECT d.version_id FROM source_dependencies d JOIN source_versions c ON c.id=d.version_id JOIN scope p
      LEFT JOIN artifact_versions v ON v.id=d.parent_id AND v.organization_id=p.org AND v.owner_id=p.owner
      WHERE d.kind='report' AND c.organization_id=p.org AND c.owner_id=p.owner AND
        (v.id IS NULL OR EXISTS(SELECT 1 FROM json_each(v.basis_snapshot,'$.references') r
          LEFT JOIN source_versions sv ON sv.id=json_extract(r.value,'$.versionId') AND sv.organization_id=p.org AND sv.owner_id=p.owner
          LEFT JOIN sources s ON s.id=sv.source_id WHERE sv.id IS NULL OR s.authorized=0
            OR s.authorization_revision<>json_extract(r.value,'$.authorizationRevision') OR sv.body_hash<>json_extract(r.value,'$.bodyHash')))
    UNION
    SELECT e.child FROM edges e JOIN forbidden f ON f.version_id=e.parent
  ), visible AS (
    SELECT v.id FROM source_versions v JOIN sources s ON s.id=v.source_id JOIN scope p
      WHERE v.organization_id=p.org AND v.owner_id=p.owner AND s.authorized=1 AND v.id NOT IN(SELECT version_id FROM forbidden)
  )`

/** Source reads share durable identity checks with the owning business repository. */
export class SqliteKnowledgeRepository implements KnowledgeRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: Owner,
  ) {}

  /**
   * Check dependencies inside the caller's current transaction; no authorization result is cached across operations.
   * @param actor - trusted owner, already revalidated by the caller.
   * @param versionId - exact immutable source version.
   * @param permission - view and model use remain independent grants.
   * @returns whether this operation is currently permitted through the whole dependency chain.
   */
  sourcePermitted(
    actor: ActorContext,
    versionId: SourceVersionId,
    permission: 'view' | 'use_for_ai' | 'export' = 'use_for_ai',
  ): boolean {
    const root = this.db
      .prepare(
        `SELECT v.id FROM source_versions v JOIN sources s ON s.id=v.source_id
      WHERE v.id=? AND v.organization_id=? AND v.owner_id=? AND s.authorized=1`,
      )
      .get(versionId, actor.organizationId, actor.userId)
    if (root === undefined) return false
    if (
      this.db.prepare('SELECT version_id FROM source_dependencies WHERE version_id=? LIMIT 1').get(versionId) ===
      undefined
    )
      return true
    return (
      this.db
        .prepare(AUTHORIZED_SOURCES + ' SELECT id FROM visible WHERE id=?')
        .get(actor.organizationId, actor.userId, permission, versionId) !== undefined
    )
  }

  search(actor: ActorContext, input: KnowledgeSearch): Page<KnowledgeItem> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > this.owner.maxPageSize ||
      !['all', 'text', 'transcript'].includes(input.kind) ||
      !input.query.isWellFormed() ||
      Buffer.byteLength(input.query) > this.owner.maxQueryBytes
    )
      throw new EducationError('validation-failed', 'knowledge query exceeds its configured bounds')
    const query = input.query.trim(),
      scope = digest(JSON.stringify([actor.organizationId, actor.userId, query, input.kind]))
    let after: string | null = null
    if (input.cursor !== undefined) {
      try {
        if (input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
          throw new Error('invalid cursor encoding')
        const decoded = parseObject(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        if (decoded.scope !== scope) throw new Error('cursor belongs to another knowledge query')
        after = id(decoded.id)
      } catch (error) {
        throw new EducationError('validation-failed', 'knowledge cursor is invalid', { cause: error })
      }
    }
    const pattern = '%' + query.replace(/[\\%_]/g, value => '\\' + value) + '%'
    return this.owner.transaction(actor, () => {
      const rows = this.db
        .prepare(
          AUTHORIZED_SOURCES +
            ` SELECT s.*,v.id AS version_id,v.body_hash,v.revision AS selected_revision,COALESCE(e.kind,'text') AS evidence_kind
        FROM sources s JOIN source_versions v ON v.id=s.current_version_id JOIN visible a ON a.id=v.id
        LEFT JOIN source_evidence e ON e.version_id=v.id
        WHERE (?='all' OR COALESCE(e.kind,'text')=?) AND (s.title LIKE ? ESCAPE '\\' OR v.body LIKE ? ESCAPE '\\')
          AND (? IS NULL OR s.id>?) ORDER BY s.id LIMIT ?`,
        )
        .all(
          actor.organizationId,
          actor.userId,
          'view',
          input.kind,
          input.kind,
          pattern,
          pattern,
          after,
          after,
          input.limit + 1,
        )
      const items: KnowledgeItem[] = rows.slice(0, input.limit).map((row) => {
        if (row.evidence_kind !== 'text' && row.evidence_kind !== 'transcript')
          throw new EducationError('storage-unavailable', 'source evidence kind is invalid')
        return {
          id: id(row.id),
          versionId: id(row.version_id),
          kind: row.evidence_kind,
          canUseForAi: this.sourcePermitted(actor, id(row.version_id)),
          title: text(row, 'title'),
          sourceUrl: text(row, 'source_url'),
          revision: integer(row.selected_revision),
          authorizationRevision: integer(row.authorization_revision),
          bodyHash: text(row, 'body_hash'),
          createdAt: timestamp(row.created_at),
        }
      })
      const last = items.at(-1)
      return {
        items,
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? Buffer.from(JSON.stringify({ scope, id: last.id })).toString('base64url')
            : null,
      }
    })
  }

  readSourceVersion(actor: ActorContext, versionId: SourceVersionId): SourceDTO {
    return this.owner.transaction(actor, () => {
      const row = this.db
        .prepare('SELECT source_id FROM source_versions WHERE id=? AND organization_id=? AND owner_id=?')
        .get(versionId, actor.organizationId, actor.userId)
      if (row === undefined || !this.sourcePermitted(actor, versionId, 'view'))
        throw new EducationError('resource-unavailable', 'source is unavailable')
      return sourceView(this.db, actor, id(row.source_id), versionId, selected =>
        this.sourcePermitted(actor, selected, 'view'),
      )
    })
  }
}
