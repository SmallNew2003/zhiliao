/**
 * Service Definition for the long-term memory capability seam (`ctx.memory`): a provider
 * registry plus bank-resolved recall, search, retention, and the optional browse
 * surface a human-facing consumer resolves through {@link MemoryRuntime.browse}.
 * Duplicate ids are rejected.
 * At call time a configured provider must be registered and usable, so selection never
 * depends on registration order. The seam performs no network access itself.
 * @module @deepseek-ai/dsh-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  MemoryBankId,
  MemoryBrowseProvider,
  MemoryProvider,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRetainRequest,
  MemoryRetainResult,
  MemorySearchRequest,
  MemorySearchResult,
} from './types.ts'
import { MemoryError } from './types.ts'

export {
  knowledgePageId,
  memoryBankId,
  memoryId,
  MemoryError,
} from './types.ts'
export type {
  KnowledgePageId,
  MemoryBankId,
  MemoryBankStats,
  MemoryBankSummary,
  MemoryBrowseProvider,
  MemoryCount,
  MemoryCurateRequest,
  MemoryCurateResult,
  MemoryErrorCode,
  MemoryId,
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
  MemoryUnitListRequest,
  MemoryUnitPage,
  MemoryUnitSummary,
  TranscriptTurn,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryRuntime
  }
}

/**
 * Config for the memory seam. `provider` pins which registered provider wins; it is
 * optional because a single registered usable provider auto-selects. Deployment-varying
 * choices live here (or in cordis.yml against these fields) rather than in constants.
 */
export interface MemoryRuntimeConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one usable provider exists. */
  readonly provider?: string
}

/**
 * The long-term memory service. Registered as `ctx.memory` (one instance per context).
 *
 * Selection semantics (resolved at call time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `MEMORY_PROVIDER_CONFIGURED_MISSING`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `MEMORY_PROVIDER_UNAVAILABLE`.
 * - No id configured, no usable provider → `MEMORY_PROVIDER_UNAVAILABLE`.
 *
 * Every method degrades loudly rather than silently: a missing or unhealthy backend
 * raises {@link MemoryError} so callers can decide to warn and continue. Callers on the
 * agent hot path are expected to catch, because memory must never block a turn.
 */
export class MemoryRuntime extends Service {
  /** Provider selection config; `$DSH_MEMORY_PROVIDER` is equivalent, not a hidden priority chain. */
  static Config: z<MemoryRuntimeConfig> = z.object({
    provider: z.string(),
  })

  private readonly providers = new Map<string, MemoryProvider>()
  private readonly providerId: string | undefined

  constructor(ctx: Context, config: MemoryRuntimeConfig = {}) {
    super(ctx, 'memory')
    this.providerId = config.provider ?? process.env.DSH_MEMORY_PROVIDER
  }

  /**
   * Register a memory provider. Throws {@link MemoryError} `MEMORY_DUPLICATE_PROVIDER`
   * when its id is taken. Returns a disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: MemoryProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new MemoryError(`a memory provider with id "${provider.id}" is already registered`, 'MEMORY_DUPLICATE_PROVIDER')
    }
    const { providers } = this
    const dispose = this.ctx.effect(function* () {
      providers.set(provider.id, provider)
      yield () => providers.delete(provider.id)
    }, 'memory.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Whether a usable provider is currently registered. Callers on the agent hot path
   * check this first so a disabled or unreachable backend costs nothing.
   *
   * This never throws: "is memory usable" must be answerable as `false`, otherwise every
   * caller needs its own try/catch around the question. A misconfigured provider id is
   * still reported through {@link MemoryError} on the calls that need a provider.
   * @returns true when at least one registered provider reports itself available.
   */
  isAvailable(): boolean {
    try {
      this.selectProvider()
      return true
    } catch {
      return false
    }
  }

  /**
   * Resolve the bank that owns `workspaceRoot`, creating it when absent. Selection
   * errors surface here unchanged.
   * @param workspaceRoot - absolute directory whose bank should be resolved.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the bank id for that workspace.
   */
  async resolveBank(workspaceRoot: string, signal?: AbortSignal): Promise<MemoryBankId> {
    return this.requireProvider().resolveBank(workspaceRoot, signal)
  }

