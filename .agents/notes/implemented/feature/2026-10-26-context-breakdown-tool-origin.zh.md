# Agent Note: 上下文构成按来源拆分工具数字

Status: implemented

[English](2026-10-26-context-breakdown-tool-origin.md) | 中文

## Problem

composer 的上下文占用面板此前把所有工具 schema 计价进同一行。MCP 服务器常常贡献会话中最大的一块工具定义——一个浏览器或工单服务器的 schema 可能比所有 harness 工具加起来还贵——于是「谁在吃上下文」这个问题无法回答。拆行需要每个工具的来源，而发给模型的请求信封里没有这个字段。

## Decision

`contextBreakdown` 在原有 `systemTokens`、`messageTokens` 之外多出两个工具数字 `systemToolsTokens` 与 `externalToolsTokens`；`toolsTokens` 仍是对外提供的总数，且等于两者之和。ContextMeter 面板渲染四行——系统提示词、内置工具、MCP 工具、对话消息——其中 MCP 行只在其数字为正时出现。

分类依据公开名称前缀。`ToolSchema` 只带 `name`、`description`、`parameters`，因为 `ToolRuntime.schemas()` 恰好把这三个字段投影到线上并丢弃其余字段，注册元数据无法进入请求信封；`publicToolName` 构造出的 `mcp__<server>__` 命名空间是唯一残留的来源标记。该前缀常量与 `ToolSchema` 同放在 `dsh-llm` 中，而 `mcp-client` 与 `token-meter` 本就依赖它，因此构造方与分类方共用同一处定义，不新增依赖边。

每个 schema 单独计价，而不是把整个信封一次计价。整信封价格只计一次块开销加数组框架，差额必须摊给某一侧，于是工具全部来自 MCP 的会话也会报告若干并不存在的 harness 侧 token。逐 schema 计价能精确划分总数；`measure()` 仍保持整信封价格，因此单工具信封在构成里比在测量锚点里低 1 个 token。

拆分放在投影里，而不是客户端。浏览器只读投影与会话事件，两者都不带工具清单，客户端无从分类。状态字段变了，因此 `stateVersion` 从 5 升到 6；投影缓存丢弃版本不匹配的行并按日志重新折叠，会话事件与线上格式代号均不变。

## Alternatives considered

- **在 `request/header` 信封里持久化 `ToolDefinition` 的来源字段。** 对第三方插件是精确答案——它们用任意名称注册工具，只能计为 harness 自有。本轮不做：`request/header` 是持久化会话事件，该字段需要持久化类型确认、两套 SDK 投影和迁移方案，为一个展示细化付出过大代价。行标签因此写「MCP 工具」而非「第三方工具」，把这个界限写明。
- **在客户端从回放的 request-header 事件拆分。** Web 客户端折叠的正是主机折叠的同一份日志。否决：Chat 快照构建器不保留 request-header 状态，为四行面板新增一份状态只会重复投影的职责。
- **整信封计价后从一侧扣除。** 数组框架与块开销全部压给一侧，工具全部来自 MCP 的会话因此报告非零的 harness 侧数字。否决：它会凭空造出一个幽灵值。
- **把 `estimateToolsTokens` 本身改成逐 schema 计价。** 本可让构成与测量锚点完全一致。否决：`measure()` 喂给压缩决策与请求预算，所有被钉住的测量值都会位移；改为只让构成独自吸收这 1 token 的差异。

## Consequences

- 只要接了 MCP 服务器，面板就能回答「这是谁的 schema」；没接时则不出现 MCP 行。
- 第三方插件在无命名空间情况下注册的工具仍计为 harness 自有；两份 README 都写明了这一点，而不是暗示拆分覆盖了所有外部工具。
- 构成的工具数字可能与测量锚点相差一个数组框架——单工具信封为 1 token——两份 README 都记录了原因。
- `contextBreakdown` stateVersion 6 会丢弃旧构建写下的缓存检查点；每个会话首次冷读时重新折叠。
