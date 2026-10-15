/** Stable education failures; transport owners localize and suppress internal causes. */

/** Handling categories shared by the business service and its repository. */
export type EducationErrorCode =
  | 'validation-failed'
  | 'unauthenticated'
  | 'resource-unavailable'
  | 'draft-conflict'
  | 'version-conflict'
  | 'idempotency-conflict'
  | 'forbidden'
  | 'rate-limited'
  | 'identity-unavailable'
  | 'quota-exceeded'
  | 'result-unknown'
  | 'provider-paused'
  | 'storage-busy'
  | 'storage-unavailable'
  | 'schema-mismatch'
  | 'migration-failed'
  | 'closed'

/** Expected failure with no sensitive parameters embedded in its message. */
export class EducationError extends Error {
  /**
   * @param code - stable handling category.
   * @param message - safe operation diagnostic.
   * @param options - internal cause retained by the reporting owner.
   */
  constructor(
    readonly code: EducationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'EducationError'
  }
}
