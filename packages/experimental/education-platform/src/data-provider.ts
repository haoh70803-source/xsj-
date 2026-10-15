/** Host-only external-data operations; authorization and durable budgets belong to the consumer. */

/** Platforms whose account and content mappings are separately verified. */
export type ContentPlatform = 'douyin' | 'xiaohongshu'

/** Explicit provider operation. Page ordering is a selected capability, never an automatic paid fallback. */
export type DataProviderRequest =
  | { readonly operation: 'account'; readonly platform: ContentPlatform; readonly accountId: string }
  | {
    readonly operation: 'works'
    readonly platform: ContentPlatform
    readonly accountId: string
    readonly offset: number
    readonly sortType: string
  }
  | { readonly operation: 'content'; readonly platform: ContentPlatform; readonly externalId: string }

/** Validated supplier envelope; the owning platform mapper validates its endpoint-specific data. */
export interface DataProviderReply {
  readonly data: unknown
  readonly requestId: string | null
  readonly providerCode: string
}

/** Request delivery knowledge controls whether the consumer may release its persisted reservation. */
export type ProviderDelivery = 'not-dispatched' | 'response-received' | 'unknown'

/** Handling-relevant supplier failures; raw supplier prose and secrets are never public diagnostics. */
export type DataProviderErrorCode =
  | 'not-configured'
  | 'authentication'
  | 'quota'
  | 'rate-limited'
  | 'invalid-request'
  | 'not-covered'
  | 'server'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'invalid-response'
  | 'response-too-large'

/** Explicit external-data provider; calling code must authorize and reserve before dispatch. */
export interface EducationDataProvider {
  /**
   * Check the selected reference without enumerating the credential store or issuing network requests.
   * @returns whether the selected credential currently resolves.
   */
  available(): Promise<boolean>
  /**
   * Execute one externally metered request with no implicit retry or alternate endpoint.
   * @param input - server-selected, validated account/endpoint parameters.
   * @param beforeDispatch - persist the sent state and recheck authority immediately before network execution; throwing prevents dispatch.
   * @param signal - owning run lifetime, including cancellation and revocation.
   * @returns a complete bounded supplier envelope; failure never claims zero cost after dispatch.
   */
  request(input: DataProviderRequest, beforeDispatch: () => void, signal: AbortSignal): Promise<DataProviderReply>
}
