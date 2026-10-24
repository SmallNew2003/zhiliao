/**
 * Public types and Schemastery config for project service tools.
 * @module
 */
import z from '@deepseek-ai/schemastery'

/** Deployment policy and bounds for project service tools. */
export interface Config {
  /** Default log bytes read when max_bytes is omitted (default 16 KiB). */
  defaultMaxLogBytes?: number
  /** Hard cap on single log read bytes (default 16 KiB). */
  maxLogBytesCap?: number
  /** Default items per service list call (default 50). */
  defaultPageLimit?: number
  /** Maximum items per service list call (default 200). */
  maxPageLimit?: number
  /**
   * Stance on mutating `service_control` operations (default `'ask'`):
   * `'ask'` routes each operation through the host approval service, which
   * fails closed when no answerer is composed; `'never'` rejects every
   * mutating operation without asking anyone.
   */
  approvalPolicy?: 'ask' | 'never'
}

export const Config: z<Config> = z.object({
  defaultMaxLogBytes: z.number().min(1).default(16_384),
  maxLogBytesCap: z.number().min(1).default(16_384),
  defaultPageLimit: z.number().min(1).default(50),
  maxPageLimit: z.number().min(1).default(200),
  approvalPolicy: z.union(['ask', 'never'] as const).default('ask'),
})

/** Public projection of an observed service item for Agent reasoning. */
export interface PublicServiceItem {
  id: string
  name: string
  kind: 'native' | 'docker'
  state: 'running' | 'stopped' | 'starting' | 'unknown'
  ownership: 'managed' | 'external'
  checkoutId: string
  revision: string
  actions: string[]
  ports?: number[]
  detail?: string
  stale?: boolean
}

/** Public projection of a grouped service set (e.g. Compose stack). */
export interface PublicServiceGroup {
  id: string
  name: string
  checkoutId: string
  revision: string
  targetIds: string[]
  stale?: boolean
}

/** Output value returned by service_list. */
export interface PublicServiceListResult {
  project: { id: string; path: string }
  checkouts: { id: string; path: string; availability: string }[]
  items: PublicServiceItem[]
  groups: PublicServiceGroup[]
  providers: { id: string; kind: string; state: string; reason?: string }[]
  revision: string
  nextCursor?: string
}

/** Output value returned by service_logs. */
export interface PublicServiceLogsResult {
  chunks: { targetId: string; stream: string; text: string }[]
  nextCursor?: string
  truncated: boolean
  gap: boolean
  unavailable?: string
}

/**
 * Lifecycle state reported by `service_control`. `'unknown'` means the runtime
 * accepted the call but the current read policy denies reading its operation
 * status, so neither an outcome nor a pending flag is reported.
 */
export type PublicServiceControlState = 'running' | 'succeeded' | 'failed' | 'unknown'

/** Output value returned by service_control. */
export interface PublicServiceControlResult {
  action: string
  requestId: string
  operationId?: string
  state: PublicServiceControlState
  outcomes: { targetId: string; state: string; message?: string }[]
}
