/** Synthetic durable-budget tests perform no provider or model network calls. */
import type { RequestId } from '@deepseek-ai/dsh-experimental-education-platform/types'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { missingMetrics } from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  QuotaLimits,
  SyncParameters,
  ContentAccountId,
  SyncRunId,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { stageFixture } from './stage-fixture.ts'
import { digest, newId } from '../src/codec.ts'

let f: Awaited<ReturnType<typeof stageFixture>>
const parameters: SyncParameters = {
  poolId: 'synthetic-pool',
  mode: 'latest',
  recentCount: 5,
  window: null,
  maxPages: 3,
  maxCalls: 10,
  sortType: 'publish',
  mappingVersion: 'test-v1',
  verifiedOrder: false,
  fetchDetails: false,
  maxRetries: 1,
  retryDelayMs: 0,
}
const limits: QuotaLimits = {
  poolId: parameters.poolId,
  timeZone: 'Asia/Shanghai',
  resumeEpoch: '1',
  maxCalls: 10,
  maxCallsPerDay: 10,
  maxCallsPerAccount: 10,
  maxCostMicros: null,
  accountCostMicros: null,
  worksCostMicros: null,
  contentCostMicros: null,
}
beforeEach(async () => {
  f = await stageFixture()
  f.repository.sync.configureQuota(limits)
})
afterEach(() => {
  f?.close()
})
function account(externalId = 'synthetic') {
  return f.repository.analytics.createAccount(f.a, {
    platform: 'douyin',
    externalId,
    title: '合成账号',
    requestId: newId<RequestId>(),
  }).accountId
}
function run(accountId = account()) {
  return f.repository.sync.request(f.a, { accountId, mode: 'latest', requestId: newId<RequestId>() }, parameters)
}
function call(runId: SyncRunId, accountId = 'synthetic', retry = 0) {
  return f.repository.sync.reserveCall(runId, { operation: 'account', platform: 'douyin', accountId }, retry)
}
function complete(runId: SyncRunId, externalId = 'synthetic') {
  const work = f.repository.sync.claim(runId)!
  const reservation = call(runId, externalId)
  f.repository.sync.markSent(runId, reservation.id)
  f.repository.sync.commitCall(
    runId,
    reservation.id,
    { kind: 'account', fields: missingMetrics(), sourceDataAt: null, aliases: [], observedFields: [] },
    { ...work.checkpoint, phase: 'done', coverage: 'complete' },
    null,
    digest('synthetic'),
  )
  f.repository.sync.finish(runId, 'completed', null)
}
it('coalesces active scopes and preserves each original request after completion', () => {
  const accountId = account(),
    first = { accountId, mode: 'latest' as const, requestId: newId<RequestId>() },
    second = { ...first, requestId: newId<RequestId>() }
  const a = f.repository.sync.request(f.a, first, parameters),
    b = f.repository.sync.request(f.a, second, parameters)
  expect(b.id).toBe(a.id)
  complete(a.id)
  expect(f.repository.sync.request(f.a, second, parameters)).toMatchObject({ id: a.id, status: 'completed' })
  expect(() => f.repository.sync.request(f.a, { ...second, mode: 'seven-days' }, parameters)).toThrow(
    'different parameters',
  )
  expect(f.inspect.prepare('SELECT COUNT(*) AS n FROM provider_calls').get()?.n).toBe(1)
})
it('atomically enforces one shared pool across accounts and retains unknown reservations', () => {
  f.repository.sync.configureQuota({ ...limits, maxCalls: 1 })
  const a = run(),
    b = run(account('other'))
  f.repository.sync.claim(a.id)
  f.repository.sync.claim(b.id)
  const reservation = call(a.id)
  f.repository.sync.markSent(a.id, reservation.id)
  f.repository.sync.failCall(a.id, reservation.id, 'timeout', 'unknown')
  f.repository.sync.finish(a.id, 'failed', 'timeout')
  expect(f.repository.sync.get(f.a, a.id).status).toBe('unknown')
  expect(() => call(b.id, 'other')).toThrow('budget')
  f.repository.sync.configureQuota({ ...limits, maxCalls: 1, resumeEpoch: '2' })
  expect(() => call(b.id, 'other')).toThrow('budget')
})
it('does not treat unknown operation prices as zero under a money cap', () => {
  f.repository.sync.configureQuota({ ...limits, maxCostMicros: 100 })
  const a = run()
  f.repository.sync.claim(a.id)
  expect(() => call(a.id)).toThrow('pricing is unknown')
  f.repository.sync.configureQuota({ ...limits, maxCostMicros: 100, accountCostMicros: 60 })
  const first = call(a.id)
  f.repository.sync.markSent(a.id, first.id)
  f.repository.sync.failCall(a.id, first.id, 'server', 'response-received')
  expect(() => call(a.id, 'synthetic', 1)).toThrow('budget')
  expect(f.inspect.prepare('SELECT actual_cost_micros FROM provider_calls').get()?.actual_cost_micros).toBeNull()
})

