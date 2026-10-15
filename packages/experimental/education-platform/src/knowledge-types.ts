/** Private, authorized knowledge results; lists contain metadata and never full source text. */
import type { ActorContext, Page, SourceDTO, SourceVersionId } from './types.ts'

/** Source evidence is explicit text or an imported transcript; missing metadata denotes original text. */
export type KnowledgeKind = 'text' | 'transcript'

/** Owner-bound, literal keyword query. Cursor reuse across identities or queries is refused. */
export interface KnowledgeSearch {
  readonly query: string
  readonly kind: KnowledgeKind | 'all'
  readonly limit: number
  readonly cursor?: string
}

/** Authorized search metadata for the selected immutable source version. */
export interface KnowledgeItem extends Omit<SourceDTO, 'body' | 'authorized'> {
  readonly kind: KnowledgeKind
  readonly canUseForAi: boolean
}

/** Read-only knowledge access; every query filters current authorization before text matching. */
export interface KnowledgeRepository {
  /**
   * Search only readable, authorized source text; SQL wildcard characters are literal keywords.
   * @param actor - current server-resolved employee.
   * @param input - bounded query, kind and identity-bound cursor.
   * @returns metadata page without private bodies or unauthorized counts.
   */
  search(actor: ActorContext, input: KnowledgeSearch): Page<KnowledgeItem>
  /**
   * Resolve an exact selected version under its current source and upstream grants.
   * @param actor - current server-resolved employee.
   * @param versionId - immutable selected source version.
   * @returns currently permitted text; revoked or foreign resources are uniformly unavailable.
   */
  readSourceVersion(actor: ActorContext, versionId: SourceVersionId): SourceDTO
}
