/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import {
  RpcId,
  ConnectionRpcError,
  type ClientRequest,
  type RpcId as RpcIdType,
} from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { bridge } from './http-bridge.ts'
import { isRemoteAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type { BrowserAuth } from './browser-auth.ts'
import { OperatorPeer } from './operator-peer.ts'
import type {
  PeerAdmission,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  HostConnectionFetch,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcResult,
  ConnectionRequestRejection,
  ConnectionRequestPolicy,
  ConnectionAccess,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly handler: ConnectionRpcHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly fetch: ConnectionFetchRoute['fetch']
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  /** Default operator Peer for deployments without a request policy. */
  readonly operator: PeerScope
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()
  private requestPolicy: { readonly policy: ConnectionRequestPolicy; readonly lifetime: AbortController } | undefined

  readonly allowsRemoteAuthorities: boolean

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by the Host/Origin fence.
   * @param browserAuth - process token and persistent browser-session owner.
   * @param requiresRequestPolicy - refuse requests whenever the deployment policy is absent.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly browserAuth: BrowserAuth,
    readonly requiresRequestPolicy = false,
  ) {
    super(ctx, 'connection')
    this.operator = new OperatorPeer(ctx)
    ctx.effect(() => () => this.operator.dispose(), 'client-connection: operator Peer')
    this.allowsRemoteAuthorities = trustedHosts.some(isRemoteAuthority)
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
    }
  }

  /** Install one reversible deployment policy without replacing the transport. */
  registerRequestPolicy(policy: ConnectionRequestPolicy): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.requestPolicy !== undefined) throw new Error('connection: request policy is already registered')
      const lifetime = new AbortController()
      this.requestPolicy = { policy, lifetime }
      return () => {
        this.requestPolicy = undefined
        lifetime.abort()
      }
    }, 'client-connection: request identity policy')
  }

  /** Observe identity revocation and withdrawal of the admitting policy. */
  peerSignal(peer: PeerScope): AbortSignal | undefined {
    const selected = this.requestPolicy
    if (selected === undefined && !this.requiresRequestPolicy) return undefined
    if (!this.accepts(peer) || selected === undefined) {
      return AbortSignal.abort(new Error('connection: Peer is no longer authenticated'))
    }
    const identity = selected.policy.signal?.(peer)
    return identity === undefined ? selected.lifetime.signal : AbortSignal.any([identity, selected.lifetime.signal])
  }

  /** Check current identity and resource permission through the selected policy. */
  authorize(peer: PeerScope, access: ConnectionAccess): boolean {
    const selected = this.requestPolicy
    if (selected === undefined) return !this.requiresRequestPolicy
    return selected.policy.accepts(peer) && (selected.policy.authorize?.(peer, access) ?? true)
  }

  /** Apply the Host/Origin fence, then the selected authentication policy. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    const admission = this.admit(request)
    return 'rejection' in admission ? admission.rejection : undefined
  }

  /** Resolve this request's Peer after the transport trust fence. */
  admit(request: ConnectionTrustRequest): PeerAdmission {
    const carrier = this.ctx.get('webServer')
    if (!isTrustedApiRequest(request, this.trustedHosts, carrier?.host, carrier?.protocol ?? 'http:')) return { rejection: 403 }
    if (this.requestPolicy !== undefined) return this.requestPolicy.policy.admit(request)
    if (this.requiresRequestPolicy) return { rejection: 401 }
    return this.browserAuth.isAuthenticated(request, carrier?.protocol === 'https:')
      ? { peer: this.operator } : { rejection: 401 }
  }

  /**
   * Authenticate an index request; native TLS listeners mint Secure cookies.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    const carrier = this.ctx.get('webServer')
    if (this.requestPolicy !== undefined || this.requiresRequestPolicy) {
      if (!isTrustedApiRequest(request, this.trustedHosts, carrier?.host, carrier?.protocol ?? 'http:')) {
        response.writeHead(403)
        response.end('forbidden')
        return false
      }
      if (this.requestPolicy !== undefined) return this.requestPolicy.policy.authorizeIndex(request, response)
      response.writeHead(401)
      response.end('unauthorized')
      return false
    }
    return this.browserAuth.authorizeIndex(request, response, this.ctx.get('webServer')?.protocol === 'https:')
  }

  /** Add this process's launch token to the clean application URL. */
  authenticatedUrl(baseUrl: string): string {
    if (this.requestPolicy !== undefined || this.requiresRequestPolicy) return baseUrl
    return this.browserAuth.authenticatedUrl(baseUrl)
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   * @param channel - shared channel mounted by Connection.
   * @param peer - authenticated Peer selected by the carrier.
   * @returns Fetch handler that selects one owner or returns 404.
   */
  createSharedFetchHandler(
    channel: '/api',
    peer: PeerScope = this.operator,
  ): ConnectionFetchHandler {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      fetch: async (request) => {
        if (!this.accepts(peer)) return new Response('unauthorized', { status: 401 })
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) {
          const access: ConnectionAccess = { kind: 'fetch', url: new URL(request.url), method: request.method }
          if (!this.authorize(peer, access)) return new Response('resource unavailable', { status: 403 })
          const response = await route.fetch(request, peer)
          if (this.accepts(peer) && this.authorize(peer, access)) return response
          await response.body?.cancel()
          return new Response('resource unavailable', { status: this.accepts(peer) ? 403 : 401 })
        }
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return this.boundRpcHandler(channel, interceptor.handler, peer).fetch(request)
      },
    }
  }

  private boundRpcHandler(channel: string, handler: ConnectionRpcHandler, peer: PeerScope): ConnectionFetchHandler {
    return rpcFetchHandler(channel, handler, peer, () => this.accepts(peer),
      (endpoint, payload) => this.authorize(peer, { kind: 'rpc', channel, endpoint, payload }))
  }

  private accepts(peer: PeerScope): boolean {
    return this.requestPolicy?.policy.accepts(peer) ?? (!this.requiresRequestPolicy && peer === this.operator)
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    assertChannel(channel)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const admission = this.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection)
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const peer = admission.peer
        await bridge(req, res, this.boundRpcHandler(channel, handler, peer))
      },
    }
    return owner.effect(
      () => {
        const server = owner.get('webServer')
        if (server === undefined) throw new Error('connection: an HTTP RPC channel requires an active webServer')
        return server.register(route)
      },
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      handler,
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
  peer: PeerScope,
  accepts: () => boolean,
  authorize: (endpoint: string, payload: unknown) => boolean,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        if (!accepts()) return new Response('unauthorized', { status: 401 })
        if (!authorize(endpoint, message.payload)) return new Response('resource unavailable', { status: 403 })
        const result = await handler(endpoint, message.payload, request.signal, peer)
        if (!accepts()) return new Response('unauthorized', { status: 401 })
        if (!authorize(endpoint, message.payload)) return new Response('resource unavailable', { status: 403 })
        return fullResponse(message.rpcId, result)
      } catch (error) {
        if (error instanceof ConnectionRpcError) return errorResponse(message.rpcId, error.failure)
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: Awaited<ReturnType<ConnectionRpcHandler>>): Response {
  if (!result.ok) {
    const body: ConnectionServerResponse = { type: 'server-response', rpcId, result }
    return Response.json(body)
  }
  const { attachments, ...success } = result
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result: success }
  if (attachments === undefined || attachments.length === 0) return Response.json(body)
  const parts = new FormData()
  const attachmentMetadata = attachments.map((attachment, index) => {
    const part = `bytes-${index}`
    // FileSystem bytes may have SharedArrayBuffer backing, which BlobPart excludes.
    parts.set(part, new Blob([new Uint8Array(attachment.bytes)]))
    return { path: [...attachment.path], codec: 'bytes' as const, part }
  })
  parts.set('metadata', JSON.stringify({ ...body, attachments: attachmentMetadata }))
  return new Response(parts)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  const methods = new Set(route.methods)
  if (methods.size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}
