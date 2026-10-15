/** One bounded, tool-free native Agent interval, shared by writing and source-only research. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-education-identity'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {
  ActorContext,
  ArtifactId,
  ProjectId,
  RequestId,
} from '@deepseek-ai/dsh-experimental-education-platform/types'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'

/** Exact one-shot operation; the caller owns its durable run and overall deadline. */
export interface NativeContentOperation {
  readonly actor: ActorContext
  readonly projectId: ProjectId
  readonly artifactId: ArtifactId
  readonly requestId: RequestId
  readonly sessionId: SessionId
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly prompt: string
  readonly setup: (ctx: Context) => void
  readonly signal: AbortSignal
  readonly onBound: (sessionId: SessionId) => void
}

/**
 * Install a complete logged policy and prohibit all tool dispatch.
 * @param ctx - unpublished native Agent scope.
 * @param policy - exact model-visible rules owned by the calling feature.
 */
export function applyContentRules(ctx: Context, policy: string): void {
  ctx.effect(() => ctx.tools.restrict({ allow: [] }), 'education: no tools')
  ctx.effect(() => ctx.tools.guard(() => '内容处理不允许执行工具。'), 'education: deny tool dispatch')
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: policy,
        complete: true,
      }),
    'education: content rules',
  )
  ctx.systemPrompt.suppressRuntimeContext()
}

/**
 * Run exactly one controlled native interval; partial output is never a successful result.
 * @param ctx - selected native services and employee resource authorization.
 * @param operation - fixed prompt, private binding and run lifetime.
 * @returns the complete assistant output after durable Session flush; the adopted handle is always released.
 */
export async function runNativeContent(
  ctx: Context,
  operation: NativeContentOperation,
): Promise<{ readonly output: string; readonly sessionId: SessionId }> {
  operation.signal.throwIfAborted()
  const handle = await ctx.agents.create({
    sessionId: operation.sessionId,
    setup: operation.setup,
    agentOptions: { provider: operation.provider, model: operation.model, maxTokens: operation.maxTokens },
  })
  let bound = false,
    events: (() => void) | undefined,
    errors: (() => void) | undefined
  const stop = () => {
    handle.agent.cancel({ kind: 'hook', reason: 'content operation stopped' })
  }
  operation.signal.addEventListener('abort', stop, { once: true })
  try {
    operation.signal.throwIfAborted()
    await ctx.educationAuthorization.bindAgent(
      operation.actor,
      {
        projectId: operation.projectId,
        artifactId: operation.artifactId,
        harnessSessionId: handle.agent.id,
        requestId: operation.requestId,
      },
      handle,
    )
    bound = true
    operation.signal.throwIfAborted()
    operation.onBound(handle.agent.id)
    operation.signal.throwIfAborted()
    const observed: { output: string; reason: TurnEndReason | undefined; failed: boolean; steps: number } = {
      output: '',
      reason: undefined,
      failed: false,
      steps: 0,
    }
    events = ctx.on('session/event', (session, event) => {
      if (session !== handle.agent.session) return
      if (event.type === 'step/start' && ++observed.steps > 1) {
        observed.failed = true
        stop()
      }
      if (event.type === 'assistant/message' && !event.data.interrupted)
        observed.output = event.data.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n')
      if (event.type === 'turn/end') observed.reason = event.data.reason
    })
    errors = ctx.on('agent/error', ({ agent }) => {
      if (agent === handle.agent) observed.failed = true
    })
    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: operation.prompt }], source: { kind: 'user' } }),
    )
    await handle.agent.whenIdle()
    await ctx.sessions.flush(handle.agent.session)
    operation.signal.throwIfAborted()
    if (observed.failed || observed.reason?.kind !== 'completed')
      throw new EducationError('identity-unavailable', 'model did not finish a complete content result')
    return { output: observed.output, sessionId: handle.agent.id }
  } finally {
    operation.signal.removeEventListener('abort', stop)
    events?.()
    errors?.()
    if (bound) await ctx.educationAuthorization.releaseAgent(handle.agent.id)
    else await handle.dispose()
  }
}
