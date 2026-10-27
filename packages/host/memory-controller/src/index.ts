/**
 * Host Remote controller that lets a browser read and write the long-term
 * memory a deployment retains. The `memory` seam owns the browse surface for
 * humans exactly as it owns recall, search, and retention for the agent: this
 * controller projects that surface over Typert Remote and adds no transport of
 * its own, so the panel works against whichever provider the seam selected and
 * a deployment that swaps providers needs no change here.
 *
 * It answers structured unavailability instead of throwing. `ctx.memory`
 * raises `MemoryError` for a missing provider, a misconfigured provider id, an
 * unreachable backend, a provider with no browse surface, and an absent bank,
 * and a rejected Remote call reaches the browser as an opaque transport
 * failure with no way to say which of those happened. Every method therefore
 * maps the seam's taxonomy onto an {@link MemoryAnswer} the page can degrade
 * on.
 *
 * @module @deepseek-ai/dsh-host-memory-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryBrowseProvider } from '@deepseek-ai/dsh-memory'
import { MemoryError, knowledgePageId, memoryBankId, memoryId } from '@deepseek-ai/dsh-memory'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MemoryAnswer,
  MemoryCurateResult,
  MemoryListResult,
  MemoryPageResult,
  MemoryPagesResult,
  MemoryRememberResult,
  MemorySearchResult,
  MemoryStatsResult,
  MemoryUnitsResult,
  MemoryUnavailableReason,
} from './types.ts'

export type * from './types.ts'

/** How many knowledge-page hits one search returns when the caller names no limit. */
export const DEFAULT_SEARCH_LIMIT = 20

/** Upper bound on one search's hits, so a client cannot ask for a whole bank. */
export const MAX_SEARCH_LIMIT = 100

/** How many memory units one listing returns when the caller names no limit. */
export const DEFAULT_UNITS_LIMIT = 20

/** Upper bound on one listing's units, so a client cannot ask for a whole bank. */
export const MAX_UNITS_LIMIT = 100

/**
 * The seam's error taxonomy projected onto the reason a browser can word. A
 * bank that does not exist is a `failed` read, not an absent capability: the
 * capability answered, and the bank was not there. A provider that offers no
 * browse surface — or not the section asked for — reads as `unsupported`,
 * because the fix is to point the deployment at a provider that browses, not
 * to repair this one. The two selection failures that name a provider — a
 * pinned id nothing registered, and several usable providers with none pinned
 * — both read as `misconfigured`, because both are fixed by configuring one
 * provider id rather than by installing memory.
 */
const UNAVAILABLE_BY_CODE = {
  MEMORY_PROVIDER_UNAVAILABLE: 'unavailable',
  MEMORY_PROVIDER_CONFIGURED_MISSING: 'misconfigured',
  MEMORY_PROVIDER_AMBIGUOUS: 'misconfigured',
  MEMORY_DUPLICATE_PROVIDER: 'misconfigured',
  MEMORY_BACKEND_TIMEOUT: 'unreachable',
  MEMORY_BACKEND_ERROR: 'failed',
  MEMORY_BANK_NOT_FOUND: 'failed',
  MEMORY_CAPABILITY_UNSUPPORTED: 'unsupported',
} as const satisfies Record<MemoryError['code'], MemoryUnavailableReason>

/** Classify a {@link MemoryError} onto the reason a browser can word. */
function reasonOf(error: MemoryError): MemoryUnavailableReason {
  return UNAVAILABLE_BY_CODE[error.code]
}

/**
 * Refuse a section the selected provider does not implement. Statistics and
 * knowledge pages are optional members of the browse surface: a backend that
 * holds memory units but curates no pages is a valid provider, and the panel
 * degrades that section instead of failing every read.
 * @param what - the section's name, for the diagnostic the browser shows.
 */
function unsupportedSection(what: string): never {
  throw new MemoryError(`this memory provider offers no ${what}`, 'MEMORY_CAPABILITY_UNSUPPORTED')
}

