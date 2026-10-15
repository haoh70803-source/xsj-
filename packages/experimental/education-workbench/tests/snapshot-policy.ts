/** Recorded-session adapter for the same complete content policy used by the business HTTP application. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { applyContentPolicy } from '../src/policy.ts'

export const name = 'education-snapshot-policy'
export const inject = ['agents', 'tools', 'systemPrompt']

/** @param ctx - profile context. Apply the production content policy before the first turn. */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    applyContentPolicy(agent.ctx)
  })
}
