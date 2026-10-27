/**
 * HTTP client for a hindsight memory daemon, and the `MemoryProvider` implementation
 * built on it. The provider speaks hindsight's `/v1/default` REST surface: bank listing
 * for workspace→bank resolution, hybrid recall for session openings and searches, and
 * document retention for finished sessions.
 *
 * The same client also carries the provider's browse surface (`browse`): the bank,
 * statistics, knowledge-page, memory-unit, and write projections a human-facing
 * consumer reads and writes through the seam. hindsight is one backend; the surface
 * it implements is the provider-neutral one declared by `@deepseek-ai/dsh-memory`, so
 * a consumer written against the seam works against any provider that offers it.
 *
 * Every call is bounded by a timeout and mapped onto the seam's error taxonomy, because
 * this backend answers by running LLM inference and can therefore stay silent far longer
 * than an agent turn tolerates.
 *
 * @module @deepseek-ai/dsh-memory-hindsight-http/provider
 */

import type {
  MemoryBankId,
  MemoryBankStats,
  MemoryBankSummary,
  MemoryBrowseProvider,
  MemoryCount,
  MemoryCurateRequest,
  MemoryCurateResult,
  MemoryKnowledgeHit,
  MemoryKnowledgePage,
  MemoryKnowledgePageBody,
  MemoryPageSearchRequest,
  MemoryPageSearchResult,
  MemoryProvider,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRememberRequest,
  MemoryRememberResult,
  MemoryRetainRequest,
  MemoryRetainResult,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryUnit,
  MemoryId,
  MemoryUnitListRequest,
  MemoryUnitPage,
  MemoryUnitSummary,
} from '@deepseek-ai/dsh-memory'
import type { KnowledgePageId } from '@deepseek-ai/dsh-memory'
import { MemoryError, knowledgePageId, memoryBankId, memoryId } from '@deepseek-ai/dsh-memory'

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
  readonly name?: unknown
  readonly fact_count?: unknown
  readonly last_write_at?: unknown
}

/** The shape of one `GET .../memories/list` row this provider reads. */
interface UnitRow {
  readonly id?: unknown
  readonly text?: unknown
  /** The list endpoint's fact-type field. */
  readonly fact_type?: unknown
  /** The single-unit endpoints spell the same field `type`. */
  readonly type?: unknown
  readonly context?: unknown
  readonly state?: unknown
  readonly tags?: unknown
  readonly mentioned_at?: unknown
  readonly updated_at?: unknown
}

/** The shape of one `GET .../knowledge-base/tree` node. */
interface PageNode {
  readonly id?: unknown
  readonly name?: unknown
  readonly description?: unknown
  readonly timestamp?: unknown
  readonly is_stale?: unknown
  readonly children?: unknown
}

/** The shape of one `GET .../knowledge-base/search` hit. */
interface SearchHitRow {
  readonly id?: unknown
  readonly name?: unknown
  readonly snippet?: unknown
  readonly score?: unknown
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

  /**
   * This provider's browse surface: the provider itself, whose public methods below
   * are exactly the surface's contract. hindsight backs every member, including the
   * optional statistics and knowledge-page ones.
   */
  readonly browse: MemoryBrowseProvider = this

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

  /**
   * List the banks the daemon holds. hindsight answers a bare array or a
   * `{ banks: [...] }` envelope depending on version, so both are read.
   */
  async listBanks(signal?: AbortSignal): Promise<readonly MemoryBankSummary[]> {
    const payload = await this.request('/v1/default/banks', 'GET', undefined, this.limits.metadataTimeoutMs, signal)
    const banks = Array.isArray(payload) ? payload as BankRow[] : readBankRows(payload)
    return banks.flatMap(row => readBankSummary(row) ?? [])
  }

