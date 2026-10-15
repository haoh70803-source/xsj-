/** Safe business failures carried by the existing Remote error protocol. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { EducationError, type EducationErrorCode } from '@deepseek-ai/dsh-experimental-education-platform'
import type { EducationRemoteErrorCode } from './error-codes.ts'

const codes = {
  'validation-failed': 'education/INPUT_INVALID',
  unauthenticated: 'education/UNAUTHENTICATED',
  'resource-unavailable': 'education/RESOURCE_UNAVAILABLE',
  forbidden: 'education/RESOURCE_UNAVAILABLE',
  'draft-conflict': 'education/DRAFT_CONFLICT',
  'version-conflict': 'education/VERSION_CONFLICT',
  'idempotency-conflict': 'education/IDEMPOTENCY_CONFLICT',
  'storage-busy': 'education/STORAGE_UNAVAILABLE',
  'storage-unavailable': 'education/STORAGE_UNAVAILABLE',
  'schema-mismatch': 'education/PROVIDER_UNAVAILABLE',
  'migration-failed': 'education/PROVIDER_UNAVAILABLE',
  closed: 'education/PROVIDER_UNAVAILABLE',
  'identity-unavailable': 'education/PROVIDER_UNAVAILABLE',
  'rate-limited': 'education/PROVIDER_UNAVAILABLE',
  'quota-exceeded': 'education/QUOTA_EXCEEDED',
  'result-unknown': 'education/RESULT_UNKNOWN',
  'provider-paused': 'education/PROVIDER_PAUSED',
} as const satisfies Record<EducationErrorCode, string>

const messages = {
  'education/INPUT_INVALID': 'Check request fields, limits and revision baselines.',
  'education/UNAUTHENTICATED': 'Sign in again before continuing.',
  'education/RESOURCE_UNAVAILABLE': 'Resource unavailable; return to your project list.',
  'education/DRAFT_CONFLICT': 'The draft changed. Keep local text and reload the current revision.',
  'education/VERSION_CONFLICT': 'The formal version changed. Reload its pointer before saving.',
  'education/IDEMPOTENCY_CONFLICT': 'Use the original request and parameters, or start a new explicit operation.',
  'education/STORAGE_UNAVAILABLE':
    'Storage is unavailable. Keep local text and query the original request before retrying.',
  'education/PROVIDER_UNAVAILABLE': 'The required service is unavailable. Keep local text and retry after recovery.',
  'education/OPERATION_INTERRUPTED': 'The operation was interrupted. Query the original request before retrying.',
  'education/QUOTA_EXCEEDED':
    'The configured request or spending limit is exhausted. Review the authorized budget before another request.',
  'education/RESULT_UNKNOWN':
    'The external result is unknown. Keep the reservation and reconcile the original request before an explicit retry.',
  'education/PROVIDER_PAUSED':
    'The data provider is paused. Ask the maintainer to review its authorization or quota before resuming.',
} as const

/**
 * Contain private causes and map business failures to stable Remote codes.
 * @param error - internal or expected business failure.
 * @returns a transport-safe failure without database paths, text, credentials or stack details.
 */
export function wireFailure(error: unknown): RemoteError<EducationRemoteErrorCode> {
  const code =
    error instanceof EducationError
      ? codes[error.code]
      : error instanceof Error && error.name === 'AbortError'
        ? 'education/OPERATION_INTERRUPTED'
        : 'education/STORAGE_UNAVAILABLE'
  return new RemoteError(code, messages[code], {})
}
