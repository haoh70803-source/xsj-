/** Host-only education service. Public HTTP and Remote exposure belong to an authorized controller. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { EducationRepository } from './repository.ts'
import type { EducationIdentity } from './identity.ts'

export { EducationError, type EducationErrorCode } from './error.ts'
export type {
  EducationRepository,
  ProvisionUserInput,
  UserCredentialRecord,
  CreateLoginSessionInput,
} from './repository.ts'
export type { EducationIdentity, IdentityRequest, IdentitySignInResult, IdentityState } from './identity.ts'
export type * from './types.ts'
export type * from './data-provider.ts'
export {
  previousSevenCompleteDays,
  missingMetrics,
  analyzeContent,
  measuredCount,
  analyticsLocalDate,
  analyticsDay,
  nextAnalyticsDaily,
  analyticsTimestamp,
} from './analytics.ts'
export { paragraphEvidence, parseResearchInputV1, type ParsedResearchInput } from './research-input.ts'
export {
  ResearchValidationError,
  validateResearchSource,
  validateResearchReport,
  decodeResearchDocument,
} from './research-report.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Transactional repository selected by the explicit education composition. */
    educationRepository: EducationRepository
    /** Host business consumer, unavailable until its repository is ready. */
    educationPlatform: EducationPlatform
    /** Durable employee authentication selected by the explicit identity layer. */
    educationIdentity: EducationIdentity
  }
}

/** Storage-dependent business entry; no default operator or ambient current employee. */
export class EducationPlatform extends Service {
  static inject = ['educationRepository']
  /** Trusted Host consumers must supply an actor for each private operation. */
  readonly repository: EducationRepository

  /** @param ctx - service context with a successfully initialized transactional provider. */
  constructor(ctx: Context) {
    super(ctx, 'educationPlatform')
    this.repository = ctx.educationRepository
  }
}

export default EducationPlatform
