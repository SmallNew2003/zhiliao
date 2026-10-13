/**
 * Shared vocabulary for the long-term memory capability seam (`ctx.memory`): provider
 * contracts, the request/result shapes every provider speaks, and the MemoryError
 * taxonomy. Types and error codes only — no runtime service, no network access.
 * @module @deepseek-ai/dsh-memory/types
 */

/**
 * A memory bank id, the unit hindsight stores and retrieves memories under. Banks are
 * resolved per repository so a codebase keeps its own memory without colliding with a
 * sibling checkout or another harness sharing the same daemon.
 */
export type MemoryBankId = string & { readonly [memoryBrand]: 'MemoryBankId' }

/**
 * A durable memory identifier, opaque across the seam boundary. Consumers must not
 * parse it: providers own its representation.
 */
export type MemoryId = string & { readonly [memoryBrand]: 'MemoryId' }

/** A knowledge-page identifier — a curated, human-readable page over the bank's memories. */
export type KnowledgePageId = string & { readonly [memoryBrand]: 'KnowledgePageId' }

/** Brand marker for opaque seam identifiers; never constructed at runtime. */
declare const memoryBrand: unique symbol

/**
 * Cast a plain string to a branded memory bank id.
 * @param value - the raw bank id.
 * @returns the same value, typed as a {@link MemoryBankId}.
 */
export function memoryBankId(value: string): MemoryBankId {
  return value as MemoryBankId
}

/**
 * Cast a plain string to a branded memory id.
 * @param value - the raw memory id.
 * @returns the same value, typed as a {@link MemoryId}.
 */
export function memoryId(value: string): MemoryId {
  return value as MemoryId
}

/**
 * Cast a plain string to a branded knowledge page id.
 * @param value - the raw page id.
 * @returns the same value, typed as a {@link KnowledgePageId}.
 */
export function knowledgePageId(value: string): KnowledgePageId {
  return value as KnowledgePageId
}

/** Error codes raised by the memory seam and its providers. */
export type MemoryErrorCode =
  /** No provider is registered for the requested capability. */
  | 'MEMORY_PROVIDER_UNAVAILABLE'
  /** The configured provider id is not registered. */
  | 'MEMORY_PROVIDER_CONFIGURED_MISSING'
  /** A provider with this id is already registered. */
  | 'MEMORY_DUPLICATE_PROVIDER'
  /** The provider reached its backend but the backend rejected the request. */
  | 'MEMORY_BACKEND_ERROR'
  /** The provider's backend did not answer in time. */
  | 'MEMORY_BACKEND_TIMEOUT'
  /** The requested bank does not exist. */
  | 'MEMORY_BANK_NOT_FOUND'
  /**
   * Several usable providers are registered and none was selected, so the seam refuses
   * to guess. Distinct from `MEMORY_PROVIDER_UNAVAILABLE` because the fix is to configure
   * a provider id, not to install one.
   */
  | 'MEMORY_PROVIDER_AMBIGUOUS'

/**
 * An error raised by the memory seam or one of its providers. `code` is stable and
 * safe to branch on; `message` is human-facing and may change.
 */
export class MemoryError extends Error {
  /** Stable, machine-branchable classification of this failure. */
  readonly code: MemoryErrorCode

  constructor(message: string, code: MemoryErrorCode) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
  }
}

/** One recalled or retained memory unit, as the seam projects provider payloads. */
export interface MemoryUnit {
  /** Opaque provider-owned identifier for this unit. */
  readonly id: MemoryId
  /** The unit's text, already formatted for model consumption. */
  readonly text: string
  /** Optional bank attribution, present on units returned across banks. */
  readonly bankId?: MemoryBankId
}

/** A request to search a bank's memories. */
export interface MemorySearchRequest {
  /** Free-text query; providers pass it to their own hybrid index. */
  readonly query: string
  /** Maximum units to return. The seam truncates when a provider over-returns. */
  readonly limit?: number
}

/** The outcome of a memory search. */
export interface MemorySearchResult {
  /** Matching units, ordered by provider relevance (best first). */
  readonly units: readonly MemoryUnit[]
  /** Whether the seam truncated `units` to honour `request.limit`. */
  readonly truncated: boolean
}

/** A request to recall memories for a session opening. */
export interface MemoryRecallRequest {
  /** The session's opening prompt, used to derive a recall query. */
  readonly prompt: string
  /** Maximum units to return; the seam truncates when a provider over-returns. */
  readonly limit?: number
}

/** The outcome of a session-opening recall. */
export interface MemoryRecallResult {
  /** Units worth injecting into context, already ordered by relevance. */
  readonly units: readonly MemoryUnit[]
  /** Whether the seam truncated `units` to honour `request.limit`. */
  readonly truncated: boolean
}

/** One exchange in a transcript handed to a provider for retention. */
export interface TranscriptTurn {
  /** Zero-based turn index within the session. */
  readonly turn: number
  /** The user prompt for this turn. */
  readonly prompt: string
  /** The assistant's reply, or undefined when the turn produced none. */
  readonly response?: string
}

/** A request to retain a finished session into a bank. */
export interface MemoryRetainRequest {
  /** The transcript to retain, oldest turn first. */
  readonly turns: readonly TranscriptTurn[]
  /** The bank to retain into; defaults to the session's resolved bank. */
  readonly bankId?: MemoryBankId
}

/** The outcome of a retention request. */
export interface MemoryRetainResult {
  /** Whether the backend accepted and persisted the transcript. */
  readonly retained: boolean
  /** Backend-reported detail, when present. */
  readonly detail?: string
}

/**
 * A long-term memory backend. Providers implement this contract against a concrete
 * store; the seam never calls the network itself.
 */
export interface MemoryProvider {
  /** Registry key. Unique per capability. */
  readonly id: string
  /**
   * Whether this provider can currently serve requests. A provider whose backend is
   * down reports false so the seam can degrade instead of failing every call.
   */
  available(): boolean
  /**
   * Resolve the bank that owns `workspaceRoot`, creating it when absent. Asynchronous
   * because a provider may need to consult or create the bank on its backend.
   */
  resolveBank(workspaceRoot: string, signal?: AbortSignal): Promise<MemoryBankId>
  /** Search a bank's memories. */
  search(request: MemorySearchRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemorySearchResult>
  /** Recall memories relevant to a session opening. */
  recall(request: MemoryRecallRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryRecallResult>
  /** Retain a finished session's transcript into a bank. */
  retain(request: MemoryRetainRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryRetainResult>
}
