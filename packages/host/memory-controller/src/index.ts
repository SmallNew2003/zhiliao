/**
 * Host Remote controller that lets a browser read the long-term memory a
 * deployment retains. The `memory` seam owns recall, search, and retention for
 * the agent's hot path; it deliberately does not project banks, statistics, or
 * knowledge pages, because nothing on the agent path needs them. This
 * controller adds that read-only browse surface for a human.
 *
 * It answers structured unavailability instead of throwing. `ctx.memory` raises
 * `MemoryError` for a missing provider, a misconfigured provider id, an
 * unreachable backend, and an absent bank, and a rejected Remote call reaches
 * the browser as an opaque transport failure with no way to say which of those
 * happened. Every method therefore maps the seam's taxonomy onto an
 * {@link MemoryAnswer} the page can degrade on.
 *
 * @module @deepseek-ai/dsh-host-memory-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-memory'
import { MemoryError } from '@deepseek-ai/dsh-memory'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MemoryAnswer,
  MemoryBankStats,
  MemoryBankSummary,
  MemoryCount,
  MemoryKnowledgeHit,
  MemoryKnowledgePage,
  MemoryKnowledgePageBody,
  MemoryListResult,
  MemoryPageResult,
  MemoryPagesResult,
  MemorySearchResult,
  MemoryStatsResult,
  MemoryUnavailableReason,
} from './types.ts'

export type * from './types.ts'

/** Default daemon URL, matching the hindsight provider's own default. */
export const DEFAULT_MEMORY_DAEMON_URL = 'http://127.0.0.1:9077'

/** How many search hits one call returns when the caller names no limit. */
export const DEFAULT_SEARCH_LIMIT = 20

/** Upper bound on one call's search hits, so a client cannot ask for a whole bank. */
export const MAX_SEARCH_LIMIT = 100

/**
 * The read-only browse surface's transport settings. Every field is
 * deployment-varying and therefore configurable rather than a constant.
 */
export interface Config {
  /** Base URL of the memory daemon, without a trailing slash. */
  readonly baseUrl?: string
  /**
   * Timeout for one browse request. These are metadata reads, so the budget is
   * the provider's cheap-metadata budget rather than its inference budget.
   */
  readonly timeoutMs?: number
}

/** Config after schemastery has filled every default. */
type ResolvedConfig = Required<Config>

/** The shape of one `GET /v1/default/banks` row this controller reads. */
interface BankRow {
  readonly bank_id?: unknown
  readonly name?: unknown
  readonly fact_count?: unknown
  readonly last_write_at?: unknown
}