/** Clamp a requested page size into `[1, MAX]`, defaulting when absent. */
function pageSize(limit: number | undefined, fallback: number, maximum: number): number {
  return Math.min(Math.max(limit ?? fallback, 1), maximum)
}

/** What an unclassified thrown value said. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Remote service projecting the memory seam's browse surface: the deployment's
 * banks, one bank's statistics, knowledge pages, and memory units, the
 * knowledge-index search, one page's body, and the two writes a person
 * performs — recording a finding and curating an existing one.
 *
 * Registered as `ctx.memoryController` under the `memoryController` namespace,
 * which is distinct from the `memory` seam's own key so the two never collide.
 */
export class MemoryController extends TypertRemoteService {
  static inject = ['memory']

  /**
   * @param ctx - Host context carrying the `memory` seam.
   */
  constructor(ctx: Context) {
    super(ctx, 'memoryController')
  }

  /**
   * List the memory banks the backend holds, so a browser can pick one to read.
   * @returns the banks with their fact counts and last-write instants, or why
   * the listing is unavailable.
   */
  @Remote('list')
  async list(): Promise<MemoryListResult> {
    return this.answer(async surface => ({ banks: await surface.listBanks() }))
  }

  /**
   * Read one bank's statistics: node, link, and document totals plus the fact
   * type and link type distributions.
   * @param bankId - provider-owned bank id; contains `::`, so it is encoded.
   * @returns the statistics, or why they are unavailable.
   */
  @Remote('stats')
  async stats(bankId: string): Promise<MemoryStatsResult> {
    return this.answer(async (surface) => {
      if (surface.bankStats === undefined) unsupportedSection('bank statistics')
      return { stats: await surface.bankStats(memoryBankId(bankId)) }
    })
  }

  /**
   * List one bank's knowledge pages as a flat, depth-first list.
   * @param bankId - provider-owned bank id.
   * @returns the pages, or why the tree is unavailable.
   */
  @Remote('pages')
  async pages(bankId: string): Promise<MemoryPagesResult> {
    return this.answer(async (surface) => {
      if (surface.listPages === undefined) unsupportedSection('knowledge pages')
      return { pages: await surface.listPages(memoryBankId(bankId)) }
    })
  }

  /**
   * Search one bank's knowledge base.
   *
   * This is the knowledge-page index, not the seam's `search`, which answers by
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
    return this.answer(async (surface) => {
      if (surface.searchPages === undefined) unsupportedSection('knowledge search')
      const result = await surface.searchPages(
        { query, limit: pageSize(limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT) },
        memoryBankId(bankId),
      )
      return { hits: result.hits, total: result.total }
    })
  }

  /**
   * Read one knowledge page's body.
   * @param bankId - provider-owned bank id.
   * @param pageId - provider-owned page id.
   * @returns the page body, a result without a page when the backend holds none
   * under that id, or why the read is unavailable.
   */
  @Remote('page')
  async page(bankId: string, pageId: string): Promise<MemoryPageResult> {
    return this.answer(async (surface) => {
      if (surface.pageBody === undefined) unsupportedSection('knowledge pages')
      const page = await surface.pageBody(memoryBankId(bankId), knowledgePageId(pageId))
      return page === undefined ? {} : { page }
    })
  }

  /**
   * Page through one bank's memory units: the individual facts the backend
   * extracted, which the statistics and knowledge pages summarize but never
   * list.
   * @param bankId - provider-owned bank id.
   * @param query - case-insensitive substring filter, or undefined for all.
   * @param factType - restrict to one backend fact type, or undefined for all.
   * @param limit - page size; clamped into `[1, 100]`, defaulting to 20.
   * @param offset - zero-based index of the first unit; clamped at zero.
   * @returns one page of units with the backend's total, or why the listing is
   * unavailable.
   */
  @Remote('units')
  async units(
    bankId: string,
    query: string | undefined,
    factType: string | undefined,
    limit: number | undefined,
    offset: number | undefined,
  ): Promise<MemoryUnitsResult> {
    return this.answer(async surface => ({
      ...await surface.listUnits(
        {
          ...query === undefined || query.length === 0 ? {} : { query },
          ...factType === undefined || factType.length === 0 ? {} : { factType },
          limit: pageSize(limit, DEFAULT_UNITS_LIMIT, MAX_UNITS_LIMIT),
          offset: Math.max(offset ?? 0, 0),
        },
        memoryBankId(bankId),
      ),
    }))
  }