  /**
   * Search a bank's memories through the selected provider. The seam enforces
   * `request.limit`: an over-returning provider's `units` are truncated and
   * `truncated` set.
   * @param request - the query and optional limit.
   * @param bankId - the bank to search.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the search outcome, capped to `request.limit`.
   */
  async search(request: MemorySearchRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemorySearchResult> {
    const result = await this.requireProvider().search(request, bankId, signal)
    return capUnits(result, request.limit)
  }

  /**
   * Recall memories relevant to a session opening. The seam enforces `request.limit`.
   * @param request - the opening prompt and optional limit.
   * @param bankId - the bank to recall from.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the recall outcome, capped to `request.limit`.
   */
  async recall(request: MemoryRecallRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryRecallResult> {
    const result = await this.requireProvider().recall(request, bankId, signal)
    return capUnits(result, request.limit)
  }

  /**
   * Retain a finished session's transcript into a bank.
   * @param request - the transcript to retain.
   * @param bankId - the bank to retain into.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the retention outcome reported by the backend.
   */
  async retain(request: MemoryRetainRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryRetainResult> {
    return this.requireProvider().retain(request, bankId, signal)
  }

  /**
   * The browse and write surface of the selected provider, for consumers that act
   * on memory on a person's behalf rather than on the agent's.
   *
   * Selection runs per call, exactly as it does for the agent-path methods, so a
   * provider that appears or disappears between calls is honoured. A selected
   * provider that offers no browse surface raises
   * `MEMORY_CAPABILITY_UNSUPPORTED` — a backend that serves recall and retention
   * only is a valid composition, not a failure.
   * @returns the selected provider's browse surface.
   * @throws MemoryError when no provider is selectable, or the selected one has
   * no browse surface.
   */
  browse(): MemoryBrowseProvider {
    const provider = this.selectProvider()
    if (provider.browse === undefined) {
      throw new MemoryError(`memory provider "${provider.id}" offers no browse surface`, 'MEMORY_CAPABILITY_UNSUPPORTED')
    }
    return provider.browse
  }

  /**
   * The provider every call goes through. `selectProvider` either returns a usable
   * provider or throws a classified {@link MemoryError}, so this adds no behaviour of
   * its own; it exists to name the intent at each call site.
   */
  private requireProvider(): MemoryProvider {
    return this.selectProvider()
  }

  /**
   * Resolve the selected provider, or throw the classified reason it cannot be resolved.
   * Never returns undefined: an unusable selection is an error, not an absence.
   */
  private selectProvider(): MemoryProvider {
    if (this.providerId !== undefined) {
      const provider = this.providers.get(this.providerId)
      if (provider === undefined) {
        throw new MemoryError(`configured memory provider "${this.providerId}" is not registered`, 'MEMORY_PROVIDER_CONFIGURED_MISSING')
      }
      if (!provider.available()) {
        throw new MemoryError(`configured memory provider "${this.providerId}" is registered but unavailable`, 'MEMORY_PROVIDER_UNAVAILABLE')
      }
      return provider
    }
    const usable = [...this.providers.values()].filter(provider => provider.available())
    const [single] = usable
    if (single === undefined) {
      throw new MemoryError('no usable memory provider is registered', 'MEMORY_PROVIDER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.id).join(', ')
      throw new MemoryError(`multiple usable memory providers are registered (${ids}); configure one explicitly`, 'MEMORY_PROVIDER_AMBIGUOUS')
    }
    return single
  }
}

/**
 * Enforce `limit` on a units-bearing result: truncate `units` and flag it. A provider
 * that returns more than asked for is corrected here rather than trusted.
 */
function capUnits<T extends { readonly units: readonly unknown[]; readonly truncated: boolean }>(result: T, limit: number | undefined): T {
  if (limit === undefined || result.units.length <= limit) return result
  return { ...result, units: result.units.slice(0, limit), truncated: true }
}

export default MemoryRuntime
