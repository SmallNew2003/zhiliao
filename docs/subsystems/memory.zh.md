# 记忆

[English](memory.md) | 中文

[`@deepseek-ai/dsh-memory`](../../packages/memory/memory) 的长期记忆 seam 回答关于一个工作区持久知识的三个问题：哪个 bank 拥有这个目录、bank 中与当前相关的内容是什么、一个已结束轮次中有什么值得保留。它拥有 provider 契约、bank 标识、三套请求/结果词汇，以及负责选中一个 provider 并把所有调用转发给它的 `ctx.memory` 服务。provider 选择、降级与错误分类见[包 README](../../packages/memory/memory/README.zh.md)。

源码：[`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

## provider 契约与选择

provider 是唯一与后端通信的一方。它声明一个注册 id、报告当前是否可服务，并实现四个操作。`MemoryRuntime` 持有配置的 provider 名称，在启动时解析一次，随后把所有调用路由给它；一个没有注册 provider、或在同一 id 下注册了两个 provider 的组合会在使用时明确失败，而不是回退到某个默认实现。

`resolveBank` 是异步的，因为后端可能需要创建它尚未拥有的 bank。另外三个操作接收已解析的 `MemoryBankId`，因此调用方解析一次之后，就能反复对它执行搜索、召回与保留，无需重复往返。

## 降级纪律

当 provider 缺失或不健康时，每个方法都抛出 {@link MemoryError}，而不是返回空结果。空结果会被读成「这个工作区没有相关记忆」，而这是 seam 无法做出的断言。agent 热路径上的调用方应当捕获它：记忆是增强信息，所以缓慢或不可达的后端只应产生一行日志，而不应让一个轮次失败。

seam 还自己强制执行 `request.limit`。`search` 与 `recall` 会截断超额返回的 provider 的 `units` 并置位 `truncated`，因此忽略上限的 provider 无法借此放大模型上下文。

## bank 标识与作用域

一个 bank 对应一个绝对工作区根。`MemoryBankId` 是品牌化类型且包含 `::`，所以调用方无法把裸目录路径当作 bank 传入，携带 bank id 的 URL 也必须对它编码。

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
<!-- END GENERATED cordis-surface -->
