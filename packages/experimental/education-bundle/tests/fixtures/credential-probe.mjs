/** Test-only Host credential changes; employee Remote APIs never mount this route. */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
export const name = 'education-native-credential-probe'
export const inject = ['credentials', 'webServer']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/fixture/runtime', handler: (req, res) => {
    if (req.headers['x-fixture-owner'] !== 'synthetic-host-test') { res.writeHead(403); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jobs: ctx.get('jobs') !== undefined, agents: ctx.get('agents') !== undefined, sessions: ctx.get('sessions') !== undefined,
      sync: ctx.get('educationController')?.synchronization !== undefined, enabled: ctx.get('educationController')?.analyticsPolicy?.enabled,
      controllerServices: ['agents','sessions','jobs','credentials'].map(name => [name, ctx.get('educationController')?.ctx?.get(name) !== undefined]) }))
  } }))
  console.log('EDUCATION_NATIVE_CREDENTIAL_PROBE_READY')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/fixture/credentials', handler: async (req, res) => {
    if (req.method !== 'POST' || req.headers['x-fixture-owner'] !== 'synthetic-host-test') { res.writeHead(403); res.end(); return }
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 1024) { res.writeHead(413); res.end(); return }; chunks.push(chunk) }
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const ref = credentialRef('EDUCATION_NATIVE_TEST_KEY')
      if (input.value === '') await ctx.credentials.unset(ref)
      else await ctx.credentials.set(ref, input.value)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"updated":true}')
    } catch { res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"updated":false}') }
  } }))
}
