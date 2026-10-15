/** Recorded-session adapter for the production native content rules and empty tool set. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { applyCreationPolicy } from '../src/policy.ts'

export const name = 'education-creation-snapshot-policy'
export const inject = ['agents', 'tools', 'systemPrompt']
/** Apply the production policy before a one-shot headless Agent receives its recorded input. */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    applyCreationPolicy(agent.ctx)
  })
}
