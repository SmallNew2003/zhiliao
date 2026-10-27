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
  /** The selected provider offers no browse surface, or not the section asked for. */
  | 'MEMORY_CAPABILITY_UNSUPPORTED'
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

/** One memory bank as a browse surface lists it. */
export interface MemoryBankSummary {
  /** Provider-owned bank id. */
  readonly bankId: MemoryBankId
  /** Display name the backend published for the bank. */
  readonly name: string
  /** Number of memory units the backend holds for the bank. */
  readonly factCount: number
  /** ISO-8601 instant of the bank's last write, when the backend reports one. */
  readonly lastWriteAt?: string
}

/** One counted entry of a bank statistic distribution, e.g. a fact type. */
export interface MemoryCount {
  /** Backend-owned label, such as `observation` or `semantic`. */
  readonly label: string
  /** How many nodes or links carry the label. */
  readonly count: number
}

/** A bank's numeric health and composition, as a browse surface reports it. */
export interface MemoryBankStats {
  readonly bankId: MemoryBankId
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

/** One knowledge page as a browse surface lists it. */
export interface MemoryKnowledgePage {
  readonly pageId: KnowledgePageId
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
  readonly pageId: KnowledgePageId
  readonly name: string
  /** Matching excerpt of the page body. */
  readonly snippet: string
  /** Backend relevance score; absent when the backend ranks without one. */
  readonly score?: number
}

/** One knowledge page's content. */
export interface MemoryKnowledgePageBody {
  readonly pageId: KnowledgePageId
  readonly name: string
  /** Markdown body as the backend wrote it. */
  readonly body: string
}

/** A request to search a bank's knowledge pages. */
export interface MemoryPageSearchRequest {
  /** Free-text query matched against the curated pages. */
  readonly query: string
  /** Maximum hits to return. */
  readonly limit?: number
}

/** The outcome of a knowledge-page search. */
export interface MemoryPageSearchResult {
  readonly hits: readonly MemoryKnowledgeHit[]
  /** Total matches the backend counted, which may exceed `hits.length`. */
  readonly total: number
}

/** One memory unit as a browse surface lists it: a fact, already extracted. */
export interface MemoryUnitSummary {
  /** Opaque provider-owned identifier for this unit. */
  readonly id: MemoryId
  /** The unit's text. */
  readonly text: string
  /** The backend's fact classification, when it reports one. */
  readonly factType?: string
  /** The context the unit was retained under, when the backend keeps one. */
  readonly context?: string
  /** The backend's lifecycle state for the unit, such as `valid`. */
  readonly state?: string
  /** Tags the backend attached to the unit. */
  readonly tags?: readonly string[]
  /** ISO-8601 instant the fact was mentioned, when the backend reports one. */
  readonly mentionedAt?: string
  /** ISO-8601 instant the unit was last updated, when the backend reports one. */
  readonly updatedAt?: string
}

/** A request to page through a bank's memory units. */
export interface MemoryUnitListRequest {
  /** Case-insensitive substring filter on unit text and context. */
  readonly query?: string
  /** Restrict to one backend fact type. */
  readonly factType?: string
  /** Maximum units to return. */
  readonly limit?: number
  /** Zero-based index of the first unit to return. */
  readonly offset?: number
}

/** One page of a bank's memory units. */
export interface MemoryUnitPage {
  readonly units: readonly MemoryUnitSummary[]
  /** Total units the backend holds for the request, which may exceed `units.length`. */
  readonly total: number
  readonly limit: number
  readonly offset: number
}

/** A request to record one finding in a bank. */
export interface MemoryRememberRequest {
  /** The finding, stated so it still makes sense out of context. */
  readonly text: string
  /** Optional context the backend files the finding under. */
  readonly context?: string
}

/** The outcome of recording one finding. */
export interface MemoryRememberResult {
  /** Whether the backend accepted the finding. */
  readonly remembered: boolean
  /** Backend-reported detail, such as the async operation id, when present. */
  readonly detail?: string
}

/** A request to curate one existing memory unit. */
export interface MemoryCurateRequest {
  /** Replacement text; re-embeds the unit when present. */
  readonly text?: string
  /** Replacement context; omitted leaves it unchanged. */
  readonly context?: string
  /** Replacement fact classification; omitted leaves it unchanged. */
  readonly factType?: string
}

/**
 * The outcome of curating one memory unit. A backend that refuses the curation —
 * a fact type it does not allow editing, say — answers with an error whose message
 * the consumer shows, so the outcome carries no projection of the unit: the caller
 * re-reads the bank when it wants the curated text.
 */
export interface MemoryCurateResult {
  /** Whether the backend accepted the curation. */
  readonly curated: boolean
  /** Backend-reported detail, when present. */
  readonly detail?: string
}

/**
 * The human-facing browse and write surface over the banks the agent path uses.
 *
 * `listBanks`, `listUnits`, `remember`, and `curateUnit` are what every browsable
 * provider implements: they are the operations a person performs on memory, and a
 * provider without them offers no browse surface at all. The statistics and
 * knowledge-page members are optional because they are provider-specific
 * projections — a backend without curated pages omits them, and the consumer
 * degrades that section instead of failing the whole surface.
 */
export interface MemoryBrowseProvider {
  /** Registry key, matching the owning provider's id. */
  readonly id: string
  /** List the banks the backend holds. */
  listBanks(signal?: AbortSignal): Promise<readonly MemoryBankSummary[]>
  /** Page through one bank's memory units. */
  listUnits(request: MemoryUnitListRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryUnitPage>
  /** Record one finding into a bank. */
  remember(request: MemoryRememberRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryRememberResult>
  /** Curate one existing memory unit. */
  curateUnit(request: MemoryCurateRequest, bankId: MemoryBankId, unitId: MemoryId, signal?: AbortSignal): Promise<MemoryCurateResult>
  /** One bank's statistics, when the backend measures them. */
  bankStats?(bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryBankStats>
  /** One bank's knowledge pages, when the backend curates them. */
  listPages?(bankId: MemoryBankId, signal?: AbortSignal): Promise<readonly MemoryKnowledgePage[]>
  /** Search one bank's knowledge pages, when the backend curates them. */
  searchPages?(request: MemoryPageSearchRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryPageSearchResult>
  /** Read one knowledge page's body, when the backend curates them. */
  pageBody?(bankId: MemoryBankId, pageId: KnowledgePageId, signal?: AbortSignal): Promise<MemoryKnowledgePageBody | undefined>
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
  /**
   * The browse and write surface for humans, when this provider offers one. A
   * provider without it serves the agent path only; consumers that need to
   * browse or write memory for a person resolve the surface through the seam,
   * which refuses with `MEMORY_CAPABILITY_UNSUPPORTED` when it is absent.
   */
  readonly browse?: MemoryBrowseProvider
}
