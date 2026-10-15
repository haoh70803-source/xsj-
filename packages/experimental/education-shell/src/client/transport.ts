/** Same-origin cookie transport for the exact employee HTTP routes. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OrganizationId, UserDTO, UserId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import type { WorkspaceTransport, EducationRemote } from './model.ts'
import { requestId } from './model.ts'

/** Admit only the public /me DTO, never a server Actor or credential object. */
function userOf(value: unknown): UserDTO {
  if (typeof value !== 'object' || value === null || !('user' in value)) throw new Error('Invalid identity response')
  const user = value.user
  if (
    typeof user !== 'object' ||
    user === null ||
    !('id' in user) ||
    typeof user.id !== 'string' ||
    !('organizationId' in user) ||
    typeof user.organizationId !== 'string' ||
    !('username' in user) ||
    typeof user.username !== 'string'
  )
    throw new Error('Invalid employee response')
  return {
    id: brandString<UserId>(user.id),
    organizationId: brandString<OrganizationId>(user.organizationId),
    username: user.username,
  }
}
/** HTTP failures carry only a safe code; bodies and URLs never enter a user error. */
function checked(response: Response): Response {
  if (response.status === 401) throw Object.assign(new Error('Sign-in required'), { code: 'education/UNAUTHENTICATED' })
  if (!response.ok) throw Object.assign(new Error('Request unavailable'), { code: 'education/PROVIDER_UNAVAILABLE' })
  return response
}
/**
 * Use document-relative routes, matching the native Connection HTTP carrier.
 * @param remote - generated education namespace mounted in an explicitly injected scope.
 * @returns exact employee HTTP adapters and the generated business commands.
 */
export function createTransport(remote: EducationRemote): WorkspaceTransport {
  return {
    remote,
    requestId,
    async identity(action, signal, credentials) {
      const response = await fetch(`education/auth/${action}`, {
        method: action === 'me' ? 'GET' : 'POST',
        signal,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(action === 'me'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials ?? {}) }),
      })
      if (action === 'me' && response.status === 401) return null
      checked(response)
      if (action === 'sign-out') return null
      return userOf(await response.json())
    },
    async download(request, signal) {
      const params = new URLSearchParams({ artifactId: request.artifactId, target: request.target })
      if (request.target === 'version') params.set('versionId', request.versionId)
      const response = checked(
        await fetch(`api/education/artifacts.exportText?${params}`, {
          signal,
          credentials: 'same-origin',
          cache: 'no-store',
        }),
      )
      if (response.headers.get('content-type')?.split(';')[0] !== 'text/plain') throw new Error('Invalid text download')
      return response.blob()
    },
  }
}
