/** Host identity requirements; cookie values never enter the public User DTO export. */
import type { ActorContext, UserDTO } from './types.ts'

/** Transport-owned request facts, obtained from headers and the direct socket, never JSON owner fields. */
export interface IdentityRequest {
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
  readonly remoteAddress: string
  readonly signal?: AbortSignal
}

/** One authenticated login response; the transport sets the cookie as a header, not JSON. */
export interface IdentitySignInResult {
  readonly user: UserDTO
  readonly setCookie: string
}

/** Trusted identity derived from the current durable login, without its raw token or digest. */
export interface IdentityState {
  readonly actor: ActorContext
  readonly user: UserDTO
}

/** Identity provider consumed by HTTP login and the request-Peer adapter. */
export interface EducationIdentity {
  /** Deployment-selected, canonical browser origin. */
  readonly publicOrigin: string
  /**
   * Verify credentials and persist a durable login before minting its response cookie.
   * @param request - trusted transport facts; Host and Origin are checked before credential work.
   * @param input - bounded external username and password JSON.
   * @returns public employee and a transport-only cookie header.
   */
  signIn(request: IdentityRequest, input: unknown): Promise<IdentitySignInResult>
  /**
   * Resolve an employee from a request's current cookie and durable authorization.
   * @param request - trusted transport facts.
   * @returns active identity; expired, disabled, revoked or absent logins reject uniformly.
   */
  me(request: IdentityRequest): IdentityState
  /**
   * Resolve the request identity for a connection admission decision.
   * @param request - trusted transport facts.
   * @returns current actor or null; storage and configuration failures remain errors.
   */
  actor(request: IdentityRequest): ActorContext | null
  /**
   * Revoke an active login and clear its cookie; an already invalid login only clears the cookie.
   * @param request - trusted transport facts with matching mutation Origin.
   * @returns transport-only clearing cookie header.
   */
  signOut(request: IdentityRequest): string
}
