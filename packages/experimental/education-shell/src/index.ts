/** Host metadata and configurable synchronization limits for the native employee panel. */
export { Config } from './configuration.ts'
import type { Context } from '@deepseek-ai/cordis'
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-side activation marker consumed by the employee profile readiness audit. */ educationShellReady: true
  }
}
/** Browser behavior is discovered through dsh.client. */
export function apply(ctx: Context): void {
  ctx.provide('educationShellReady', true)
}
