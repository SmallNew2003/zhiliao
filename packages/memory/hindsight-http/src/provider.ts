/**
 * HTTP client for a hindsight memory daemon, and the `MemoryProvider` implementation
 * built on it. The provider speaks hindsight's `/v1/default` REST surface: bank listing
 * for workspace→bank resolution, hybrid recall for session openings and searches, and
 * document retention for finished sessions.
 *
 * Every call is bounded by a timeout and mapped onto the seam's error taxonomy, because
 * this backend answers by running LLM inference and can therefore stay silent far longer
 * than an agent turn tolerates.
 *
 * @module @deepseek-ai/dsh-memory-hindsight-http/provider
 */

import type {
  MemoryBankId,
  MemoryProvider,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRetainRequest,
  MemoryRetainResult,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryUnit,
} from '@deepseek-ai/dsh-memory'
import { MemoryError, memoryBankId, memoryId } from '@deepseek-ai/dsh-memory'

/** Transport and behaviour limits for {@link HindsightMemoryProvider}. */
export interface HindsightProviderLimits {
  /** Base URL of the daemon, without a trailing slash. */
  readonly baseUrl: string
  /** Bank id suffix for a workspace without a resolvable project name. */
  readonly defaultBankSuffix: string
  /** Timeout for cheap metadata endpoints (health, banks). */
  readonly metadataTimeoutMs: number
  /** How long a health-probe answer is reused before the next `available()` re-probes. */
  readonly probeTtlMs: number
  /** Timeout for recall/search, which run LLM inference server-side. */
  readonly recallTimeoutMs: number
  /** Timeout for retention. */
  readonly retainTimeoutMs: number
  /** Maximum characters of a retained transcript sent in one request. */
  readonly maxRetainChars: number
}

/** The shape of `GET /v1/default/banks` rows this provider reads. */
interface BankRow {
  readonly bank_id?: unknown
}

/** The shape of a `POST .../memories/recall` result row. */
interface RecallRow {
  readonly id?: unknown
  readonly text?: unknown
}

/** The shape of a recall response envelope. */
interface RecallResponse {
  readonly results?: unknown
}

/** The shape of a retention response envelope. */
interface RetainResponse {
  readonly success?: unknown
  readonly items_count?: unknown
  readonly operation_id?: unknown
}

/** Registry id of the hindsight-backed provider. */
export const HINDSIGHT_PROVIDER_ID = 'hindsight'

/**
 * A `MemoryProvider` backed by a hindsight daemon over HTTP.
 *
 * Availability is probed lazily and the answer is reused for a short window:
 * `available()` must be cheap because the agent hot path asks whether memory exists
 * before doing any work, but a process-lifetime cache would never notice a daemon that
 * stopped after the first probe.
 */
export class HindsightMemoryProvider implements MemoryProvider {
  readonly id: string

  private readonly limits: HindsightProviderLimits
  private probed: boolean | undefined
  private probedAt = 0
  private inFlight: Promise<boolean> | undefined

  constructor(limits: HindsightProviderLimits) {
    this.limits = limits
    this.id = HINDSIGHT_PROVIDER_ID
  }

  /**
   * Whether the daemon answered a health probe within the freshness window. The first
   * call probes; the answer is reused until `limits.probeTtlMs` elapses, after which the
   * next call re-probes. Concurrent callers share one in-flight probe.
   *
   * This is optimistic: while a probe is in flight it reports the last known answer
   * (`true` before any probe completed) so a cold daemon never blocks the first turn.
   * A caller that needs certainty awaits its own request, which fails loudly.
   */
  available(): boolean {
    if (this.inFlight !== undefined) return this.probed ?? true
    if (this.probed !== undefined && Date.now() - this.probedAt < this.limits.probeTtlMs) {
      return this.probed
    }
    const probe = this.probe()
    this.inFlight = probe
    // `probe` never rejects — it maps every failure to `false` — so only the fulfilment
    // path can settle this, and there is no unhandled-rejection hazard here.
    void probe.then((healthy) => {
      this.probed = healthy
      this.probedAt = Date.now()
      this.inFlight = undefined
    })
    return this.probed ?? true
  }

