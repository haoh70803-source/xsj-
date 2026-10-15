/** Keyless recorded-session adapter for the production source-only research rules. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { applyResearchPolicy } from '../src/research-policy.ts'
export const name = 'education-research-snapshot-policy'
export const inject = ['agents', 'tools', 'systemPrompt']
/** @param ctx - shipped headless profile. Install the complete owning policy before any user turn. */
export function apply(ctx: Context): void { ctx.on('agent/created', ({ agent }) => { applyResearchPolicy(agent.ctx) }) }
