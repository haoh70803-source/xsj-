/** Face-neutral education failure vocabulary for generated Remote consumers. */
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Stable business failures; HTTP admission and generated-codec failures retain their native carrier codes. */
export type EducationRemoteErrorCode =
  | 'education/INPUT_INVALID'
  | 'education/UNAUTHENTICATED'
  | 'education/RESOURCE_UNAVAILABLE'
  | 'education/DRAFT_CONFLICT'
  | 'education/VERSION_CONFLICT'
  | 'education/IDEMPOTENCY_CONFLICT'
  | 'education/STORAGE_UNAVAILABLE'
  | 'education/PROVIDER_UNAVAILABLE'
  | 'education/OPERATION_INTERRUPTED'
  | 'education/QUOTA_EXCEEDED'
  | 'education/RESULT_UNKNOWN'
  | 'education/PROVIDER_PAUSED'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'education/INPUT_INVALID': {}
    'education/UNAUTHENTICATED': {}
    'education/RESOURCE_UNAVAILABLE': {}
    'education/DRAFT_CONFLICT': {}
    'education/VERSION_CONFLICT': {}
    'education/IDEMPOTENCY_CONFLICT': {}
    'education/STORAGE_UNAVAILABLE': {}
    'education/PROVIDER_UNAVAILABLE': {}
    'education/OPERATION_INTERRUPTED': {}
    'education/QUOTA_EXCEEDED': {}
    'education/RESULT_UNKNOWN': {}
    'education/PROVIDER_PAUSED': {}
  }
}
