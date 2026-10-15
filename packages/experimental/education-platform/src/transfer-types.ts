/** Cross-entry commands preserve exact original observations and current upstream authority. */
import type { ActorContext, SourceDTO } from './types.ts'
import type { ResearchTransferInput } from './research-types.ts'
import type { AnalyticsTransferInput } from './analytics-types.ts'
/** Same-medium source transfers; navigation and transfer never perform model/provider work. */
export interface TransferRepository {
  /**
 * Return reference-method source carrying its report/source dependencies.
 * @param actor - current employee.
 * @param input - saved immutable report and direction.
 * @returns reference-method source carrying its report/source dependencies.
 */
  fromResearch(actor: ActorContext, input: ResearchTransferInput): SourceDTO
  /**
 * Return reference source, requiring original text for research.
 * @param actor - current employee.
 * @param input - saved observation and explicit target.
 * @returns reference source, requiring original text for research.
 */
  fromAnalytics(actor: ActorContext, input: AnalyticsTransferInput): SourceDTO
}
