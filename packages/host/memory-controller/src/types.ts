/**
 * Wire vocabulary of the memory browser: the projections a client renders and
 * the per-request status envelope every Remote method answers with. Types only
 * — no runtime service, no network access.
 *
 * Every method answers a status envelope rather than throwing for a missing
 * provider or an unreachable daemon: a browser panel has to render "memory is
 * not available here", and a rejected Remote call can only become a generic
 * transport error on the client side.
 *
 * @module @deepseek-ai/dsh-host-memory-controller/types
 */

/**
 * Why a memory read could not be answered. Stable and safe to branch on; the
 * human-facing sentence lives in the browser package's dictionary.
 *
 * - `unavailable`: no usable provider is registered on the Host, so memory is
 *   switched off for this deployment rather than broken.
 * - `misconfigured`: the Host pinned a provider id that is not registered.
 * - `unreachable`: the provider's backend did not answer in time.
 * - `failed`: the backend answered with an error, or the bank does not exist.
 */
export type MemoryUnavailableReason =
  | 'unavailable'
  | 'misconfigured'
  | 'unreachable'
  | 'failed'

/** One memory bank as the browser lists it. */
export interface MemoryBankSummary {
  /** Provider-owned bank id; contains `::`, so URLs must encode it. */
  readonly bankId: string
  /** Display name the backend published for the bank. */
  readonly name: string
  /** Number of facts the backend holds for the bank. */
  readonly factCount: number
  /** ISO-8601 instant of the bank's last write, when the backend reports one. */
  readonly lastWriteAt?: string
}

/** One counted entry of a bank statistic distribution, e.g. a fact type. */
export interface MemoryCount {
  /** Backend-owned label, such as `experience` or `semantic`. */
  readonly label: string
  /** How many nodes or links carry the label. */
  readonly count: number
}

/** A bank's numeric health and composition, as the browser's statistics block. */
export interface MemoryBankStats {
  readonly bankId: string
  readonly totalNodes: number
  readonly totalLinks: number
  readonly totalDocuments: number
  /** Node counts per fact type, as the backend reported them. */
  readonly nodesByFactType: readonly MemoryCount[]
  /** Link counts per link type, as the backend reported them. */
  readonly linksByLinkType: readonly MemoryCount[]
  /** Operations the backend has not finished. */
  readonly pendingOperations: number
  /** Operations the backend could not complete. */
  readonly failedOperations: number
}

/** One knowledge page as the browser's page browser lists it. */
export interface MemoryKnowledgePage {
  readonly pageId: string
  readonly name: string
  /** The prompt the page was generated from, when the backend keeps one. */
  readonly description?: string
  /** ISO-8601 instant of the page's last refresh, when the backend reports one. */
  readonly updatedAt?: string
  /** Whether the backend marked the page as due for a refresh. */
  readonly stale: boolean
}

/** One knowledge-base search hit. */
export interface MemoryKnowledgeHit {
  readonly pageId: string
  readonly name: string
  /** Matching excerpt of the page body. */
  readonly snippet: string
  /** Backend relevance score; absent when the backend ranks without one. */
  readonly score?: number
}

/** One knowledge page's rendered content. */
export interface MemoryKnowledgePageBody {
  readonly pageId: string
  readonly name: string
  /** Markdown body the browser renders as preformatted text. */
  readonly body: string
}

/** The answers a Remote method settles with: a payload, or why there is none. */
export type MemoryAnswer<T> =
  | ({ readonly available: true } & T)
  | {
    readonly available: false
    /** Stable classification the browser words through its dictionary. */
    readonly reason: MemoryUnavailableReason
    /** The Host's diagnostic or the provider's message, shown verbatim. */
    readonly detail: string
  }

/** Payload of `memoryController.list`. */
export interface MemoryBanksPayload {
  readonly banks: readonly MemoryBankSummary[]
}

/** Payload of `memoryController.stats`. */
export interface MemoryStatsPayload {
  /** Absent when the backend answered a bank it could not measure. */
  readonly stats?: MemoryBankStats
}

/** Payload of `memoryController.pages`. */
export interface MemoryPagesPayload {
  readonly pages: readonly MemoryKnowledgePage[]
}

/** Payload of `memoryController.search`. */
export interface MemorySearchPayload {
  readonly hits: readonly MemoryKnowledgeHit[]
  /** Total matches the backend counted, which may exceed `hits.length`. */
  readonly total: number
}

/** Payload of `memoryController.page`. */
export interface MemoryPagePayload {
  /** Absent when the backend has no page under that id. */
  readonly page?: MemoryKnowledgePageBody
}

/** Answer of `memoryController.list`. */
export type MemoryListResult = MemoryAnswer<MemoryBanksPayload>

/** Answer of `memoryController.stats`. */
export type MemoryStatsResult = MemoryAnswer<MemoryStatsPayload>

/** Answer of `memoryController.pages`. */
export type MemoryPagesResult = MemoryAnswer<MemoryPagesPayload>

/** Answer of `memoryController.search`. */
export type MemorySearchResult = MemoryAnswer<MemorySearchPayload>

/** Answer of `memoryController.page`. */
export type MemoryPageResult = MemoryAnswer<MemoryPagePayload>
