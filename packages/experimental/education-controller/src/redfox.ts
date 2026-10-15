/** Bounded RedFox transport. It resolves native credentials for each call and never retries a charged operation. */
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  DataProviderErrorCode,
  DataProviderReply,
  DataProviderRequest,
  EducationDataProvider,
  ProviderDelivery,
} from '@deepseek-ai/dsh-experimental-education-platform'
import { z } from 'zod'

/** Operator-owned network and credential bounds; all timing and size choices are explicit. */
export interface RedFoxConfig {
  readonly baseUrl: string
  readonly credentialRef: string
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly allowLoopback: boolean
}

/** Supplier failure with safe category and delivery knowledge; causes remain Host-only. */
export class RedFoxError extends Error {
  constructor(
    readonly code: DataProviderErrorCode,
    readonly delivery: ProviderDelivery,
    readonly httpStatus: number | null = null,
    readonly providerCode: string | null = null,
    options?: ErrorOptions,
  ) {
    super(`RedFox operation failed: ${code}`, options)
    this.name = 'RedFoxError'
  }
}

const configuration = z.strictObject({
  baseUrl: z.url(),
  credentialRef: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(600_000),
  maxResponseBytes: z.number().int().min(1).max(33_554_432),
  allowLoopback: z.boolean(),
})
const envelope = z.object({
  code: z.union([z.string(), z.number().int()]),
  data: z.unknown().optional(),
  requestId: z.string().optional(),
})

function failure(code: string, status: number): DataProviderErrorCode {
  if (status === 401 || status === 403 || ['401', '403', '3103', '3105', '3106', '3107', '4001'].includes(code))
    return 'authentication'
  if (status === 402 || code === '3201' || code === '3202') return 'quota'
  if (status === 429 || code === '429' || code === '4004') return 'rate-limited'
  if (status >= 500 || code === '500' || code === '503') return 'server'
  if (status === 400 || ['400', '1001', '1002', '1003'].includes(code)) return 'invalid-request'
  return 'not-covered'
}

function requestParts(input: DataProviderRequest): { path: string; body: Record<string, string | number> } {
  if (input.operation === 'account') {
    if (input.platform === 'douyin' && input.accountId.startsWith('MS4w'))
      throw new RedFoxError('invalid-request', 'not-dispatched')
    return {
      path: input.platform === 'douyin' ? '/story/api/dyData/queryUser' : '/story/api/xhsUser/queryAccountDetail',
      body: { accountId: input.accountId },
    }
  }
  if (input.operation === 'content')
    return {
      path: input.platform === 'douyin' ? '/story/api/dyData/queryWork' : '/story/api/xhsUser/queryWorkDetail',
      body: { workId: input.externalId },
    }
  const identity =
    input.platform === 'xiaohongshu'
      ? { redId: input.accountId }
      : input.accountId.startsWith('MS4w')
        ? { secUserId: input.accountId }
        : { accountId: input.accountId }
  return {
    path: input.platform === 'douyin' ? '/story/api/dyData/queryWorkList' : '/story/api/xhsUser/queryWorkList',
    body: { ...identity, offset: input.offset, sortType: input.sortType },
  }
}

function requestId(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel()
    throw new RedFoxError('response-too-large', 'response-received', response.status)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0,
    complete = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        complete = true
        break
      }
      size += next.value.byteLength
      if (size > limit) throw new RedFoxError('response-too-large', 'response-received', response.status)
      chunks.push(next.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    if (!complete) await reader.cancel()
    reader.releaseLock()
  }
}

/** Native-reference Provider. The consumer owns authorization, reservations and all observable business state. */
export class RedFoxProvider implements EducationDataProvider {
  private readonly config: RedFoxConfig
  private readonly origin: string
  private readonly reference: ReturnType<typeof credentialRef>
  constructor(
    config: RedFoxConfig,
    private readonly credentials: Pick<CredentialProvider, 'resolve'>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.config = configuration.parse(config)
    this.reference = credentialRef(config.credentialRef)
    const origin = new URL(config.baseUrl)
    const official = origin.protocol === 'https:' && origin.hostname === 'redfox.hk' && origin.port === ''
    const loopback =
      config.allowLoopback &&
      origin.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    if (
      (!official && !loopback) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('RedFox baseUrl must be the official HTTPS origin or an explicitly enabled test loopback origin')
    this.origin = origin.origin
  }
  async available(): Promise<boolean> {
    return (await this.credentials.resolve(this.reference)) !== undefined
  }
  async request(
    input: DataProviderRequest,
    beforeDispatch: () => void,
    signal: AbortSignal,
  ): Promise<DataProviderReply> {
    const parts = requestParts(input)
    if (isAborted(signal)) throw new RedFoxError('cancelled', 'not-dispatched')
    const credential = await this.credentials.resolve(this.reference)
    if (credential === undefined) throw new RedFoxError('not-configured', 'not-dispatched')
    if (isAborted(signal)) throw new RedFoxError('cancelled', 'not-dispatched')
    const deadline = new AbortController(),
      lifetime = AbortSignal.any([signal, deadline.signal])
    const timer = setTimeout(() => {
      deadline.abort()
    }, this.config.timeoutMs)
    try {
      beforeDispatch()
    } catch (error) {
      clearTimeout(timer)
      throw error
    }
    try {
      const response = await this.fetcher(new URL(parts.path, this.origin), {
        method: 'POST',
        redirect: 'error',
        signal: lifetime,
        headers: { 'content-type': 'application/json', REDFOX_API_KEY: credential.value },
        body: JSON.stringify(parts.body),
      })
      const raw = await boundedText(response, this.config.maxResponseBytes)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        if (!response.ok) throw new RedFoxError(failure('', response.status), 'response-received', response.status)
        throw new RedFoxError('invalid-response', 'response-received', response.status, null, { cause: error })
      }
      const decoded = envelope.safeParse(parsed)
      if (!decoded.success) {
        if (!response.ok) throw new RedFoxError(failure('', response.status), 'response-received', response.status)
        throw new RedFoxError('invalid-response', 'response-received', response.status)
      }
      const code = String(decoded.data.code)
      if (!response.ok || code !== '2000')
        throw new RedFoxError(failure(code, response.status), 'response-received', response.status, code)
      if (decoded.data.data === null || decoded.data.data === undefined)
        throw new RedFoxError('not-covered', 'response-received', response.status, code)
      return {
        data: decoded.data.data,
        providerCode: code,
        requestId: requestId(decoded.data.requestId) ?? requestId(response.headers.get('x-request-id')),
      }
    } catch (error) {
      if (error instanceof RedFoxError) throw error
      throw new RedFoxError(
        deadline.signal.aborted ? 'timeout' : signal.aborted ? 'cancelled' : 'network',
        'unknown',
        null,
        null,
        { cause: error },
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

function isAborted(signal: AbortSignal): boolean { return signal.aborted }
