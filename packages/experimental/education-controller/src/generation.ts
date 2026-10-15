/** One owner drives writing and research through the native Agent registry and the shared durable run store. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createHash } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-experimental-education-identity'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {
  ActorContext,
  CreationInputSnapshot,
  ResearchDocument,
  ResearchInputSnapshot,
  RunDTO,
  RunId,
  StartCreationInput,
  StartResearchInput,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import {
  EducationError,
  ResearchValidationError,
  validateResearchReport,
} from '@deepseek-ai/dsh-experimental-education-platform'
import { z } from 'zod'
import type { Config } from './types.ts'
import { applyCreationPolicy, CONTENT_POLICY, REFERENCE_POLICY, creationPrompt } from './policy.ts'
import { applyResearchPolicy, RESEARCH_POLICY, researchPrompt } from './research-policy.ts'
import { runNativeContent } from './native-content.ts'

interface Running {
  readonly actor: ActorContext
  readonly abort: AbortController
  done: Promise<void>
}
const responseSchema = z.strictObject({
  body: z.string().min(1),
  explanation: z.string(),
  sourceVersionIds: z.array(z.string()),
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** Own all logical run lifetimes; native credentials and each complete attempt remain provider-owned. */
export class GenerationRuntime {
  private readonly running = new Map<RunId, Running>()
  private closed = false
  private readonly policyIdentity: string
  private readonly researchPolicyIdentity: string
  constructor(
    private readonly ctx: Context,
    private readonly config: Required<Config>,
  ) {
    this.policyIdentity = `${config.policyVersion}:${hash(CONTENT_POLICY)}`
    this.researchPolicyIdentity = `content-research-v3.1-harness-v1:${hash(RESEARCH_POLICY)}`
    credentialRef(config.credentialRef)
    const interrupted = ctx.educationRepository.creation.interruptPending()
    if (interrupted) ctx.logger.warn('Unsettled education runs marked interrupted; no model request was replayed.')
    ctx.on('education-identity/revoked', (sessionId) => {
      for (const run of this.running.values())
        if (run.actor.loginSessionId === sessionId) run.abort.abort('identity-revoked')
    })
    ctx.effect(
      () => async () => {
        this.closed = true
        for (const run of this.running.values()) run.abort.abort('disposed')
        await Promise.allSettled([...this.running.values()].map(run => run.done))
      },
      'education-controller: generation lifecycle',
    )
  }
  /**
   * Check the selected route without exposing secrets or credential inventories.
   * @returns availability and the configured model route, without a model call.
   */
  async availability(): Promise<{ configured: boolean; provider: string; model: string }> {
    if (this.config.provider === 'deepseek-account') {
      const state = await this.ctx.get('deepseekAccount')?.getState()
      return {
        configured: state?.status === 'credential-stored',
        provider: this.config.provider,
        model: this.config.model,
      }
    }
    const configured = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef))
    return { configured: configured !== undefined, provider: this.config.provider, model: this.config.model }
  }
  /**
   * Start an owned writing operation with its original request identity.
   * @param actor - trusted current employee.
   * @param input - exact writing request and confirmed draft baseline.
   * @param ownerLifetime - initiating login lifetime; a network disconnect alone does not cancel.
   * @returns the original durable run while native execution proceeds outside the transaction.
   */
  start(actor: ActorContext, input: StartCreationInput, ownerLifetime?: AbortSignal): Promise<RunDTO> {
    if (!this.config.creationEnabled) throw new EducationError('identity-unavailable', 'writing is not enabled')
    return this.admit(
      actor,
      input.requestId,
      () => {
        const references = input.sourceVersionIds.some(versionId => this.ctx.educationRepository.knowledge.readSourceVersion(actor, versionId).purpose === 'reference-method')
        const policy = references ? `${this.config.policyVersion}:references:${hash(`${CONTENT_POLICY}\n\n${REFERENCE_POLICY}`)}` : this.policyIdentity
        return this.ctx.educationRepository.creation.start(actor, input, policy, this.config.maxInputBytes)
      },
      ownerLifetime,
    )
  }
  /**
   * Start source-only research without inferring a creator profile.
   * @param actor - trusted current employee.
   * @param input - source version, instruction and both report baselines.
   * @param ownerLifetime - initiating login lifetime.
   * @returns one durable run with bounded, fully logged repair attempts.
   */
  startResearch(actor: ActorContext, input: StartResearchInput, ownerLifetime?: AbortSignal): Promise<RunDTO> {
    if (!this.config.researchEnabled) throw new EducationError('identity-unavailable', 'research is not enabled')
    const execution = {
      provider: this.config.provider,
      model: this.config.model,
      maxTokens: this.config.researchMaxTokens,
      maxAttempts: this.config.researchMaxAttempts,
      timeoutMs: this.config.researchTimeoutMs,
    }
    return this.admit(
      actor,
      input.requestId,
      () =>
        this.ctx.educationRepository.research.start(
          actor,
          input,
          this.researchPolicyIdentity,
          execution,
          this.config.maxInputBytes,
        ),
      ownerLifetime,
    )
  }
  private async admit(
    actor: ActorContext,
    requestId: StartCreationInput['requestId'],
    register: () => RunDTO,
    ownerLifetime?: AbortSignal,
  ): Promise<RunDTO> {
    if (this.isClosed()) throw new EducationError('closed', 'generation runtime is unloading')
    const repository = this.ctx.educationRepository.creation
    if (repository.findRun(actor, requestId) !== null) return register()
    if (this.running.size >= this.config.maxConcurrentGenerations)
      throw new EducationError('rate-limited', 'generation capacity reached; retry later')
    if (!(await this.availability()).configured)
      throw new EducationError('identity-unavailable', 'model credential is not configured')
    if (this.isClosed()) throw new EducationError('closed', 'generation runtime is unloading')
    if (repository.findRun(actor, requestId) === null && this.running.size >= this.config.maxConcurrentGenerations)
      throw new EducationError('rate-limited', 'generation capacity reached; retry later')
    const result = register()
    if (!this.running.has(result.id) && result.status === 'pending') {
      const run: Running = { actor, abort: new AbortController(), done: Promise.resolve() }
      const revoked = () => {
        run.abort.abort('identity-revoked')
      }
      ownerLifetime?.addEventListener('abort', revoked, { once: true })
      if (ownerLifetime?.aborted) revoked()
      this.running.set(result.id, run)
      run.done = this.execute(result, run)
        .catch((error: unknown) => {
          this.ctx.logger.error(
            'Education finalization failed; keep the original request identity and inspect storage.',
            error instanceof Error ? error.name : 'unknown',
          )
        })
        .finally(() => {
          ownerLifetime?.removeEventListener('abort', revoked)
          this.running.delete(result.id)
        })
    }
    return result
  }
  /**
   * Stop an owned logical run and wait for native cleanup without publishing partial text.
   * @param actor - current trusted employee.
   * @param runId - original owned run.
   * @returns settled run with the last committed draft retained.
   */
  async cancel(actor: ActorContext, runId: RunId): Promise<RunDTO> {
    const repository = this.ctx.educationRepository.creation,
      prior = repository.getRun(actor, runId),
      active = this.running.get(runId)
    if (active !== undefined) {
      active.abort.abort('user')
      await active.done
    } else if (prior.status === 'pending' || prior.status === 'running')
      repository.fail(actor, runId, 'interrupted', 'process-interrupted')
    return repository.getRun(actor, runId)
  }
  private async execute(record: RunDTO, run: Running): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const repository = this.ctx.educationRepository.creation
    try {
      const input = repository.runInput(run.actor, record.id)
      timer = setTimeout(
        () => {
          run.abort.abort('timeout')
        },
        input.scenario === 'text-analysis' ? input.execution.timeoutMs : this.config.generationTimeoutMs,
      )
      run.abort.signal.throwIfAborted()
      if (input.scenario === 'text-analysis') await this.executeResearch(record, run, input)
      else await this.executeWriting(record, run, input)
    } catch (error) {
      const stop: unknown = run.abort.signal.reason
      const code = run.abort.signal.aborted
        ? String(stop)
        : error instanceof EducationError
          ? error.code
          : 'provider-failed'
      const status =
        stop === 'user' ? 'cancelled' : stop === 'disposed' || stop === 'identity-revoked' ? 'interrupted' : 'failed'
      repository.abandon(record.id, status, code)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  private boundPrompt(prompt: string, policy: string): void {
    if (Buffer.byteLength(prompt + policy) > this.config.maxInputBytes)
      throw new EducationError('validation-failed', 'complete model input exceeds its configured limit')
  }
  private async executeWriting(record: RunDTO, run: Running, input: CreationInputSnapshot): Promise<void> {
    const repository = this.ctx.educationRepository.creation,
      prompt = creationPrompt(input)
    const references = input.sources.some(source => source.purpose === 'reference-method')
    this.boundPrompt(prompt, references ? `${CONTENT_POLICY}\n\n${REFERENCE_POLICY}` : CONTENT_POLICY)
    const result = await runNativeContent(this.ctx, {
      actor: run.actor,
      projectId: record.projectId,
      artifactId: record.artifactId,
      requestId: record.requestId,
      sessionId: SessionId(`education-${record.id}`),
      provider: this.config.provider,
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      prompt,
      setup: (ctx) => { applyCreationPolicy(ctx, references) },
      signal: run.abort.signal,
      onBound: (sessionId) => {
        repository.markRunning(run.actor, record.id, sessionId)
      },
    })
    let json: unknown
    try {
      json = JSON.parse(result.output)
    } catch (error) {
      throw new EducationError('validation-failed', 'model response was not the required content object', {
        cause: error,
      })
    }
    const response = responseSchema.safeParse(json)
    if (
      !response.success ||
      response.data.sourceVersionIds.length > this.ctx.educationRepository.limits.maxPageSize ||
      response.data.sourceVersionIds.some(
        versionId => !input.sources.some(source => source.versionId === versionId),
      )
    )
      throw new EducationError('validation-failed', 'model response contains invalid content or source references')
    repository.complete(run.actor, record.id, response.data.body, response.data.explanation)
  }
  private async executeResearch(record: RunDTO, run: Running, input: ResearchInputSnapshot): Promise<void> {
    const research = this.ctx.educationRepository.research,
      creation = this.ctx.educationRepository.creation
    let errors: readonly string[] = []
    for (let attempt = 1; attempt <= input.execution.maxAttempts; attempt++) {
      const prompt = researchPrompt(input, errors)
      this.boundPrompt(prompt, RESEARCH_POLICY)
      const prepared = research.prepareAttempt(run.actor, record.id, attempt, hash(RESEARCH_POLICY + '\n' + prompt))
      if (prepared.status !== 'prepared')
        throw new EducationError(
          'identity-unavailable',
          'the original model attempt must be reconciled before any retry',
        )
      let output: string,
        sessionId: ReturnType<typeof SessionId> | null = null
      try {
        const result = await runNativeContent(this.ctx, {
          actor: run.actor,
          projectId: record.projectId,
          artifactId: record.artifactId,
          requestId: prepared.bindingRequestId,
          sessionId: SessionId(`education-${record.id}-research-${attempt}`),
          provider: input.execution.provider,
          model: input.execution.model,
          maxTokens: input.execution.maxTokens,
          prompt,
          setup: applyResearchPolicy,
          signal: run.abort.signal,
          onBound: (actual) => {
            sessionId = actual
            research.finishAttempt(run.actor, record.id, attempt, actual, 'running', [])
            creation.markRunning(run.actor, record.id, actual)
          },
        })
        output = result.output
      } catch (error) {
        research.abandonAttempt(record.id, attempt, [
          'native attempt interrupted or failed; no automatic transport retry',
        ])
        throw error
      }
      let report: ResearchDocument['report']
      try {
        let json: unknown
        try {
          json = JSON.parse(output)
        } catch (error) {
          throw new ResearchValidationError(['output: expected a complete JSON report object'], error)
        }
        report = validateResearchReport(json, input.input.evidence)
      } catch (error) {
        if (!(error instanceof ResearchValidationError)) throw error
        errors = error.issues
        research.finishAttempt(run.actor, record.id, attempt, sessionId, 'failed', errors)
        if (attempt < input.execution.maxAttempts) continue
        throw error
      }
      research.finishAttempt(run.actor, record.id, attempt, sessionId, 'completed', [])
      const document: ResearchDocument = {
        kind: 'research-report',
        version: 1,
        report,
        input: input.input,
        generated: {
          runId: record.id,
          policyVersion: input.policyVersion,
          provider: input.execution.provider,
          model: input.execution.model,
          createdAt: new Date().toISOString(),
        },
      }
      creation.complete(run.actor, record.id, JSON.stringify(document), report.overview.takeaway)
      return
    }
  }
  private isClosed(): boolean {
    return this.closed
  }
}