  /**
   * Page through one bank's memory units. The `q` filter is a case-insensitive
   * substring scan the daemon performs per call, so it shares the metadata budget:
   * it is a browsing aid, not the hybrid recall the agent path uses.
   */
  async listUnits(request: MemoryUnitListRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryUnitPage> {
    const query = new URLSearchParams()
    if (request.limit !== undefined) query.set('limit', String(request.limit))
    if (request.offset !== undefined) query.set('offset', String(request.offset))
    if (request.query !== undefined) query.set('q', request.query)
    if (request.factType !== undefined) query.set('type', request.factType)
    const search = query.toString()
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories/list${search.length === 0 ? '' : `?${search}`}`
    const payload = await this.request(path, 'GET', undefined, this.limits.metadataTimeoutMs, signal)
    return readUnitPage(payload)
  }

  /**
   * Record one finding into a bank. Retention is asynchronous — hindsight extracts
   * facts by running inference, which no interactive write may wait for — so the
   * call returns once the items are accepted and `detail` carries the operation id.
   */
  async remember(request: MemoryRememberRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryRememberResult> {
    const item: Record<string, string> = { content: request.text }
    if (request.context !== undefined) item.context = request.context
    const body = await this.request(
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
      'POST',
      { items: [item], async: true },
      this.limits.retainTimeoutMs,
      signal,
    )
    const envelope = body as RetainResponse
    return {
      remembered: envelope.success !== false,
      ...typeof envelope.operation_id === 'string' ? { detail: envelope.operation_id } : {},
    }
  }

  /**
   * Curate one existing memory unit. A curation re-embeds the unit, so it is given
   * the recall budget rather than the metadata one. hindsight refuses fact types it
   * derives (observations) with an error whose message the caller shows.
   */
  async curateUnit(
    request: MemoryCurateRequest,
    bankId: MemoryBankId,
    unitId: MemoryId,
    signal?: AbortSignal,
  ): Promise<MemoryCurateResult> {
    const patch: Record<string, string> = {}
    if (request.text !== undefined) patch.text = request.text
    if (request.context !== undefined) patch.context = request.context
    if (request.factType !== undefined) patch.fact_type = request.factType
    if (Object.keys(patch).length === 0) {
      throw new MemoryError('a memory curation must change at least one field', 'MEMORY_BACKEND_ERROR')
    }
    const body = await this.request(
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/${encodeURIComponent(unitId)}`,
      'PATCH',
      patch,
      this.limits.recallTimeoutMs,
      signal,
    )
    return readCurateOutcome(body)
  }