  private async probe(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request('/health', 'GET', undefined, this.limits.metadataTimeoutMs, signal)
      return true
    } catch {
      return false
    }
  }

  /**
   * Resolve the bank owning `workspaceRoot`, creating it when absent. hindsight keys
   * banks as `<prefix>::<project>`, so a workspace under a Git checkout resolves to its
   * project name; anything else falls back to the configured default suffix.
   */
  async resolveBank(workspaceRoot: string, signal?: AbortSignal): Promise<MemoryBankId> {
    const bankId = memoryBankId(`coding-agent::${projectNameOf(workspaceRoot, this.limits.defaultBankSuffix)}`)
    const listed = await this.request('/v1/default/banks', 'GET', undefined, this.limits.metadataTimeoutMs, signal)
    const banks = Array.isArray(listed) ? listed as BankRow[] : readBankRows(listed)
    if (banks.some(row => row.bank_id === bankId)) return bankId
    await this.request(
      `/v1/default/banks/${encodeURIComponent(bankId)}`,
      'PUT',
      { name: bankId },
      this.limits.metadataTimeoutMs,
      signal,
    )
    return bankId
  }

  /**
   * Search a bank through hindsight's hybrid recall. hindsight exposes search as recall
   * with a limit, so both capabilities share one request shape.
   */
  async search(request: MemorySearchRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemorySearchResult> {
    const units = await this.recallUnits(bankId, request.query, request.limit ?? 8, signal)
    return { units, truncated: false }
  }

  /** Recall memories relevant to a session opening, bounded by `limits.recallTimeoutMs`. */
  async recall(request: MemoryRecallRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryRecallResult> {
    const units = await this.recallUnits(bankId, request.prompt, request.limit ?? 8, signal)
    return { units, truncated: false }
  }

  private async recallUnits(bankId: MemoryBankId, query: string, limit: number, signal?: AbortSignal): Promise<readonly MemoryUnit[]> {
    const body = await this.request(
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
      'POST',
      { query, limit },
      this.limits.recallTimeoutMs,
      signal,
    )
    return readUnits(body)
  }

  /**
   * Retain a finished session's transcript. hindsight's retain endpoint takes discrete
   * items and extracts facts from them, so the transcript becomes one item per turn.
   * Retention runs asynchronously: the call returns once the backend accepted the items,
   * which keeps turn-stopping fast even though extraction is expensive.
   */
  async retain(request: MemoryRetainRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryRetainResult> {
    const items = transcriptItems(request, this.limits.maxRetainChars)
    if (items.length === 0) return { retained: false, detail: 'empty transcript' }
    const body = await this.request(
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
      'POST',
      { items, async: true },
      this.limits.retainTimeoutMs,
      signal,
    )
    const envelope = body as RetainResponse
    return {
      retained: envelope.success !== false,
      ...typeof envelope.operation_id === 'string' ? { detail: envelope.operation_id } : {},
    }
  }

  /** Issue one request against the daemon, mapping transport and status failures onto {@link MemoryError}. */
  private async request(path: string, method: string, body: unknown, timeoutMs: number, caller?: AbortSignal): Promise<unknown> {
    const url = `${this.limits.baseUrl}${path}`
    // Honour both budgets: the caller's cancellation (a turn being aborted) and this
    // request class's own timeout.
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = caller === undefined ? timeout : AbortSignal.any([caller, timeout])
    let response: Response
    try {
      response = await fetch(url, {
        method,
        signal,
        ...body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      })
    } catch (error: unknown) {
      throw toTransportError(error, url, timeoutMs)
    }
    if (response.status === 404) {
      throw new MemoryError(`hindsight has no resource at ${url}`, 'MEMORY_BANK_NOT_FOUND')
    }
    const text = await response.text()
    if (!response.ok) {
      throw new MemoryError(`hindsight returned ${response.status} for ${url}: ${text.slice(0, 200)}`, 'MEMORY_BACKEND_ERROR')
    }
    if (text.length === 0) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new MemoryError(`hindsight returned non-JSON for ${url}`, 'MEMORY_BACKEND_ERROR')
    }
  }
}

/** Classify a `fetch` rejection: an abort means the backend exceeded its budget. */
function toTransportError(error: unknown, url: string, timeoutMs: number): MemoryError {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new MemoryError(`hindsight did not answer ${url} within ${timeoutMs}ms`, 'MEMORY_BACKEND_TIMEOUT')
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new MemoryError(`hindsight is unreachable at ${url}: ${detail}`, 'MEMORY_BACKEND_ERROR')
}

/** Read bank rows from either a bare array or a `{ banks: [...] }` envelope. */
function readBankRows(payload: unknown): BankRow[] {
  if (typeof payload !== 'object' || payload === null) return []
  const banks = (payload as { banks?: unknown }).banks
  return Array.isArray(banks) ? banks as BankRow[] : []
}

/** Project recall rows onto seam units, skipping malformed entries. */
function readUnits(payload: unknown): readonly MemoryUnit[] {
  if (typeof payload !== 'object' || payload === null) return []
  const rows = (payload as RecallResponse).results
  if (!Array.isArray(rows)) return []
  const units: MemoryUnit[] = []
  // The payload is untrusted JSON: an element can be null or a primitive even though the
  // declared row type says otherwise, so the guard is a runtime check, not a type claim.
  for (const row of rows as readonly unknown[]) {
    if (typeof row !== 'object' || row === null) continue
    const { id, text } = row as RecallRow
    if (typeof id !== 'string' || typeof text !== 'string') continue
    units.push({ id: memoryId(id), text })
  }
  return units
}

/**
 * Project transcript turns onto hindsight retain items, one item per turn, stopping
 * before the character budget so a long session cannot produce an unbounded request.
 */
function transcriptItems(request: MemoryRetainRequest, maxChars: number): { content: string }[] {
  const items: { content: string }[] = []
  let length = 0
  for (const turn of request.turns) {
    const content = turn.response === undefined
      ? `User asked: ${turn.prompt}`
      : `User asked: ${turn.prompt}\nAssistant replied: ${turn.response}`
    if (length + content.length > maxChars) break
    items.push({ content })
    length += content.length
  }
  return items
}

/**
 * Derive a hindsight bank suffix from a workspace path: the leaf directory name, or the
 * configured default when the path has no usable leaf (a filesystem root, or an empty
 * string). Sibling checkouts therefore keep separate banks instead of merging into one.
 */
function projectNameOf(workspaceRoot: string, fallback: string): string {
  const segments = workspaceRoot.split(/[/\\]/).filter(segment => segment.length > 0)
  return segments.at(-1) ?? fallback
}
