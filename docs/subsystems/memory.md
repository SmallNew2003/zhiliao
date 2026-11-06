# Memory

English | [中文](memory.zh.md)

## Summary

Memory associates durable workspace knowledge with a provider-owned bank. The [memory service](../../packages/memory/memory/README.md) selects a registered provider for bounded search, opening recall, and transcript retention. The [browser Remote](../../packages/host/memory-controller/README.md) exposes read-only banks and knowledge pages under resource authorization.

## Table of Contents

- [Provider vocabulary](#provider-vocabulary)
- [Browser vocabulary](#browser-vocabulary)
- [Failure and context semantics](#failure-and-context-semantics)

<a id="provider-vocabulary"></a>
## Provider vocabulary

The [provider types](../../packages/memory/memory/src/types.ts) own these values; providers keep backend identifiers opaque.

| Types | Meaning |
|---|---|
| `MemoryBankId`, `MemoryId`, `KnowledgePageId` | Distinct branded identities for a bank, memory unit, and knowledge page |
| `MemoryUnit` | Provider-formatted text with optional bank attribution |
| `MemorySearchRequest`, `MemorySearchResult` | Free-text query, optional unit limit, ordered units, and truncation status |
| `MemoryRecallRequest`, `MemoryRecallResult` | Opening prompt, optional limit, and relevant memory units |
| `TranscriptTurn`, `MemoryRetainRequest`, `MemoryRetainResult` | Attributed conversation text and backend retention receipt |
| `MemoryProvider` | Availability, bank resolution, search, recall, and retention operations with caller cancellation |
| `MemoryErrorCode`, `MemoryError` | Stable provider-selection and backend failure classification |

A bank id is not a filesystem path. The [Hindsight provider](../../packages/memory/hindsight-http/README.md) owns workspace-to-bank resolution and HTTP validation; the service enforces requested unit limits even when a provider returns more units.

<a id="browser-vocabulary"></a>
## Browser vocabulary

The [browser types](../../packages/host/memory-controller/src/types.ts) separate successful values from unavailable states through `MemoryAnswer<T>` and `MemoryUnavailableReason`. `MemoryBankSummary`, `MemoryCount`, and `MemoryBankStats` describe bank metadata; `MemoryKnowledgePage`, `MemoryKnowledgeHit`, and `MemoryKnowledgePageBody` describe page discovery and content.

`MemoryBanksPayload`, `MemoryStatsPayload`, `MemoryPagesPayload`, `MemorySearchPayload`, and `MemoryPagePayload` carry operation values. `MemoryListResult`, `MemoryStatsResult`, `MemoryPagesResult`, `MemorySearchResult`, and `MemoryPageResult` wrap those values for Remote callers. The browser search result contains knowledge-page hits; the provider search result contains memory units.

<a id="failure-and-context-semantics"></a>
## Failure and context semantics

Provider selection errors and backend failures stay explicit; an unavailable backend does not become an empty successful result. The [lifecycle consumer](../../packages/memory/tool-memory/README.md) owns degraded enrichment and records recalled text before it enters a model request. Retention and initial bank seeding do not alter the Session surface.

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

<a id="ctxmemorycontroller--memorycontroller"></a>

### `ctx.memoryController` — `MemoryController`

Remote-only service exposing the memory daemon's read-only browse surface: bank listing, per-bank statistics, the knowledge-page tree, knowledge-base search, and one page's body.

Registered as `ctx.memoryController` under the `memoryController` namespace, which is distinct from the `memory` seam's own key so the two never collide.

```ts cordis-catalog
/**
 * List the memory banks the daemon holds, so a browser can pick one to read.
 * @returns the banks with their fact counts and last-write instants, or why
 * the listing is unavailable.
 */
@Remote('list') async list(): Promise<MemoryListResult>

/**
 * Read one bank's statistics: node, link, and document totals plus the fact
 * type and link type distributions.
 * @param bankId - provider-owned bank id; contains `::`, so it is encoded.
 * @returns the statistics, or why they are unavailable.
 */
@Remote('stats') async stats(bankId: string): Promise<MemoryStatsResult>

/**
 * List one bank's knowledge pages as a flat, depth-first list.
 * @param bankId - provider-owned bank id.
 * @returns the pages, or why the tree is unavailable.
 */
@Remote('pages') async pages(bankId: string): Promise<MemoryPagesResult>

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
@Remote('search') async search(bankId: string, query: string, limit: number | undefined): Promise<MemorySearchResult>

/**
 * Read one knowledge page's body.
 * @param bankId - provider-owned bank id.
 * @param pageId - provider-owned page id.
 * @returns the page body, a result without a page when the daemon holds none
 * under that id, or why the read is unavailable.
 */
@Remote('page') async page(bankId: string, pageId: string): Promise<MemoryPageResult>
```

Source: [`packages/host/memory-controller/src/index.ts`](../../packages/host/memory-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->
