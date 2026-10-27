/**
 * Wire vocabulary of the memory browser: the projections a client renders and
 * the per-request status envelope every Remote method answers with. Types only
 * — no runtime service, no network access.
 *
 * The browse vocabulary itself — banks, statistics, knowledge pages, memory
 * units, and the write outcomes — is declared once by the memory seam and
 * re-exported here, so the wire and the seam never drift apart. This module
 * keeps only what is specific to the wire: the status envelope and each
 * method's payload.
 *
 * Every method answers a status envelope rather than throwing for a missing
 * provider or an unreachable daemon: a browser panel has to render "memory is
 * not available here", and a rejected Remote call can only become a generic
 * transport error on the client side.
 *
 * @module @deepseek-ai/dsh-host-memory-controller/types
 */

import type {
  MemoryBankStats,
  MemoryBankSummary,
  MemoryKnowledgeHit,
  MemoryKnowledgePage,
  MemoryKnowledgePageBody,
  MemoryUnitPage,
} from '@deepseek-ai/dsh-memory'

export type {
  KnowledgePageId,
  MemoryBankId,
  MemoryBankStats,
  MemoryBankSummary,
  MemoryCount,
  MemoryId,
  MemoryKnowledgeHit,
  MemoryKnowledgePage,
  MemoryKnowledgePageBody,
  MemoryUnitPage,
  MemoryUnitSummary,
} from '@deepseek-ai/dsh-memory'

/**
 * Why a memory read or write could not be answered. Stable and safe to branch
 * on; the human-facing sentence lives in the browser package's dictionary.
 *
 * - `unavailable`: no usable provider is registered on the Host, so memory is
 *   switched off for this deployment rather than broken.
 * - `misconfigured`: the Host pinned a provider id that is not registered.
 * - `unreachable`: the provider's backend did not answer in time.
 * - `unsupported`: the provider answered, but offers no browse surface or not
 *   the section asked for — a backend that serves the agent path only.
 * - `failed`: the backend answered with an error, or the bank does not exist.
 */
export type MemoryUnavailableReason =
  | 'unavailable'
  | 'misconfigured'
  | 'unreachable'
  | 'unsupported'
  | 'failed'

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

/** Payload of `memoryController.units`: one page of a bank's memory units. */
export type MemoryUnitsPayload = MemoryUnitPage

/** Payload of `memoryController.remember`. */
export interface MemoryRememberPayload {
  /** Whether the backend accepted the finding. */
  readonly remembered: boolean
  /** Backend-reported detail, such as the async operation id, when present. */
  readonly detail?: string
}

/** Payload of `memoryController.curate`. */
export interface MemoryCuratePayload {
  /** Whether the backend accepted the curation. */
  readonly curated: boolean
  /** Backend-reported detail, when present. */
  readonly detail?: string
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

/** Answer of `memoryController.units`. */
export type MemoryUnitsResult = MemoryAnswer<MemoryUnitsPayload>

/** Answer of `memoryController.remember`. */
export type MemoryRememberResult = MemoryAnswer<MemoryRememberPayload>

/** Answer of `memoryController.curate`. */
export type MemoryCurateResult = MemoryAnswer<MemoryCuratePayload>