  /** Read one bank's statistics: totals plus the two backend distributions. */
  async bankStats(bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryBankStats> {
    const payload = await this.request(`/v1/default/banks/${encodeURIComponent(bankId)}/stats`, 'GET', undefined, this.limits.metadataTimeoutMs, signal)
    return readStats(asRecord(payload), bankId)
  }

  /** List one bank's knowledge pages as a flat, depth-first list. */
  async listPages(bankId: MemoryBankId, signal?: AbortSignal): Promise<readonly MemoryKnowledgePage[]> {
    const payload = await this.request(`/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base/tree`, 'GET', undefined, this.limits.metadataTimeoutMs, signal)
    return readRows<PageNode>(asRecord(payload), 'roots').flatMap(node => readPages(node))
  }

  /** Search one bank's knowledge-page index. */
  async searchPages(request: MemoryPageSearchRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryPageSearchResult> {
    const query = new URLSearchParams({ q: request.query })
    if (request.limit !== undefined) query.set('limit', String(request.limit))
    const payload = asRecord(await this.request(
      `/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base/search?${query.toString()}`,
      'GET',
      undefined,
      this.limits.metadataTimeoutMs,
      signal,
    ))
    const hits = readRows<SearchHitRow>(payload, 'results').flatMap(row => readHit(row) ?? [])
    return { hits, total: Math.max(countOf(payload.total), hits.length) }
  }

  /** Read one knowledge page's body, or undefined when the daemon holds none under that id. */
  async pageBody(bankId: MemoryBankId, pageId: KnowledgePageId, signal?: AbortSignal): Promise<MemoryKnowledgePageBody | undefined> {
    const payload = await this.request(
      `/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base/pages/${encodeURIComponent(pageId)}`,
      'GET',
      undefined,
      this.limits.metadataTimeoutMs,
      signal,
    )
    return readPageBody(asRecord(payload))
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

/** Read a decoded body as a JSON object, so field reads never throw on a primitive or `null`. */
function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
}

/** Read a finite number, falling back when the field is absent or not numeric. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Read a string field, or undefined when the backend omitted or mistyped it. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Read a named array field from a decoded body, tolerating a bare array. */
function readRows<Row>(payload: Record<string, unknown>, field: string): Row[] {
  const rows = payload[field]
  return Array.isArray(rows) ? rows as Row[] : []
}

/**
 * Project one bank row, skipping a row without the id every later request needs.
 * @param row - one row of the banks listing.
 * @returns the summary, or undefined for a malformed row.
 */
function readBankSummary(row: BankRow): MemoryBankSummary | undefined {
  if (typeof row.bank_id !== 'string' || row.bank_id.length === 0) return undefined
  const lastWriteAt = textOf(row.last_write_at)
  return {
    bankId: memoryBankId(row.bank_id),
    name: textOf(row.name) ?? row.bank_id,
    factCount: countOf(row.fact_count),
    ...lastWriteAt === undefined ? {} : { lastWriteAt },
  }
}

/**
 * Project one memory-unit row. The list endpoint spells the fact type `fact_type`
 * and the single-unit endpoints spell it `type`; both are read so one projection
 * serves list, get, and curation responses.
 */
function readUnitSummary(row: UnitRow): MemoryUnitSummary | undefined {
  const id = textOf(row.id)
  const text = textOf(row.text)
  if (id === undefined || text === undefined) return undefined
  const factType = textOf(row.fact_type) ?? textOf(row.type)
  const context = textOf(row.context)
  const state = textOf(row.state)
  const mentionedAt = textOf(row.mentioned_at)
  const updatedAt = textOf(row.updated_at)
  const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : undefined
  return {
    id: memoryId(id),
    text,
    ...factType === undefined ? {} : { factType },
    ...context === undefined ? {} : { context },
    ...state === undefined ? {} : { state },
    ...tags === undefined || tags.length === 0 ? {} : { tags },
    ...mentionedAt === undefined ? {} : { mentionedAt },
    ...updatedAt === undefined ? {} : { updatedAt },
  }
}

/** Project a units-listing envelope onto one page, skipping malformed rows. */
function readUnitPage(payload: unknown): MemoryUnitPage {
  const envelope = asRecord(payload)
  const rows = Array.isArray(envelope.items) ? envelope.items as unknown[] : []
  const units = rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return []
    return readUnitSummary(row) ?? []
  })
  return {
    units,
    total: countOf(envelope.total),
    limit: countOf(envelope.limit),
    offset: countOf(envelope.offset),
  }
}

/**
 * Read a curation response as an outcome. A 200 carries the updated unit; anything
 * without a readable id and text is a refusal the daemon worded itself, so its
 * detail is passed through rather than guessed at.
 */
function readCurateOutcome(payload: unknown): MemoryCurateResult {
  const envelope = asRecord(payload)
  const unit = readUnitSummary(envelope)
  if (unit === undefined) return { curated: false, detail: textOf(envelope.detail) ?? '' }
  return { curated: true }
}

/**
 * Project one statistics envelope. Every field degrades to zero rather than
 * failing the read: a partial count is more useful on a page than no page.
 */
function readStats(payload: Record<string, unknown>, bankId: MemoryBankId): MemoryBankStats {
  return {
    bankId,
    totalNodes: countOf(payload.total_nodes),
    totalLinks: countOf(payload.total_links),
    totalDocuments: countOf(payload.total_documents),
    nodesByFactType: readCounts(payload.nodes_by_fact_type),
    linksByLinkType: readCounts(payload.links_by_link_type),
    pendingOperations: countOf(payload.pending_operations),
    failedOperations: countOf(payload.failed_operations),
  }
}

/** Read one distribution object as ranked counts, largest first. */
function readCounts(value: unknown): MemoryCount[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value)
    .map(([label, count]) => ({ label, count: countOf(count) }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

/**
 * Walk a knowledge-base tree into the flat page list a browser renders. A node
 * without an id is skipped with its subtree: its children are addressed by their
 * own ids, so dropping the parent loses no reachable page.
 */
function readPages(node: PageNode): MemoryKnowledgePage[] {
  const children = Array.isArray(node.children) ? node.children as PageNode[] : []
  const nested = children.flatMap(child => readPages(child))
  if (typeof node.id !== 'string' || node.id.length === 0) return nested
  const description = textOf(node.description)
  const updatedAt = textOf(node.timestamp)
  return [{
    pageId: knowledgePageId(node.id),
    name: textOf(node.name) ?? node.id,
    stale: node.is_stale === true,
    ...description === undefined ? {} : { description },
    ...updatedAt === undefined ? {} : { updatedAt },
  }, ...nested]
}

/** Project one search hit, skipping a row without an id or a snippet: a hit the page cannot open and cannot quote is not a hit. */
function readHit(row: SearchHitRow): MemoryKnowledgeHit | undefined {
  if (typeof row.id !== 'string' || row.id.length === 0) return undefined
  const snippet = textOf(row.snippet)
  if (snippet === undefined) return undefined
  const score = row.score
  return {
    pageId: knowledgePageId(row.id),
    name: textOf(row.name) ?? row.id,
    snippet,
    ...typeof score === 'number' && Number.isFinite(score) ? { score } : {},
  }
}

/** Project a page envelope, or undefined when the backend has no body for it. */
function readPageBody(payload: Record<string, unknown>): MemoryKnowledgePageBody | undefined {
  const id = textOf(payload.id)
  const body = textOf(payload.body)
  if (id === undefined || body === undefined) return undefined
  return { pageId: knowledgePageId(id), name: textOf(payload.name) ?? id, body }
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
