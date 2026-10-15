/** Controlled auth Fetch handlers; cookie headers and private causes never enter response JSON. */
import type { Context } from '@deepseek-ai/cordis'
import { bridge, type ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'
import type { EducationIdentity } from '@deepseek-ai/dsh-experimental-education-platform'
import { mountLoginShell } from './login-shell.ts'

const ENDPOINTS = [
  { path: '/education/auth/sign-in', method: 'POST', action: 'sign-in' },
  { path: '/education/auth/me', method: 'GET', action: 'me' },
  { path: '/education/auth/sign-out', method: 'POST', action: 'sign-out' },
] as const

/**
 * Mount exact authentication routes with the shared bounded Node-to-Fetch bridge.
 * @param ctx - route-owning context with webServer injected.
 * @param identity - selected, ready employee identity provider.
 * @param maxRequestBytes - complete buffered body cap.
 * @param loginShell - expose the public employee login document when explicitly selected.
 */
export function mountIdentityHttp(ctx: Context, identity: EducationIdentity, maxRequestBytes: number, loginShell = false): void {
  if (loginShell) mountLoginShell(ctx, identity)
  const logger = ctx.logger
  for (const endpoint of ENDPOINTS) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: endpoint.path,
      handler: async (request, response) => {
        const handler: ConnectionFetchHandler = {
          requestBodyMode: () => 'buffered',
          fetch: async (incoming) => {
            const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' }
            if (incoming.method !== endpoint.method) return new Response(null, { status: 405, headers })
            const facts = { headers: incoming.headers, remoteAddress: request.socket.remoteAddress ?? '', signal: incoming.signal }
            try {
              if (endpoint.action === 'me') {
                return Response.json({ user: identity.me(facts).user }, { headers })
              }
              if (endpoint.action === 'sign-out') {
                return Response.json({ signedOut: true }, { headers: { ...headers, 'set-cookie': identity.signOut(facts) } })
              }
              const mediaType = incoming.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
              if (mediaType !== 'application/json') return Response.json({ error: { code: 'validation-failed' } }, { status: 415, headers })
              let input: unknown
              try { input = await incoming.json() }
              catch (error) { throw new EducationError('validation-failed', 'authentication body is not JSON', { cause: error }) }
              const result = await identity.signIn(facts, input)
              return Response.json({ user: result.user }, { headers: { ...headers, 'set-cookie': result.setCookie } })
            } catch (error) {
              const code = error instanceof EducationError ? error.code : 'identity-unavailable'
              const status = code === 'validation-failed' ? 400 : code === 'unauthenticated' ? 401
                : code === 'forbidden' ? 403 : code === 'rate-limited' ? 429 : 503
              logger.warn('education authentication request failed: %s', code)
              return Response.json({ error: { code } }, { status, headers })
            }
          },
        }
        await bridge(request, response, handler, maxRequestBytes)
      },
    }), `education-identity: ${endpoint.path}`)
  }
}
