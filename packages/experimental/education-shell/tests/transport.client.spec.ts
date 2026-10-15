import { afterEach, expect, it, vi } from 'vitest'
import { createTransport } from '../src/client/transport.ts'
import { artifactId, fixture, user, versionId } from './fixture.client.ts'

afterEach(() => { vi.unstubAllGlobals() })
it('uses exact same-origin cookie routes and sends only login credentials', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ user, actor: 'must not escape' }))
  vi.stubGlobal('fetch', send)
  const transport = createTransport(fixture().remote), signal = new AbortController().signal
  expect(await transport.identity('sign-in', signal, { username: 'employee-a', password: 'synthetic' })).toEqual(user)
  expect(send).toHaveBeenCalledWith('education/auth/sign-in', {
    method: 'POST', signal, credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'employee-a', password: 'synthetic' }),
  })
})
it('treats a 401 /me as signed out and rejects malformed identity responses', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ user: { id: user.id, organizationId: 1, username: 'employee' } }))
  vi.stubGlobal('fetch', send)
  const transport = createTransport(fixture().remote), signal = new AbortController().signal
  expect(await transport.identity('me', signal)).toBeNull()
  await expect(transport.identity('me', signal)).rejects.toThrow('Invalid employee response')
})
it('revokes through the explicit empty-body mutation and never interprets an error as success', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ signedOut: true }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
  vi.stubGlobal('fetch', send)
  const transport = createTransport(fixture().remote), signal = new AbortController().signal
  expect(await transport.identity('sign-out', signal)).toBeNull()
  expect(send.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{}', credentials: 'same-origin' })
  await expect(transport.identity('sign-out', signal)).rejects.toThrow('Request unavailable')
})
it('exports only the explicitly selected resource without a path or token query', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('exact draft body', { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
  vi.stubGlobal('fetch', send)
  const transport = createTransport(fixture().remote), signal = new AbortController().signal
  const blob = await transport.download({ artifactId, target: 'draft' }, signal)
  expect(await blob.text()).toBe('exact draft body')
  expect(send.mock.calls[0]?.[0]).toBe(`api/education/artifacts.exportText?artifactId=${artifactId}&target=draft`)
  send.mockResolvedValue(new Response('version', { headers: { 'content-type': 'text/plain' } }))
  await transport.download({ artifactId, target: 'version', versionId }, signal)
  expect(send.mock.calls[1]?.[0]).toBe(`api/education/artifacts.exportText?artifactId=${artifactId}&target=version&versionId=${versionId}`)
  expect(send.mock.calls[1]?.[1]).toEqual({ signal, credentials: 'same-origin', cache: 'no-store' })
})
it('rejects unauthenticated and non-text export responses', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ body: 'not an export' }))
  vi.stubGlobal('fetch', send)
  const transport = createTransport(fixture().remote), signal = new AbortController().signal
  await expect(transport.download({ artifactId, target: 'draft' }, signal)).rejects.toMatchObject({ code: 'education/UNAUTHENTICATED' })
  await expect(transport.download({ artifactId, target: 'draft' }, signal)).rejects.toThrow('Invalid text download')
})
