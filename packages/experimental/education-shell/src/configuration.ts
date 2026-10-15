/** Face-neutral limits projected to the browser by the selected plugin entry. */
import Schema from '@deepseek-ai/schemastery'
/** Browser timing and controlled text-import limits. */
export const Config = Schema.object({
  autoSyncDelayMs: Schema.number().step(1).min(100).max(60_000).default(800),
  runPollIntervalMs: Schema.number().step(1).min(100).max(30_000).default(500),
  contextRefreshIntervalMs: Schema.number().step(1).min(500).max(60_000).default(2000),
  maxTextFileBytes: Schema.number().step(1).min(1).max(2_000_000).default(1_048_576),
})