it('refuses a later money cap when prior possibly charged calls have no confirmed reservation price', () => {
  const a = run(); f.repository.sync.claim(a.id)
  const first = call(a.id); f.repository.sync.markSent(a.id, first.id); f.repository.sync.failCall(a.id, first.id, 'server', 'response-received')
  f.repository.sync.configureQuota({ ...limits, maxCostMicros: 1000, accountCostMicros: 10 })
  expect(() => call(a.id, 'synthetic', 1)).toThrow('pricing is unknown')
  expect(f.inspect.prepare('SELECT reserved_cost_micros FROM provider_calls').get()?.reserved_cost_micros).toBeNull()
})
it('settles a known response separately and reserves every retry; refuses a duplicate sent request', () => {
  const a = run()
  f.repository.sync.claim(a.id)
  const first = call(a.id)
  expect(call(a.id).id).toBe(first.id)
  f.repository.sync.markSent(a.id, first.id)
  expect(() =>{  f.repository.sync.markSent(a.id, first.id) }).toThrow('already sent')
  f.repository.sync.failCall(a.id, first.id, 'rate-limited', 'response-received')
  expect(call(a.id, 'synthetic', 1).id).not.toBe(first.id)
  expect(() => call(a.id, 'synthetic', 2)).toThrow('retry limit')
})
it('releases only requests proved not dispatched and pauses authentication until an explicit resume epoch', () => {
  const a = run()
  f.repository.sync.claim(a.id)
  const first = call(a.id)
  f.repository.sync.failCall(a.id, first.id, 'not-configured', 'not-dispatched')
  f.repository.sync.configureQuota({ ...limits, maxCalls: 1 })
  const second = call(a.id, 'synthetic', 1)
  f.repository.sync.markSent(a.id, second.id)
  f.repository.sync.failCall(a.id, second.id, 'authentication', 'response-received')
  f.repository.sync.configureQuota({ ...limits, maxCalls: 3 })
  expect(() => call(a.id)).toThrow('maintainer review')
  f.repository.sync.configureQuota({ ...limits, resumeEpoch: 'reviewed-rotation' })
  expect(call(a.id).status).toBe('reserved')
})
it('commits page observations and checkpoint together, rolling both back on failure', () => {
  const a = run(),
    work = f.repository.sync.claim(a.id)!,
    reservation = call(a.id)
  f.repository.sync.markSent(a.id, reservation.id)
  f.inspect.exec(
    "CREATE TRIGGER synthetic_fail_checkpoint BEFORE UPDATE OF checkpoint_json ON sync_runs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  )
  const commit = () =>{
    f.repository.sync.commitCall(
      a.id,
      reservation.id,
      { kind: 'account', fields: missingMetrics(), sourceDataAt: null, aliases: [], observedFields: [] },
      { ...work.checkpoint, phase: 'works' },
      'test',
      digest('response'),
    ) }
  expect(commit).toThrow('storage')
  expect(f.inspect.prepare('SELECT COUNT(*) AS n FROM account_snapshots').get()?.n).toBe(0)
  expect(f.inspect.prepare('SELECT status FROM provider_calls').get()?.status).toBe('sent')
  f.inspect.exec('DROP TRIGGER synthetic_fail_checkpoint')
  commit()
  expect(f.repository.sync.work(a.id).checkpoint.phase).toBe('works')
  expect(() =>{  f.repository.sync.finish(a.id, 'completed', null) }).toThrow('not a completed')
})
it('reconciles process interruption without resending unknown work or losing confirmed pages', () => {
  const a = run(),
    b = run(account('other'))
  f.repository.sync.claim(a.id)
  f.repository.sync.claim(b.id)
  const first = call(a.id)
  f.repository.sync.markSent(a.id, first.id)
  call(b.id, 'other')
  f.repository.sync.interruptPending()
  expect(f.repository.sync.get(f.a, a.id).status).toBe('unknown')
  expect(f.repository.sync.recoverable()).toEqual([b.id])
  expect(f.repository.sync.claim(b.id)?.checkpoint.phase).toBe('account')
  expect(f.repository.sync.claim(a.id)).toBeNull()
  f.repository.sync.allowUnknownRetry(f.a, a.id)
  expect(run(a.accountId).id).not.toBe(a.id)
  expect(f.inspect.prepare('SELECT status FROM provider_calls WHERE run_id=?').get(a.id)?.status).toBe('unknown')
})
it('reauthorizes before dispatch and observation commit and never exposes native handles', () => {
  const accountId = account(),
    a = run(accountId)
  f.repository.sync.claim(a.id)
  const reservation = call(a.id)
  f.repository.analytics.setEnabled(f.a, { accountId, enabled: false, expectedRevision: 1, requestId: newId<RequestId>() })
  expect(() =>{  f.repository.sync.markSent(a.id, reservation.id) }).toThrow('authority')
  expect(f.repository.sync.get(f.a, a.id)).not.toHaveProperty('sessionId')
  expect(() => f.repository.sync.get(f.b, a.id)).toThrow('unavailable')
})
function schedule(accountId: ContentAccountId) {
  const ack = f.repository.sync.saveSchedule(f.a, {
    accountId,
    enabled: true,
    hour: 0,
    minute: 1,
    timeZone: 'Asia/Shanghai',
    expectedRevision: 0,
    requestId: newId<RequestId>(),
  })
  if (ack.operation !== 'schedules.save') throw new Error('bad test acknowledgement')
  f.inspect
    .prepare('UPDATE analytics_schedules SET next_at=? WHERE id=?')
    .run(new Date(Date.now() - 1).toISOString(), ack.scheduleId)
  return ack.scheduleId
}
it('daily plans survive logout, claim at most once locally and stop immediately when disabled', () => {
  const accountId = account(),
    scheduleId = schedule(accountId),
    at = new Date().toISOString()
  f.repository.revokeLoginSession(f.a.loginSessionId)
  const runId = f.repository.sync.claimSchedule(scheduleId, at, parameters)!
  expect(runId).not.toBeNull()
  expect(f.repository.sync.claimSchedule(scheduleId, at, parameters)).toBeNull()
  expect(f.repository.sync.claim(runId)?.authority.kind).toBe('schedule')
  f.inspect.prepare('UPDATE analytics_schedules SET enabled=0 WHERE id=?').run(scheduleId)
  expect(() => call(runId)).toThrow('revoked')
})
it('disables a due plan after business grant revocation without fabricating a login', () => {
  const accountId = account(),
    scheduleId = schedule(accountId)
  f.repository.analytics.setEnabled(f.a, { accountId, enabled: false, expectedRevision: 1, requestId: newId<RequestId>() })
  expect(f.repository.sync.claimSchedule(scheduleId, new Date().toISOString(), parameters)).toBeNull()
  expect(f.repository.sync.readSchedule(f.a, accountId)?.enabled).toBe(false)
  expect(f.inspect.prepare('SELECT COUNT(*) AS n FROM sync_runs').get()?.n).toBe(0)
})
it('defers a daily plan while the same foreground scope is active instead of issuing duplicate charges', () => {
  const accountId = account(),
    active = run(accountId),
    scheduleId = schedule(accountId),
    at = new Date().toISOString()
  expect(f.repository.sync.claimSchedule(scheduleId, at, parameters)).toBeNull()
  complete(active.id)
  expect(f.repository.sync.claimSchedule(scheduleId, new Date().toISOString(), parameters)).not.toBeNull()
})
