# Memory

English | [中文](memory.zh.md)

The long-term memory seam of [`@deepseek-ai/dsh-memory`](../../packages/memory/memory) answers three questions about a workspace's durable knowledge: which bank owns this directory, what does the bank already know that is relevant now, and what from a finished turn is worth keeping. It owns the provider contract, bank identity, the three request/result vocabularies, and the `ctx.memory` service that selects one provider and forwards every call to it. Provider selection, degradation, and the error classification live on the [package README](../../packages/memory/memory/README.md).

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

## Provider contract and selection

A provider is the only thing that talks to a backend. It declares a registry id, reports whether it can currently serve, and implements the four operations. `MemoryRuntime` holds the configured provider name, resolves it once at startup, and routes every call through it; a composition that registers no provider, or registers two under one id, fails loud at the point of use rather than falling back to a default.

`resolveBank` is asynchronous because a backend may need to create the bank it does not yet have. The other three operations take an already-resolved `MemoryBankId`, so a caller that resolved a bank once can search, recall, and retain against it without repeating the round trip.

## Degradation discipline

Every method raises {@link MemoryError} rather than returning an empty result when the provider is missing or unhealthy. An empty result would read as "this workspace has no relevant memory", which is a claim the seam cannot make. Callers on the agent hot path are expected to catch: memory is enrichment, so a slow or unreachable backend must cost a log line rather than a failed turn.

The seam also enforces `request.limit` itself. `search` and `recall` truncate an over-returning provider's `units` and set `truncated`, so a provider that ignores the limit cannot widen the model context.

## Bank identity and scope

A bank is scoped to one absolute workspace root. `MemoryBankId` is branded and contains `::`, so a caller cannot pass a bare directory path where a bank is required, and URLs carrying a bank id must encode it.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryruntime"></a>

### `ctx.memory` — `MemoryRuntime`

The long-term memory service. Registered as `ctx.memory` (one instance per context).

Selection semantics (resolved at call time, never order-dependent):

- A configured id that is registered and `available()` → that provider.
- A configured id not registered → `MEMORY_PROVIDER_CONFIGURED_MISSING`.
- No id configured, exactly one registered usable provider → that provider.
- No id configured, multiple usable providers → `MEMORY_PROVIDER_UNAVAILABLE`.
- No id configured, no usable provider → `MEMORY_PROVIDER_UNAVAILABLE`.

Every method degrades loudly rather than silently: a missing or unhealthy backend raises MemoryError so callers can decide to warn and continue. Callers on the agent hot path are expected to catch, because memory must never block a turn.

```ts cordis-catalog
/**
 * Register a memory provider. Throws {@link MemoryError} `MEMORY_DUPLICATE_PROVIDER`
 * when its id is taken. Returns a disposer; disposed with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerProvider(provider: MemoryProvider): () => void

/**
 * Whether a usable provider is currently registered. Callers on the agent hot path
 * check this first so a disabled or unreachable backend costs nothing.
 *
 * This never throws: "is memory usable" must be answerable as `false`, otherwise every
 * caller needs its own try/catch around the question. A misconfigured provider id is
 * still reported through {@link MemoryError} on the calls that need a provider.
 * @returns true when at least one registered provider reports itself available.
 */
isAvailable(): boolean

/**
 * Resolve the bank that owns `workspaceRoot`, creating it when absent. Selection
 * errors surface here unchanged.
 * @param workspaceRoot - absolute directory whose bank should be resolved.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the bank id for that workspace.
 */
async resolveBank(workspaceRoot: string, signal?: AbortSignal): Promise<MemoryBankId>

/**
 * Search a bank's memories through the selected provider. The seam enforces
 * `request.limit`: an over-returning provider's `units` are truncated and
 * `truncated` set.
 * @param request - the query and optional limit.
 * @param bankId - the bank to search.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the search outcome, capped to `request.limit`.
 */
async search(request: MemorySearchRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemorySearchResult>

/**
 * Recall memories relevant to a session opening. The seam enforces `request.limit`.
 * @param request - the opening prompt and optional limit.
 * @param bankId - the bank to recall from.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the recall outcome, capped to `request.limit`.
 */
async recall(request: MemoryRecallRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryRecallResult>

/**
 * Retain a finished session's transcript into a bank.
 * @param request - the transcript to retain.
 * @param bankId - the bank to retain into.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the retention outcome reported by the backend.
 */
async retain(request: MemoryRetainRequest, bankId: MemoryBankId, signal?: AbortSignal): Promise<MemoryRetainResult>
```

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
