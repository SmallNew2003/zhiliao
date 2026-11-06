# 长期记忆

[English](memory.md) | 中文

## 概述

记忆能力将工作区的长期知识关联到提供者拥有的记忆库。[记忆服务](../../packages/memory/memory/README.zh.md)选择注册的提供者，执行有界搜索、开场召回与会话转录保留。[浏览器 Remote](../../packages/host/memory-controller/README.zh.md)在资源授权下提供只读记忆库与知识页。

## 目录

- [提供者类型](#provider-vocabulary)
- [浏览器类型](#browser-vocabulary)
- [失败与上下文语义](#failure-and-context-semantics)

<a id="provider-vocabulary"></a>
## 提供者类型

[提供者类型](../../packages/memory/memory/src/types.ts)定义以下值；后端标识符对消费者保持不透明。

| 类型 | 含义 |
|---|---|
| `MemoryBankId`、`MemoryId`、`KnowledgePageId` | 记忆库、记忆单元与知识页的不同品牌标识 |
| `MemoryUnit` | 提供者格式化的文本，可包含记忆库归属 |
| `MemorySearchRequest`、`MemorySearchResult` | 自由文本查询、可选单元上限、有序结果与截断状态 |
| `MemoryRecallRequest`、`MemoryRecallResult` | 开场提示词、可选上限与相关记忆单元 |
| `TranscriptTurn`、`MemoryRetainRequest`、`MemoryRetainResult` | 带归属的对话文本与后端保留回执 |
| `MemoryProvider` | 可用性、记忆库解析、搜索、召回与保留操作，传递调用方取消信号 |
| `MemoryErrorCode`、`MemoryError` | 稳定的提供者选择与后端失败分类 |

记忆库 ID 不是文件系统路径。[Hindsight 提供者](../../packages/memory/hindsight-http/README.zh.md)负责工作区到记忆库的解析与 HTTP 验证；即使提供者返回更多单元，服务仍执行请求上限。

<a id="browser-vocabulary"></a>
## 浏览器类型

[浏览器类型](../../packages/host/memory-controller/src/types.ts)通过 `MemoryAnswer<T>` 与 `MemoryUnavailableReason` 区分成功值和不可用状态。`MemoryBankSummary`、`MemoryCount` 与 `MemoryBankStats` 描述记忆库元数据；`MemoryKnowledgePage`、`MemoryKnowledgeHit` 与 `MemoryKnowledgePageBody` 描述知识页发现与内容。

`MemoryBanksPayload`、`MemoryStatsPayload`、`MemoryPagesPayload`、`MemorySearchPayload` 与 `MemoryPagePayload` 承载操作值。`MemoryListResult`、`MemoryStatsResult`、`MemoryPagesResult`、`MemorySearchResult` 与 `MemoryPageResult` 为 Remote 调用者包装这些值。浏览器搜索结果包含知识页命中，提供者搜索结果包含记忆单元。

<a id="failure-and-context-semantics"></a>
## 失败与上下文语义

提供者选择错误与后端失败保持显式，不可用后端不会变成成功的空结果。[生命周期消费者](../../packages/memory/tool-memory/README.zh.md)负责降级补充，并在召回文本进入模型请求前记录它。保留与记忆库初始播种不修改 Session 表层。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
