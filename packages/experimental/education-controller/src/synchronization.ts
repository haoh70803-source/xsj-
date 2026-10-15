/** Native Agent/Job owns provider work; business authority, receipts and charges remain in SQLite. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-experimental-education-identity'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'
import type {
  ActorContext,
  ContentPlatform,
  DataProviderRequest,
  EducationDataProvider,
  NormalizedProviderResult,
  RequestSyncInput,
  SyncCheckpoint,
  SyncRun,
  SyncRunId,
  SyncWork,
} from '@deepseek-ai/dsh-experimental-education-platform'
import type { JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { analyticsParameters, type AnalyticsConfig } from './analytics-config.ts'
import { normalizeRedFox } from './redfox-normalize.ts'
import { RedFoxError } from './redfox.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    educationSync: 'education-sync'
  }
}
interface Running {
  readonly abort: AbortController
  readonly authority: SyncWork['authority']
  done: Promise<void>
}

/** Bounded data worker with no Agent followup, no model turn and no automatic unknown-result replay. */
export class SynchronizationRuntime {
  private readonly running = new Map<SyncRunId, Running>()
  private closed = false
  private ticking = false
  constructor(
    private readonly ctx: Context,
    readonly config: AnalyticsConfig,
    private readonly provider: EducationDataProvider,
  ) {
    ctx.educationRepository.sync.configureQuota(config.quota)
    ctx.educationRepository.sync.interruptPending()
    ctx.on('education-identity/revoked', (session) => {
      for (const run of this.running.values())
        if (run.authority.kind === 'login' && run.authority.actor.loginSessionId === session) run.abort.abort('logout')
    })
    ctx.effect(
      () =>
        ctx.educationRepository.analytics.onAccountCommit(() => {
          this.recheck()
        }),
      'education: sync grant observation',
    )
    const timer = setInterval(() => {
      void this.tick().catch((error: unknown) =>{  this.report(error) })
    }, config.schedulerIntervalMs)
    ctx.effect(
      () => async () => {
        this.closed = true
        clearInterval(timer)
        for (const run of this.running.values()) run.abort.abort('disposed')
        await Promise.allSettled([...this.running.values()].map(run => run.done))
      },
      'education: sync worker lifetime',
    )
    void this.tick().catch((error: unknown) =>{  this.report(error) })
  }
  /**
 * Report configured model availability without exposing credentials.
 * @returns deployment and credential availability without issuing a provider or model request.
 */
  async availability(): Promise<{ enabled: boolean; configured: boolean; platforms: readonly ContentPlatform[] }> {
    const platforms: ContentPlatform[] = (['douyin', 'xiaohongshu'] as const).filter(
      platform => this.config.sortTypes[platform] !== null,
    )
    return {
      enabled: this.config.enabled,
      configured:
        this.config.enabled &&
        platforms.length > 0 &&
        this.config.quota.maxCalls > 0 &&
        this.config.quota.maxCallsPerDay > 0 &&
        this.config.quota.maxCallsPerAccount > 0 &&
        (await this.provider.available()),
      platforms,
    }
  }
  /**
 * Return durable original or merged run, without waiting for a provider response.
 * @param actor - current employee.
 * @param input - explicit paid trigger.
 * @returns durable original or merged run, without waiting for a provider response.
 */
  async request(actor: ActorContext, input: RequestSyncInput): Promise<SyncRun> {
    const original = this.ctx.educationRepository.sync.find(actor, input.requestId)
    const account = this.ctx.educationRepository.analytics
      .listAccounts(actor)
      .find(item => item.id === input.accountId)
    if (account === undefined) throw new EducationError('resource-unavailable', 'account is unavailable')
    if (!account.permissions.sync || !account.enabled)
      throw new EducationError('resource-unavailable', 'sync authority is unavailable')
    if (original !== null) {
      if (original.accountId !== input.accountId || original.mode !== input.mode)
        throw new EducationError('idempotency-conflict', 'original sync parameters changed')
      return original
    }
    if (!(await this.availability()).configured || this.config.sortTypes[account.platform] === null)
      throw new EducationError('identity-unavailable', 'data provider has not been configured and authorized')
    if (this.isClosed()) throw new EducationError('closed', 'synchronization worker is closing')
    const run = this.ctx.educationRepository.sync.request(actor, input, this.parameters(input.mode, account.platform))
    this.launch(run.id)
    return run
  }
  /**
 * Stop the owned generation and preserve the last committed draft.
 * @param actor - current employee.
 * @param runId - original run.
 * @returns cancellation summary retaining any unknown charges.
 */
  cancel(actor: ActorContext, runId: SyncRunId): SyncRun {
    const result = this.ctx.educationRepository.sync.cancel(actor, runId)
    this.running.get(runId)?.abort.abort('cancelled')
    return result
  }
  /** Immediately enforce business revocation and schedule disablement in active workers. */
  recheck(): void {
    for (const [id, running] of this.running) {
      try {
        const work = this.ctx.educationRepository.sync.work(id)
        if (work.run.status !== 'running') running.abort.abort('ownership-changed')
      } catch (error) {
        if (
          error instanceof EducationError &&
          ['forbidden', 'unauthenticated', 'resource-unavailable'].includes(error.code)
        )
          running.abort.abort('authority-revoked')
        else this.report(error)
      }
    }
  }
  private parameters(mode: SyncRun['mode'], platform: ContentPlatform) {
    if (this.config.sortTypes[platform] === null)
      throw new EducationError('identity-unavailable', 'platform ordering capability is not configured')
    return analyticsParameters(this.config, mode, platform)
  }
  private async tick(): Promise<void> {
    if (this.isClosed() || this.ticking) return
    this.ticking = true
    try {
      this.recheck()
      if (!(await this.availability()).configured || this.isClosed()) return
      for (const scheduleId of this.ctx.educationRepository.sync.dueSchedules(new Date().toISOString())) {
        if (this.running.size >= this.config.maxConcurrentRuns) break
        const platform = this.ctx.educationRepository.sync.schedulePlatform(scheduleId)
        if (this.config.sortTypes[platform] === null) continue
        const runId = this.ctx.educationRepository.sync.claimSchedule(
          scheduleId,
          new Date().toISOString(),
          this.parameters('latest', platform),
        )
        if (runId !== null) this.launch(runId)
      }
      for (const id of this.ctx.educationRepository.sync.recoverable()) {
        if (this.running.size >= this.config.maxConcurrentRuns) break
        this.launch(id)
      }
    } finally {
      this.ticking = false
    }
  }
  private launch(id: SyncRunId): void {
    if (this.isClosed() || this.running.has(id) || this.running.size >= this.config.maxConcurrentRuns) return
    let work: SyncWork | null
    try {
      work = this.ctx.educationRepository.sync.claim(id)
    } catch (error) {
      this.ctx.educationRepository.sync.finish(
        id,
        'cancelled',
        error instanceof EducationError ? error.code : 'internal',
      )
      this.report(error)
      return
    }
    if (work === null) return
    const run: Running = { abort: new AbortController(), authority: work.authority, done: Promise.resolve() }
    this.running.set(id, run)
    run.done = this.execute(work, run)
      .catch((error: unknown) =>{  this.report(error) })
      .finally(() => {
        this.running.delete(id)
      })
  }
  private async execute(work: SyncWork, running: Running): Promise<void> {
    const timer = setTimeout(() => {
      running.abort.abort('deadline')
    }, this.config.runTimeoutMs)
    let handle: Awaited<ReturnType<Context['agents']['create']>> | undefined
    let detach: (() => void) | undefined
    try {
      handle = await this.ctx.agents.create({
        sessionId: SessionId(
          `education-sync-${work.run.id}-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 12)}`,
        ),
      })
      running.abort.signal.throwIfAborted()
      const native = this.ctx
      detach = native.jobs.attachController('education-sync')
      const jobId = native.jobs.start({
        kind: 'education-sync',
        owner: handle.agent.id,
        label: 'Authorized account synchronization',
        run: job => ({
          cancel: () => {
            running.abort.abort('native-job-cancelled')
          },
          done: this.produce(work.run.id, running.abort.signal, job),
        }),
      })
      this.ctx.educationRepository.sync.attachNative(work.run.id, jobId, handle.agent.id)
      // Wait for registry settlement before disposing its owner; disposing from inside done would wait on itself.
      let view = await native.jobs.wait(jobId, 60_000, handle.agent.id)
      while (view.status === 'running' || view.status === 'stopping')
        view = await native.jobs.wait(jobId, 60_000, handle.agent.id)
      await this.ctx.sessions.flush(handle.agent.session)
    } catch (error) {
      this.ctx.educationRepository.sync.finish(
        work.run.id,
        running.abort.signal.aborted ? 'cancelled' : 'failed',
        error instanceof EducationError ? error.code : 'native-owner-failed',
      )
      this.report(error)
    } finally {
      clearTimeout(timer)
      detach?.()
      await handle?.dispose()
    }
  }
  private async produce(runId: SyncRunId, signal: AbortSignal, job: JobHandle): Promise<JobOutcome> {
    const repository = this.ctx.educationRepository.sync
    try {
      while (true) {
        signal.throwIfAborted()
        const work = repository.work(runId),
          checkpoint = work.checkpoint
        if (checkpoint.phase === 'done') {
          repository.finish(runId, checkpoint.coverage === 'complete' ? 'completed' : 'partial', null)
          return { status: 'completed' }
        }
        const request = nextRequest(work),
          reservation = repository.reserveCall(runId, request, checkpoint.retry)
        if (reservation.status !== 'reserved')
          throw new EducationError('result-unknown', 'settled provider call cannot be silently repeated')
        const dispatch = { sent: false }
        try {
          job.updateProgress(`${checkpoint.phase}: ${checkpoint.pages}`)
          const reply = await this.provider.request(
            request,
            () => {
              signal.throwIfAborted()
              repository.markSent(runId, reservation.id)
              dispatch.sent = true
            },
            signal,
          )
          const result = normalizeRedFox(
            request,
            reply.data,
            this.config.sourceTimeZone,
            this.config.maxItemsPerPage,
            checkpoint.accountAliases,
          )
          const next = nextCheckpoint(work, result)
          repository.commitCall(
            runId,
            reservation.id,
            result,
            next,
            reply.requestId,
            createHash('sha256').update(JSON.stringify(reply.data)).digest('hex'),
          )
        } catch (error) {
          const delivery = error instanceof RedFoxError ? error.delivery : dispatch.sent ? 'unknown' : 'not-dispatched'
          const code = error instanceof RedFoxError || error instanceof EducationError ? error.code : 'internal'
          const retry =
            error instanceof RedFoxError &&
            delivery === 'response-received' &&
            ['rate-limited', 'server'].includes(code) &&
            checkpoint.retry < work.parameters.maxRetries &&
            !signal.aborted
          repository.failCall(
            runId,
            reservation.id,
            code,
            delivery,
            retry ? { ...checkpoint, retry: checkpoint.retry + 1 } : undefined,
          )
          if (!retry) throw error
          await pause(work.parameters.retryDelayMs, signal)
        }
      }
    } catch (error) {
      const code =
        error instanceof RedFoxError || error instanceof EducationError
          ? error.code
          : signal.aborted
            ? 'cancelled'
            : 'internal'
      repository.finish(runId, signal.aborted ? 'cancelled' : code === 'quota-exceeded' ? 'partial' : 'failed', code)
      return { status: signal.aborted ? 'killed' : 'failed', detail: code }
    }
  }
  private isClosed(): boolean { return this.closed }
  private report(error: unknown): void {
    this.ctx.logger.warn(
      'Education synchronization: %s',
      error instanceof EducationError || error instanceof RedFoxError
        ? error.code
        : error instanceof Error
          ? error.name
          : 'internal',
    )
  }
}