/** The shape of a `GET .../stats` envelope. */
interface StatsEnvelope {
  readonly bank_id?: unknown
  readonly total_nodes?: unknown
  readonly total_links?: unknown
  readonly total_documents?: unknown
  readonly nodes_by_fact_type?: unknown
  readonly links_by_link_type?: unknown
  readonly pending_operations?: unknown
  readonly failed_operations?: unknown
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

/** The shape of a `GET .../knowledge-base/pages/{page_id}` envelope. */
interface PageEnvelope {
  readonly id?: unknown
  readonly name?: unknown
  readonly body?: unknown
}

/**
 * The seam's error taxonomy projected onto the reason a browser can word. A bank
 * that does not exist is a `failed` read, not an absent capability: the
 * capability answered, and the bank was not there. The two selection failures
 * that name a provider — a pinned id nothing registered, and several usable
 * providers with none pinned — both read as `misconfigured`, because both are
 * fixed by configuring one provider id rather than by installing memory.
 */
const UNAVAILABLE_BY_CODE = {
  MEMORY_PROVIDER_UNAVAILABLE: 'unavailable',
  MEMORY_PROVIDER_CONFIGURED_MISSING: 'misconfigured',
  MEMORY_PROVIDER_AMBIGUOUS: 'misconfigured',
  MEMORY_DUPLICATE_PROVIDER: 'misconfigured',
  MEMORY_BACKEND_TIMEOUT: 'unreachable',
  MEMORY_BACKEND_ERROR: 'failed',
  MEMORY_BANK_NOT_FOUND: 'failed',
} as const satisfies Record<MemoryError['code'], MemoryUnavailableReason>

/** Classify a {@link MemoryError} onto the reason a browser can word. */
function reasonOf(error: MemoryError): MemoryUnavailableReason {
  return UNAVAILABLE_BY_CODE[error.code]
}

/** Read a finite number, falling back when the field is absent or not numeric. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Read a string field, or undefined when the backend omitted or mistyped it. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Flatten a `{ label: count }` distribution into a descending list, so the page
 * renders the same order whatever order the backend serialized.
 * @param value - the envelope's distribution field.
 * @returns the counted entries, largest first.
 */
function readCounts(value: unknown): MemoryCount[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value)
    .map(([label, count]) => ({ label, count: countOf(count) }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

/**
 * Project one bank row, skipping a row without the id every later request needs.
 * @param row - one row of the banks listing.
 * @returns the summary, or undefined for a malformed row.
 */
function readBank(row: BankRow): MemoryBankSummary | undefined {
  if (typeof row.bank_id !== 'string' || row.bank_id.length === 0) return undefined
  const lastWriteAt = textOf(row.last_write_at)
  return {
    bankId: row.bank_id,
    name: textOf(row.name) ?? row.bank_id,
    factCount: countOf(row.fact_count),
    ...lastWriteAt === undefined ? {} : { lastWriteAt },
  }
}

/**
 * Project one statistics envelope. Every field degrades to zero rather than
 * failing the read: a partial count is more useful on a page than no page.
 * @param payload - the backend's stats envelope.
 * @returns the statistics view.
 */
function readStats(payload: StatsEnvelope): MemoryBankStats {
  return {
    bankId: textOf(payload.bank_id) ?? '',
    totalNodes: countOf(payload.total_nodes),
    totalLinks: countOf(payload.total_links),
    totalDocuments: countOf(payload.total_documents),
    nodesByFactType: readCounts(payload.nodes_by_fact_type),
    linksByLinkType: readCounts(payload.links_by_link_type),
    pendingOperations: countOf(payload.pending_operations),
    failedOperations: countOf(payload.failed_operations),
  }
}

/**
 * Walk a knowledge-base tree into the flat page list the browser renders.
 * A node without an id is skipped with its subtree: its children are addressed
 * by their own ids, so dropping the parent loses no reachable page.
 * @param node - one tree node and its children.
 * @returns the pages under this node, depth-first.
 */
function readPages(node: PageNode): MemoryKnowledgePage[] {
  const children = Array.isArray(node.children) ? node.children as PageNode[] : []
  const nested = children.flatMap(child => readPages(child))
  if (typeof node.id !== 'string' || node.id.length === 0) return nested
  const description = textOf(node.description)
  const updatedAt = textOf(node.timestamp)
  return [{
    pageId: node.id,
    name: textOf(node.name) ?? node.id,
    stale: node.is_stale === true,
    ...description === undefined ? {} : { description },
    ...updatedAt === undefined ? {} : { updatedAt },
  }, ...nested]
}

/**
 * Project one search hit, skipping a row without an id or a snippet: a hit the
 * page cannot open and cannot quote is not a hit.
 * @param row - one row of the search results.
 * @returns the hit, or undefined for a malformed row.
 */
function readHit(row: SearchHitRow): MemoryKnowledgeHit | undefined {
  if (typeof row.id !== 'string' || row.id.length === 0) return undefined
  const snippet = textOf(row.snippet)
  if (snippet === undefined) return undefined
  const score = row.score
  return {
    pageId: row.id,
    name: textOf(row.name) ?? row.id,
    snippet,
    ...typeof score === 'number' && Number.isFinite(score) ? { score } : {},
  }
}

/**
 * Project a page envelope, or undefined when the backend has no body for it.
 * @param payload - the backend's page envelope.
 * @returns the page body, or undefined.
 */
function readPageBody(payload: PageEnvelope): MemoryKnowledgePageBody | undefined {
  if (typeof payload.id !== 'string' || payload.id.length === 0) return undefined
  const body = textOf(payload.body)
  if (body === undefined) return undefined
  return { pageId: payload.id, name: textOf(payload.name) ?? payload.id, body }
}

/**
 * Remote-only service exposing the memory daemon's read-only browse surface:
 * bank listing, per-bank statistics, the knowledge-page tree, knowledge-base
 * search, and one page's body.
 *
 * Registered as `ctx.memoryController` under the `memoryController` namespace,
 * which is distinct from the `memory` seam's own key so the two never collide.
 */
export class MemoryController extends TypertRemoteService {
  static inject = ['memory']

  static Config: z<Config> = z.object({
    baseUrl: z.string().default(DEFAULT_MEMORY_DAEMON_URL),
    timeoutMs: z.number().default(10_000),
  })

  private readonly baseUrl: string
  private readonly timeoutMs: number

  /**
   * @param ctx - Host context carrying the `memory` seam.
   * @param config - transport settings; every field defaulted by schemastery.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'memoryController')
    const resolved = config as ResolvedConfig
    this.baseUrl = resolved.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = resolved.timeoutMs
  }

  /**
   * List the memory banks the daemon holds, so a browser can pick one to read.
   * @returns the banks with their fact counts and last-write instants, or why
   * the listing is unavailable.
   */
  @Remote('list')
  async list(): Promise<MemoryListResult> {
    return this.answer(async () => {
      const payload = await this.request('/v1/default/banks')
      const rows = readRows<BankRow>(payload, 'banks')
      return { banks: rows.flatMap(row => readBank(row) ?? []) }
    })
  }

  /**
   * Read one bank's statistics: node, link, and document totals plus the fact
   * type and link type distributions.
   * @param bankId - provider-owned bank id; contains `::`, so it is encoded.
   * @returns the statistics, or why they are unavailable.
   */
  @Remote('stats')
  async stats(bankId: string): Promise<MemoryStatsResult> {
    return this.answer(async () => {
      const payload = await this.request(`/v1/default/banks/${this.bank(bankId)}/stats`)
      return { stats: readStats(asEnvelope(payload)) }
    })
  }

  /**
   * List one bank's knowledge pages as a flat, depth-first list.
   * @param bankId - provider-owned bank id.
   * @returns the pages, or why the tree is unavailable.
   */
  @Remote('pages')
  async pages(bankId: string): Promise<MemoryPagesResult> {
    return this.answer(async () => {
      const payload = await this.request(`/v1/default/banks/${this.bank(bankId)}/knowledge-base/tree`)
      return { pages: readRows<PageNode>(payload, 'roots').flatMap(node => readPages(node)) }
    })
  }

  /**
   * Search one bank's knowledge base.
   *
   * This is the knowledge-base index, not the seam's `search`, which answers by
   * running inference on the daemon and takes a minute or more. A browser panel
   * cannot wait for that, so the panel searches the curated pages instead.
   * @param bankId - provider-owned bank id.
   * @param query - free text to match against page bodies.
   * @param limit - maximum hits; clamped into `[1, 100]`, defaulting to 20.
   * @returns the hits and the backend's total match count, or why the search is
   * unavailable.
   */
  @Remote('search')
  async search(bankId: string, query: string, limit: number | undefined): Promise<MemorySearchResult> {
    const capped = Math.min(Math.max(limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT)
    const path = `/v1/default/banks/${this.bank(bankId)}/knowledge-base/search?q=${encodeURIComponent(query)}&limit=${capped}`
    return this.answer(async () => {
      const payload = asEnvelope(await this.request(path))
      const rows = readRows<SearchHitRow>(payload, 'results')
      const hits = rows.flatMap(row => readHit(row) ?? [])
      return { hits, total: Math.max(countOf(payload.total), hits.length) }
    })
  }

  /**
   * Read one knowledge page's body.
   * @param bankId - provider-owned bank id.
   * @param pageId - provider-owned page id.
   * @returns the page body, a result without a page when the daemon holds none
   * under that id, or why the read is unavailable.
   */
  @Remote('page')
  async page(bankId: string, pageId: string): Promise<MemoryPageResult> {
    const path = `/v1/default/banks/${this.bank(bankId)}/knowledge-base/pages/${encodeURIComponent(pageId)}`
    return this.answer(async () => {
      const page = readPageBody(asEnvelope(await this.request(path)))
      return page === undefined ? {} : { page }
    })
  }

  /**
   * Percent-encode a bank id for a URL path. hindsight keys banks as
   * `<prefix>::<project>`, so the id carries a `::` a raw path would misread.
   * @param bankId - provider-owned bank id.
   * @returns the encoded segment.
   */
  private bank(bankId: string): string {
    return encodeURIComponent(bankId)
  }

  /**
   * Run one read and settle it as an answer rather than an exception.
   *
   * Availability is checked before the request because that is the cheap,
   * synchronous answer: a deployment with memory switched off costs no socket,
   * and `isAvailable()` never throws, so a misconfigured provider id is simply
   * "not available" here rather than a second failure to classify. Everything
   * after it — the transport and the status mapping — is classified instead of
   * propagated, because a rejected Remote call reaches the browser as an opaque
   * transport error with nothing to say which backend condition happened.
   * @param read - the request to issue once memory answers available.
   * @returns the payload, or the reason there is none.
   */
  private async answer<T>(read: () => Promise<T>): Promise<MemoryAnswer<T>> {
    try {
      if (!this.ctx.memory.isAvailable()) {
        return { available: false, reason: 'unavailable', detail: 'no usable memory provider is registered' }
      }
      return { available: true, ...await read() }
    } catch (error: unknown) {
      if (error instanceof MemoryError) {
        return { available: false, reason: reasonOf(error), detail: error.message }
      }
      return { available: false, reason: 'failed', detail: messageOf(error) }
    }
  }

  /**
   * Issue one bounded GET against the daemon and return its decoded body.
   * @param path - path below the daemon base URL, already encoded.
   * @returns the decoded JSON body, or undefined for an empty response.
   * @throws MemoryError when the daemon is unreachable, answers an error, or
   * answers a body that is not JSON.
   */
  private async request(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`
    let response: Response
    try {
      response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new MemoryError(`the memory daemon did not answer ${url} within ${this.timeoutMs}ms`, 'MEMORY_BACKEND_TIMEOUT')
      }
      throw new MemoryError(`the memory daemon is unreachable at ${url}: ${messageOf(error)}`, 'MEMORY_BACKEND_ERROR')
    }
    if (response.status === 404) {
      throw new MemoryError(`the memory daemon has no resource at ${url}`, 'MEMORY_BANK_NOT_FOUND')
    }
    const text = await response.text()
    if (!response.ok) {
      throw new MemoryError(`the memory daemon returned ${response.status} for ${url}: ${text.slice(0, 200)}`, 'MEMORY_BACKEND_ERROR')
    }
    if (text.length === 0) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new MemoryError(`the memory daemon returned non-JSON for ${url}`, 'MEMORY_BACKEND_ERROR')
    }
  }
}

/** What an unclassified thrown value said. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read a named array field from a decoded body, tolerating a bare array.
 * @param payload - the decoded body.
 * @param field - the envelope field holding the rows.
 * @returns the rows, empty when the body carries none this controller reads.
 */
function readRows<Row>(payload: unknown, field: string): Row[] {
  if (Array.isArray(payload)) return payload as Row[]
  if (typeof payload !== 'object' || payload === null) return []
  const rows = (payload as Record<string, unknown>)[field]
  return Array.isArray(rows) ? rows as Row[] : []
}

/**
 * Read a decoded body as a JSON object, so field reads never throw on a
 * primitive or `null`.
 * @param payload - the decoded body.
 * @returns the body as a record, empty when it is not an object.
 */
function asEnvelope(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
}

export default MemoryController
