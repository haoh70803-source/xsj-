/** No paid requests: these tests pin the provider's credential, response and uncertain-delivery rules. */
import { expect, it, vi } from 'vitest'
import { RedFoxProvider, RedFoxError, type RedFoxConfig } from '../src/redfox.ts'

const config: RedFoxConfig = {
  baseUrl: 'https://redfox.hk',
  credentialRef: 'REDFOX_TEST_KEY',
  timeoutMs: 1000,
  maxResponseBytes: 1000,
  allowLoopback: false,
}
const input = { operation: 'account', platform: 'douyin', accountId: 'synthetic-account' } as const
const signal = () => new AbortController().signal
const json = (code: number | string, data: unknown = { followers: 0 }) =>
  new Response(JSON.stringify({ code, data }), { headers: { 'content-type': 'application/json' } })

it('resolves the native reference again on every operation and keeps the key out of payloads', async () => {
  let value = 'synthetic-key-one'
  const headers: string[] = [],
    bodies: string[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    headers.push(new Headers(init?.headers).get('REDFOX_API_KEY') ?? '')
    if (typeof init?.body !== 'string') throw new Error('synthetic request body is not JSON text')
    bodies.push(init.body)
    return json(2000)
  }
  const provider = new RedFoxProvider(config, { resolve: async () => ({ value, source: 'test' }) }, fetcher)
  const sent = vi.fn()
  expect(await provider.request(input, sent, signal())).toMatchObject({ data: { followers: 0 }, providerCode: '2000' })
  value = 'synthetic-key-two'
  await provider.request(input, sent, signal())
  expect(headers).toEqual(['synthetic-key-one', 'synthetic-key-two'])
  expect(bodies.join()).not.toContain('synthetic-key')
  expect(sent).toHaveBeenCalledTimes(2)
})

it('does not send when the reference is missing, authority was revoked, or the durable reservation refuses dispatch', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const provider = new RedFoxProvider(config, { resolve: async () => undefined }, fetcher)
  await expect(provider.request(input, vi.fn(), signal())).rejects.toMatchObject({
    code: 'not-configured',
    delivery: 'not-dispatched',
  })
  const ready = new RedFoxProvider(config, { resolve: async () => ({ value: 'synthetic', source: 'test' }) }, fetcher)
  const abort = new AbortController()
  abort.abort()
  await expect(ready.request(input, vi.fn(), abort.signal)).rejects.toMatchObject({
    code: 'cancelled',
    delivery: 'not-dispatched',
  })
  await expect(
    ready.request(
      input,
      () => {
        throw new Error('budget refused')
      },
      signal(),
    ),
  ).rejects.toThrow('budget refused')
  expect(fetcher).not.toHaveBeenCalled()
})

it.each([
  [4004, 'rate-limited'],
  [3201, 'quota'],
  [3103, 'authentication'],
  [3105, 'authentication'],
  [1002, 'invalid-request'],
  [2999, 'not-covered'],
] as const)(
  'classifies business code %s independently of HTTP success without an automatic retry',
  async (code, category) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(code))
    const provider = new RedFoxProvider(
      config,
      { resolve: async () => ({ value: 'synthetic', source: 'test' }) },
      fetcher,
    )
    await expect(provider.request(input, vi.fn(), signal())).rejects.toMatchObject({
      code: category,
      delivery: 'response-received',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  },
)

it('retains uncertain delivery after transport failure instead of releasing a possible charged request', async () => {
  const provider = new RedFoxProvider(
    config,
    { resolve: async () => ({ value: 'synthetic', source: 'test' }) },
    async () => {
      throw new Error('socket lost')
    },
  )
  await expect(provider.request(input, vi.fn(), signal())).rejects.toMatchObject({
    code: 'network',
    delivery: 'unknown',
  })
})

it('bounds streamed bodies even when the supplier omits content-length', async () => {
  const provider = new RedFoxProvider(
    { ...config, maxResponseBytes: 20 },
    { resolve: async () => ({ value: 'synthetic', source: 'test' }) },
    async () => json(2000, 'x'.repeat(40)),
  )
  await expect(provider.request(input, vi.fn(), signal())).rejects.toMatchObject({ code: 'response-too-large' })
})

it('rejects invalid identities before dispatch and refuses origins that could receive another host’s key', async () => {
  const fetcher = vi.fn<typeof fetch>(),
    credentials = { resolve: async () => ({ value: 'synthetic', source: 'test' }) }
  const provider = new RedFoxProvider(config, credentials, fetcher)
  await expect(
    provider.request({ ...input, accountId: 'MS4w-requires-different-id' }, vi.fn(), signal()),
  ).rejects.toBeInstanceOf(RedFoxError)
  expect(fetcher).not.toHaveBeenCalled()
  expect(() => new RedFoxProvider({ ...config, baseUrl: 'https://example.com' }, credentials)).toThrow('baseUrl')
})