function nextRequest(work: SyncWork): DataProviderRequest {
  const { checkpoint, account, parameters } = work
  if (checkpoint.phase === 'account')
    return { operation: 'account', platform: account.platform, accountId: account.externalId }
  if (checkpoint.phase === 'works')
    return {
      operation: 'works',
      platform: account.platform,
      accountId: account.externalId,
      offset: checkpoint.nextOffset,
      sortType: parameters.sortType,
    }
  const externalId = checkpoint.detailIds[checkpoint.detailIndex]
  if (checkpoint.phase !== 'details' || externalId === undefined)
    throw new EducationError('storage-unavailable', 'committed detail position is invalid')
  return { operation: 'content', platform: account.platform, externalId }
}
function nextCheckpoint(work: SyncWork, result: NormalizedProviderResult): SyncCheckpoint {
  const previous = work.checkpoint,
    fixed = work.parameters
  if (result.kind === 'account') return { ...previous, phase: 'works', accountAliases: result.aliases, retry: 0 }
  if (result.kind === 'content')
    return {
      ...previous,
      detailIndex: previous.detailIndex + 1,
      phase: previous.detailIndex + 1 >= previous.detailIds.length ? 'done' : 'details',
      retry: 0,
    }
  const detailIds = [
    ...new Set([
      ...previous.detailIds,
      ...result.items.filter(item => item.kind === 'video').map(item => item.externalId),
    ]),
  ]
  const exhausted = result.hasMore === false
  const progress =
    result.nextOffset !== null &&
    result.nextOffset > previous.nextOffset &&
    !previous.seenOffsets.includes(result.nextOffset)
  const bounded = previous.pages + 1 >= fixed.maxPages
  const stop = exhausted || bounded || !progress
  return {
    ...previous,
    phase: stop ? (fixed.fetchDetails && detailIds.length > 0 ? 'details' : 'done') : 'works',
    nextOffset: result.nextOffset ?? previous.nextOffset,
    pages: previous.pages + 1,
    contents: previous.contents + result.items.length,
    seenOffsets: [...previous.seenOffsets, previous.nextOffset],
    detailIds,
    retry: 0,
    coverage: exhausted ? 'complete' : stop ? 'partial' : 'unknown',
  }
}
async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer)
      reject(new DOMException('Synchronization cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', stop, { once: true })
  })
}
