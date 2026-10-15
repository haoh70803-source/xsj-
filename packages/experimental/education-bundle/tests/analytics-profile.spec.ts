/** Real named employee Profile with an explicitly synthetic loopback supplier; model requests must remain zero. */
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { EmployeeFixture } from './employee-fixture.ts'
import type {
  AnalyticsDataset,
  AnalyticsWriteResult,
  ContentAccountId,
  SyncRun,
  AnalyticsSchedule,
} from '@deepseek-ai/dsh-experimental-education-platform/types'

const owned: { fixture: EmployeeFixture; server: Server }[] = []
afterEach(async () => {
  for (const { fixture, server } of owned.splice(0)) {
    await fixture.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) =>{ error ? reject(error) : resolve() }))
  }
})
async function prepare(rateLimited = false) {
  const paths: string[] = [],
    server = createServer(async (request, response) => {
      let size = 0
      for await (const chunk of request) size += Buffer.byteLength(chunk)
      if (size > 2048) {
        response.writeHead(413)
        response.end()
        return
      }
      paths.push(request.url ?? '')
      const limited = rateLimited && paths.length === 2
      const data = request.url?.endsWith('queryUser')
        ? { uid: 'synthetic-account', followers: 0, totalLikes: 1000, workCount: 2 }
        : {
          list: [
            {
              awemeId: 'synthetic-video',
              awemeType: 0,
              create_time: Math.floor(Date.now() / 1000) - 86_400,
              title: '合成作品',
              statistics: { digg_count: 0, comment_count: null },
            },
            {
              awemeId: 'synthetic-image',
              awemeType: 68,
              create_time: Math.floor(Date.now() / 1000) - 86_400,
              title: '合成图文',
              statistics: { digg_count: 99 },
            },
          ],
          hasMore: false,
        }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: limited ? 4004 : 2000, data: limited ? null : data }))
    })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('synthetic server has no address')
  const fixture = await EmployeeFixture.create()
  owned.push({ fixture, server })
  const policy = {
    enabled: true,
    baseUrl: `http://127.0.0.1:${address.port}/`,
    allowLoopback: true,
    credentialRef: 'EDUCATION_NATIVE_TEST_KEY',
    sortTypes: { douyin: 'synthetic-publish' },
    maxRetries: rateLimited ? 1 : 0,
    retryDelayMs: 0,
    schedulerIntervalMs: 100,
    quota: { poolId: 'synthetic-shared', maxCalls: 8, maxCallsPerDay: 8, maxCallsPerAccount: 8 },
  }
  const patch = `- id: education-controller\n  config:\n    analytics: ${JSON.stringify(policy)}\n`
  await fixture.start(patch)
  const cookie = await fixture.login()
  const diagnostic = await fetch(`${fixture.origin}/fixture/runtime`, {
    headers: { 'x-fixture-owner': 'synthetic-host-test' },
  }).then(response => response.json())
  expect(diagnostic, JSON.stringify(diagnostic) + fixture.startupLog()).toMatchObject({
    jobs: true,
    agents: true,
    sessions: true,
    sync: true,
    enabled: true,
  })
  expect({ diagnostic, state: await fixture.rpc(cookie, 'analyticsAvailability', {}) }).toMatchObject({
    state: { enabled: true, configured: true, platforms: ['douyin'] },
  })
  const account = await fixture.rpc<AnalyticsWriteResult>(cookie, 'analyticsAccountCreate', {
    platform: 'douyin',
    externalId: 'synthetic-account',
    title: '合成测试账号',
    requestId: randomUUID(),
  })
  return { fixture, cookie, accountId: account.accountId, paths, patch }
}
async function settled(fixture: EmployeeFixture, cookie: string, runId: SyncRun['id']): Promise<SyncRun> {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    const run = await fixture.rpc<SyncRun>(cookie, 'analyticsSyncGet', { runId })
    if (!['pending', 'running'].includes(run.status)) {
      if (run.status !== 'completed') throw new Error(JSON.stringify(run) + fixture.startupLog())
      return run
    }
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('synthetic native data job did not settle')
}
const query = (accountId: ContentAccountId) => ({ accountId, source: 'redfox', mode: 'latest', keyword: '' })
it('reads without cost, merges concurrent explicit requests, persists real pages and performs zero model turns', async () => {
  const { fixture, cookie, accountId, paths } = await prepare()
  await fixture.rpc(cookie, 'analyticsQuery', query(accountId))
  await fixture.rpc(cookie, 'analyticsAvailability', {})
  expect(paths).toHaveLength(0)
  const request = { accountId, mode: 'latest', requestId: randomUUID() }
  const [a, b] = await Promise.all([
    fixture.rpc<SyncRun>(cookie, 'analyticsSyncRequest', request),
    fixture.rpc<SyncRun>(cookie, 'analyticsSyncRequest', { ...request, requestId: randomUUID() }),
  ])
  expect(a.id).toBe(b.id)
  expect(await settled(fixture, cookie, a.id)).toMatchObject({ status: 'completed', completedPages: 1 })
  const data = await fixture.rpc<AnalyticsDataset>(cookie, 'analyticsQuery', query(accountId))
  expect(data.overview?.fields.followers).toMatchObject({ value: 0, state: 'known' })
  expect(data.overview?.fields.totalLikes.value).toBe(1000)
  expect(data.analysis).toMatchObject({ medianLikes: 0, baselineCount: 1 })
  expect(data.analysis.images).toHaveLength(1)
  expect(paths).toHaveLength(2)
  expect((await fixture.rpc<SyncRun>(cookie, 'analyticsSyncRequest', request)).id).toBe(a.id)
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(fixture.upstream.requests).toHaveLength(0)
  const other = await fixture.login('employee-b')
  expect((await fixture.raw(other, 'education/analyticsQuery', query(accountId))).response.status).toBe(403)
}, 60_000)
it('reserves each bounded known-response retry without a second model runtime', async () => {
  const { fixture, cookie, accountId, paths } = await prepare(true)
  const run = await fixture.rpc<SyncRun>(cookie, 'analyticsSyncRequest', {
    accountId,
    mode: 'latest',
    requestId: randomUUID(),
  })
  expect(await settled(fixture, cookie, run.id)).toMatchObject({ status: 'completed' })
  expect(paths).toHaveLength(3)
  const db = new DatabaseSync(fixture.databasePath)
  try {
    expect(db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE status='confirmed'").get()?.n).toBe(3)
  } finally {
    db.close()
  }
  expect(fixture.upstream.requests).toHaveLength(0)
}, 60_000)
it('executes a persistent daily business grant after logout and restart, without fabricating a login or model turn', async () => {
  const { fixture, cookie, accountId, paths, patch } = await prepare()
  await fixture.rpc(cookie, 'analyticsScheduleSave', {
    accountId,
    enabled: true,
    hour: 6,
    minute: 0,
    timeZone: 'Asia/Shanghai',
    expectedRevision: 0,
    requestId: randomUUID(),
  })
  const logout = await fetch(`${fixture.origin}/education/auth/sign-out`, {
    method: 'POST',
    headers: { cookie, Origin: fixture.origin, 'content-type': 'application/json' },
    body: '{}',
  })
  expect(logout.ok).toBe(true)
  await fixture.stop()
  const db = new DatabaseSync(fixture.databasePath)
  try {
    db.prepare('UPDATE analytics_schedules SET next_at=? WHERE account_id=?').run(
      new Date(Date.now() - 1000).toISOString(),
      accountId,
    )
  } finally {
    db.close()
  }
  await fixture.start(patch)
  const nextCookie = await fixture.login(),
    end = Date.now() + 10_000
  let runs: readonly SyncRun[] = []
  while (Date.now() < end) {
    runs = await fixture.rpc<readonly SyncRun[]>(nextCookie, 'analyticsSyncList', { accountId })
    if (runs[0]) break
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  expect(runs[0]).toBeDefined()
  expect(await settled(fixture, nextCookie, runs[0]!.id)).toMatchObject({ status: 'completed' })
  expect(paths).toHaveLength(2)
  expect(fixture.upstream.requests).toHaveLength(0)
  const plan = await fixture.rpc<AnalyticsSchedule>(nextCookie, 'analyticsScheduleRead', { accountId })
  expect(plan.enabled).toBe(true)
  expect(plan.lastLocalDate).not.toBeNull()
}, 60_000)
