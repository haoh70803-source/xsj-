/** Employee identity deployment configuration; all secret values remain server-owned. */

/** Required organization and browser origin plus bounded authentication resources. */
export interface Config {
  /** Canonical UUID of the existing, active organization. */
  readonly organizationId: string
  /** Exact HTTP loopback or HTTPS browser origin, without path/query/credentials. */
  readonly publicOrigin: string
  /** Absolute login lifetime in milliseconds, 60000 through 604800000. @default 43200000 */
  readonly sessionLifetimeMs?: number
  /** Attempts per address and per normalized username in one window. @default 10 */
  readonly loginAttempts?: number
  /** Attempt window in milliseconds. @default 900000 */
  readonly loginWindowMs?: number
  /** Maximum concurrently active scrypt verifications. @default 4 */
  readonly maxConcurrentVerifications?: number
  /** Maximum unexpired throttle entries retained in memory. @default 10000 */
  readonly maxThrottleKeys?: number
  /** Maximum bytes buffered by an authentication HTTP request. @default 4096 */
  readonly maxAuthRequestBytes?: number
  /** Opt into native employee Peer admission; requires Connection's required-policy mode. @default false */
  readonly adaptConnection?: boolean
  /** Redirect anonymous document requests to the employee sign-in page. @default false */
  readonly loginShell?: boolean
  /** Maximum concurrent native employee login scopes. @default 1000 */
  readonly maxPeers?: number
  /** Idle Peer revalidation interval in milliseconds. @default 1000 */
  readonly peerSweepIntervalMs?: number
}

/** Defaults are applied before the provider is published. */
export type ResolvedConfig = Required<Config>
