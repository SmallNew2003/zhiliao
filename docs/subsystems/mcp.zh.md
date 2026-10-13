# MCP

[English](mcp.md) | 中文

## 摘要

模型上下文协议（Model Context Protocol，MCP）让模型按需使用外部服务器的工具与资源。连接插件发现工具，统一发现服务将所选定义与完整服务器指令准入后续请求。执行仍支持取消、权限检查、结果记录与受支持的图像输出。官方 SDK 协商现代或受支持的旧版协议。本页说明 MCP 的作用域、选择和提供方语义；[客户端 README](../../packages/mcp/mcp-client/README.zh.md)维护连接配置，[发现服务 README](../../packages/mcp/mcp-discovery/README.zh.md)维护准入预算。

## 目录

- [配置](#configuration)
- [职责与作用域](#responsibilities-and-scope)
- [协议与结果](#protocol-and-results)
- [渐进发现与请求身份](#progressive-discovery-and-request-identity)
- [资源与指令](#resources-and-instructions)
- [发现类型](#discovery-types)
- [持久选择类型](#durable-selection-types)
- [资源提供方类型](#resource-provider-types)
- [限制](#limits)
- [延伸阅读](#further-reading)

-----

<a id="configuration"></a>
## 配置

MCP 服务器需要主动配置。在目标 Cordis 作用域中，为每台服务器配置一个 `@deepseek-ai/dsh-mcp-client` 条目。随附 profile 提供[工具注册表](tools.zh.md)、共享发现与资源服务；用户只需添加客户端条目。没有可见服务器时，native 与 PTC 模式都不接收 MCP 工具或提示词文本。自定义组合中的发现服务需要 `tools`、`systemPrompt` 与 `sessionProjections`；客户端和资源服务需要 `mcpDiscovery`。

| 选择 | 配置维护位置 |
|---|---|
| 发现目录、定义与指令预算，以及可选辅助选择器 | [发现服务配置](../../packages/mcp/mcp-discovery/README.zh.md#use-this-package)；选择器默认关闭 |
| 服务器身份、本地进程或 HTTP 端点、凭据和进程环境 | [客户端配置](../../packages/mcp/mcp-client/README.zh.md#use-this-package) |
| 工具与资源请求超时、启动失败策略和重连 | [客户端配置](../../packages/mcp/mcp-client/README.zh.md#use-this-package) |
| 资源发现与读取 | 随附 profile 已包含 [MCP 资源服务](../../packages/mcp/mcp-resources/README.zh.md#use-this-package)；该服务没有配置字段 |
| 服务器指令大小限制 | 客户端 `maxInstructionBytes`；组合提供[系统提示词装配](system-prompt.zh.md) |
| 权限决策和受支持的图像输出 | [工具执行](tools.zh.md)和[附件](attachment.zh.md) |

协议协商遵循 SDK 支持的修订版；产品没有强制指定协议修订版的设置。[配置目录](../config-catalog.zh.md#deepseek-aidsh-mcp-client) 列出客户端接受的字段和默认值。

-----

<a id="responsibilities-and-scope"></a>
## 职责与作用域

客户端是每服务器一个的连接插件，将已发现工具适配到普通 Harness 执行，并向 `ctx.mcpDiscovery` 提供连接状态与指令。外部服务器实现 MCP 操作，SDK 负责协议交换。`mcp-discovery` 管理权限过滤后的目录、按需呈现与请求身份；它不会改变工具授权。

`mcp-resources` 拥有共享资源工具，并在调用方作用域中选择提供方。每个 MCP 客户端通过自己的连接提供资源操作。作用域中的首个提供方启用本地共享工具，移除最后一个提供方时移除这些工具；继承的提供方仍然可见。服务独立于任何单一客户端拥有这些工具注册。只要可见的客户端条目保持激活，连接失败就不会移除共享资源工具。

配置的 `serverName` 在注册作用域内标识服务器。同一作用域中的两个条目不能占用相同名称；不同 Agent 作用域可以复用该名称。公开工具名包含配置的服务器名称，因此不同服务器的同名工具仍可区分。注册副作用拥有名称和已发现工具；插件释放时关闭连接并移除其贡献。

[原生 Cua Driver 提供方](../../packages/experimental/computer-use-cua-driver-native/README.zh.md) 复用客户端导出的结果适配器，无需打开 MCP 连接。桌面提供方选择属于[计算机使用子系统](computer-use.zh.md)。

-----

<a id="protocol-and-results"></a>
## 协议与结果

stdio 和 Streamable HTTP 都使用官方 SDK 的协商、发现、协议校验和取消机制。工具列表变化通过旧版通知或现代订阅触发发现。刷新失败时保留上一代工具；连接恢复遵循[客户端生命周期](../../packages/mcp/mcp-client/README.zh.md#use-this-package)。

结果适配器为程序化调用方保留规范 MCP JSON，并准备普通工具内容。受支持的图像使用附件系统；不受支持的富内容产生明确的文本诊断。工具注册表仍决定策略失败和结果替换。[工具契约](tools.zh.md) 维护记录和最终呈现规则；[客户端结果参考](../../packages/mcp/mcp-client/README.zh.md#use-this-package) 维护 MCP 特有的投影细节。

-----

<a id="progressive-discovery-and-request-identity"></a>
## 渐进发现与请求身份

`discover_mcp_tools` 支持 `search`、`load` 与 `release`。搜索可按 `query`、`server` 或精确 `names` 过滤，并使用返回的 `nextOffset` 继续获取有界页面。加载完整公开工具名会同时激活其服务器，也可仅指定服务器来激活资源访问。加载与释放影响后续请求；它们不修改已启动请求中的定义。

原生请求和 PTC 声明共享持久选择。工具定义与所需的完整服务器指令作为一个整体准入，超出预算时保留先前有效选择，不截断 schema 或指令。预算衡量 MCP 自有贡献的 UTF-8 字节，不限制整个模型请求。[发现服务](../../packages/mcp/mcp-discovery/README.zh.md)维护配置与呈现细节。

选择器默认关闭。启用它需要显式的独立 provider、model、输入与输出预算、token 上限和超时；服务不会自动选择付费模型。直接用户文本中的 `mcp:<server>` 缩小选择范围，完整公开 `mcp__<server>__<tool>` 名称可请求精确加载。插件消息和工具内容不会作为直接标记输入。标记不授予权限，也不批量加载服务器工具；选择器失败仍保留手动发现入口。

`mcp/selection` 记录所选工具与服务器身份，`mcp/request-snapshot` 记录已启动请求接纳的定义与指令，选择器请求和结果也写入 Session。调用时比较当前内容与该请求的身份；变化的 schema 或指令在派发前触发过期定义错误。相同内容重连可复用选择。恢复与分支使用持久投影重建选择，再核对当前可见定义。

-----

<a id="resources-and-instructions"></a>
## 资源与指令

资源调用必须显式指定服务器名称，并从此前启动的主请求取得该服务器的激活与指令身份。目录统一由发现服务提供，包括只有资源的服务器。资源注册表在调用 Agent 作用域中解析名称，发现服务在网络派发前拒绝未激活或过期的服务器。没有 Agent 的直接程序化调用仅跳过模型激活检查。[资源包](../../packages/mcp/mcp-resources/README.zh.md)维护分页和内容渲染；schema 位于[工具目录](../tool-catalog.zh.md#deepseek-aidsh-mcp-resources)。

资源提供方仍由连接拥有。作用域释放时移除注册；MCP 客户端控制取消和恢复。规范结果为程序化调用方保留完整 JSON，文本投影则以描述替换二进制 blob。返回的文本进入普通工具历史；服务器连接本身不会触发内容读取。

客户端校验接收到的服务器指令大小，并保留完整、带服务器归属的字面文本。发现服务在选择该服务器时，按自己的准入预算将指令加入已记录的系统提示词。连接仅在发现成功后更新指令；空白指令不贡献文本。[系统提示词子系统](system-prompt.zh.md)维护装配与记录。

-----

<a id="discovery-types"></a>
## 发现类型

服务器提供方贡献连接状态与完整指令；搜索返回有界描述，加载返回完整选择或原子拒绝。以下声明由源码拥有。

```ts type-equiv
/** Live connection facts owned by the configured server plugin. */
interface ServerSource {
  /**
   * Read complete literal, attributed instructions from the last successful handshake.
   * @returns server prompt text.
   */
  instructions(): string
  /**
   * Report whether resource and tool requests currently have a live connection.
   * @returns connection readiness.
   */
  connected(): boolean
}
```

```ts type-equiv
/** Short discovery item; schemas remain deferred. */
interface DiscoveryItem { server: string; name?: string; description: string; connected: boolean }
```

```ts type-equiv
/** Caller filters; offset is an index in the current filtered catalog. */
interface SearchRequest { query?: string; server?: string; names?: readonly string[]; offset?: number }
```

```ts type-equiv
/** Bounded search page with a continuation offset when items remain. */
interface DiscoveryPage { items: DiscoveryItem[]; nextOffset: number | null; hint: string }
```

```ts type-equiv
/** Atomic admission outcome; a refused proposal retains the previous selection. */
type LoadResult = { ok: true; names: string[]; servers: string[] } | { ok: false; reason: string }
```

<a id="durable-selection-types"></a>
## 持久选择类型

所选内容身份、已启动请求与辅助选择记录通过 Session 投影恢复；历史请求保留其确切定义、SDK 与指令。

```ts type-equiv
/** Opaque identity of exact MCP definitions or server instructions. */
type McpDefinitionId = Branded<'McpDefinitionId'>
```

```ts type-equiv
/** Content identities retained for one selected capability. */
interface SelectedTool { name: string; server: string; identity: McpDefinitionId }
```

```ts type-equiv
/** Complete instructions identity for an activated server. */
interface SelectedServer { server: string; identity: McpDefinitionId }
```

```ts type-equiv
/** Whole loaded state after one committed operation. */
interface Selection { tools: SelectedTool[]; servers: SelectedServer[] }
```

```ts type-equiv
/** Exact MCP content belonging to one started main-model request. */
interface RequestSnapshot extends Selection {
  turn: number
  step: number
  schemas: ToolSchema[]
  sdk: string
  instructions: string
}
```

```ts type-equiv
/** Auxiliary routing and exact bounded text submitted to the selector. */
interface SelectorRequest { provider: string; model: string; maxTokens: number; system: string; input: string; phase: 'tools' | 'servers' }
```

```ts type-equiv
/** Selector outcome; failures never imply that MCP is unnecessary. */
interface SelectorResult { status: 'selected' | 'none' | 'uncertain' | 'failed'; names: string[]; servers: string[]; detail?: string }
```

```ts type-equiv
/** Host-only replay state. */
interface DiscoveryState { selection: Selection; request: RequestSnapshot | null }
```

-----

<a id="resource-provider-types"></a>
## 资源提供方类型

连接提供方接收一个操作与原始工具执行对象，其中包含调用方和取消信号。

```ts type-equiv
/** One supported resource operation, with server-owned cursors and URIs. */
type McpResourceRequest =
  | { method: 'resources/list' | 'resources/templates/list'; cursor?: string }
  | { method: 'resources/read'; uri: string }
```

```ts type-equiv
/** One configured server's resource access, owned by its MCP connection plugin. */
interface McpResourceProvider {
  /**
   * Run an operation against one live connection generation.
   * @param request - MCP resource method and parameters.
   * @param exec - caller identity and cancellation for this invocation.
   * @returns the protocol result as lossless JSON.
   */
  request(request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue>
}
```

-----

<a id="limits"></a>
## 限制

不支持 MCP 提示词模板、人工输入征询、基于任务的执行和资源订阅。资源工具需要调用方可见的已配置服务器；二进制资源保留为程序化数据，模型接收其文本描述。没有工具能力的服务器以空工具集连接。连接和发现超时遵循 SDK；客户端没有对应的独立设置。

-----

<a id="further-reading"></a>
## 延伸阅读

- [MCP 包组](../../packages/mcp/README.zh.md) — 包入口。
- [MCP 资源](../../packages/mcp/mcp-resources/README.zh.md) — 共享工具与资源提供方语义。
- [资源可见性决策](../../.agents/notes/implemented/feature/2026-09-13-mcp-resources-in-profiles.zh.md) — profile 统一挂载及由已配置服务器决定的可见性。
- [第三方记忆服务器](../user/guide/mcp-memory.zh.md) — 产品配置指南。
- [协议协商决策](../../.agents/notes/implemented/feature/2026-09-12-mcp-sdk-protocol-negotiation.zh.md) — SDK 职责与兼容性决策。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmcpdiscovery--mcpdiscovery"></a>

### `ctx.mcpDiscovery` — `McpDiscovery`

Deferred MCP definitions share permission filtering and execution with ordinary tools.

```ts cordis-catalog
/**
 * Register a configured server in the caller's scope.
 * @param server - namespace.
 * @param source - connection facts.
 * @returns effect disposer.
 */
registerServer(server: string, source: ServerSource): () => void

/**
 * Register one deferred MCP definition without changing authorization.
 * @param server - owning namespace.
 * @param definition - original tool.
 * @returns effect disposer.
 */
registerTool(server: string, definition: ToolDefinition): () => void

/**
 * Search the permission-filtered catalog without loading schemas.
 * @param scope - caller identity.
 * @param request - bounded filters and pagination.
 * @returns complete byte-limited page.
 */
search(scope?: ScopeKey, request: SearchRequest = {}): DiscoveryPage

/**
 * Atomically add tool definitions and complete server instructions.
 * @param agent - durable owner.
 * @param names - exact public tool names.
 * @param servers - resource-only activation targets.
 * @param signal - cancellation before commit.
 * @returns admission or refusal.
 */
load(agent: Agent, names: readonly string[], servers: readonly string[] = [], signal?: AbortSignal): LoadResult

/**
 * Release selections for future requests; started snapshots stay fixed.
 * @param agent - owner.
 * @param names - names, or omission to release all.
 * @param servers - activated server names to release.
 * @returns remaining selection.
 */
release(agent: Agent, names?: readonly string[], servers: readonly string[] = []): LoadResult

/**
 * Guard model resource calls before network access. Programmatic calls without an Agent bypass activation only.
 * @param server - resource namespace.
 * @param exec - execution owner.
 */
assertServer(server: string, exec: ToolExecution): void
```

Types: [Agent](core.zh.md) · [ScopeKey](scope.zh.md) · [ToolDefinition](tools.zh.md) · [ToolExecution](tools.zh.md)

Source: [`packages/mcp/mcp-discovery/src/index.ts`](../../packages/mcp/mcp-discovery/src/index.ts)

<a id="ctxmcpresources--mcpresourceruntime"></a>

### `ctx.mcpResources` — `McpResourceRuntime`

Scoped resource access plus three tools shared by configured MCP servers.

```ts cordis-catalog
/**
 * Register one server and expose resource tools while that scope has providers.
 * @param server - configured server name, unique in this scope.
 * @param provider - connection-owned resource operations.
 * @returns the effect disposer for this exact registration.
 */
register(server: string, provider: McpResourceProvider): () => void
```

Source: [`packages/mcp/mcp-resources/src/index.ts`](../../packages/mcp/mcp-resources/src/index.ts)
<!-- END GENERATED cordis-surface -->