  /**
   * Record one finding in a bank. Retention is asynchronous on backends that
   * extract facts by inference, so the answer reports acceptance and carries
   * the backend's operation detail; the unit becomes listable once extraction
   * finishes.
   * @param bankId - provider-owned bank id.
   * @param text - the finding, stated so it still makes sense out of context.
   * @param context - optional context the backend files the finding under.
   * @returns whether the finding was accepted, or why the write is unavailable.
   */
  @Remote('remember')
  async remember(bankId: string, text: string, context: string | undefined): Promise<MemoryRememberResult> {
    if (text.trim().length === 0) {
      return { available: true, remembered: false, detail: 'a remembered finding needs text' }
    }
    return this.answer(async (surface) => {
      const result = await surface.remember(
        { text, ...context === undefined ? {} : { context } },
        memoryBankId(bankId),
      )
      return {
        remembered: result.remembered,
        ...result.detail === undefined ? {} : { detail: result.detail },
      }
    })
  }

  /**
   * Curate one existing memory unit: replace its text, context, or fact type.
   * A backend that refuses the fact type answers with an error whose message
   * passes through as the write's detail.
   * @param bankId - provider-owned bank id.
   * @param unitId - provider-owned memory unit id.
   * @param text - replacement text, or undefined to leave it unchanged.
   * @param context - replacement context, or undefined to leave it unchanged.
   * @param factType - replacement fact type, or undefined to leave it unchanged.
   * @returns whether the curation was accepted, or why the write is unavailable.
   */
  @Remote('curate')
  async curate(
    bankId: string,
    unitId: string,
    text: string | undefined,
    context: string | undefined,
    factType: string | undefined,
  ): Promise<MemoryCurateResult> {
    if (text === undefined && context === undefined && factType === undefined) {
      return { available: true, curated: false, detail: 'a curation must change at least one field' }
    }
    if (text !== undefined && text.trim().length === 0) {
      return { available: true, curated: false, detail: 'a curated memory needs text' }
    }
    return this.answer(async (surface) => {
      const result = await surface.curateUnit(
        {
          ...text === undefined ? {} : { text },
          ...context === undefined ? {} : { context },
          ...factType === undefined ? {} : { factType },
        },
        memoryBankId(bankId),
        memoryId(unitId),
      )
      return {
        curated: result.curated,
        ...result.detail === undefined ? {} : { detail: result.detail },
      }
    })
  }

  /**
   * Run one call against the seam's browse surface and settle it as an answer
   * rather than an exception.
   *
   * The surface is resolved per call, so a provider that appears or disappears
   * between calls is honoured, and `browse()` classifies a missing or
   * misconfigured provider before any socket opens. Everything after it — the
   * transport and the status mapping — is classified instead of propagated,
   * because a rejected Remote call reaches the browser as an opaque transport
   * error with nothing to say which backend condition happened.
   * @param call - the surface call to issue once memory answers available.
   * @returns the payload, or the reason there is none.
   */
  private async answer<T>(call: (surface: MemoryBrowseProvider) => Promise<T>): Promise<MemoryAnswer<T>> {
    try {
      const surface = this.ctx.memory.browse()
      return { available: true, ...await call(surface) }
    } catch (error: unknown) {
      if (error instanceof MemoryError) {
        return { available: false, reason: reasonOf(error), detail: error.message }
      }
      return { available: false, reason: 'failed', detail: messageOf(error) }
    }
  }
}

export default MemoryController
