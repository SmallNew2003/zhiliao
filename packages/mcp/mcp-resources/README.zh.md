---
description: "通过共享工具、显式服务器选择和 agent 作用域访问，按需发现与读取 MCP 资源。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-resources

[English](README.md) | 中文

## 概述

`dsh-mcp-resources` 让模型按需发现和读取已配置 MCP 服务器提供的文档。随附 profile 在调用方作用域中配置了服务器时，自动提供三个共享工具。模型必须先通过[发现服务](../mcp-discovery/README.zh.md)激活服务器，待指令进入后续请求后再调用资源工具。每次调用都要求显式服务器名称。资源文本进入历史；二进制载荷保留给程序化调用方，并以说明文字呈现给模型。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

随附 profile 已经统一挂载本包一次。你只需为所需服务器配置 [MCP 客户端](../mcp-client/README.zh.md)条目。

### 服务器配置

通过[客户端配置](../mcp-client/README.zh.md#use-this-package)在目标作用域中添加服务器。本包没有配置字段。

调用方没有可见的已配置 MCP 服务器时，在 native 或 PTC 模式下都看不到 MCP 提示词文本或资源工具。配置服务器后启用三个共享资源工具，也支持没有工具或指令的服务器。只要客户端条目保持激活，连接失败就不会移除共享工具；调用仍须通过激活检查，并可能报告连接错误。

### 发现与读取

通过 `discover_mcp_tools` 搜索有界目录，再以 `action: load` 和 `server` 激活所需服务器。等待下一次模型请求接纳其完整指令，再以相同 `server` 调用 `list_mcp_resources` 或 `list_mcp_resource_templates`。未提供游标时，MCP SDK 收集服务器分页；显式 `cursor` 请求该页，并将返回的 `nextCursor` 原样传入。使用相同服务器和显式 `uri`，通过 `read_mcp_resource` 读取列出的 URI 或展开后的模板。

每个操作先在调用 Agent 的作用域中解析服务器，再检查该服务器是否已进入此前启动的主请求。缺少参数、不可用服务器、未激活或指令过期都会在网络派发前失败；重新加载后从下一次请求重试。没有 Agent 的直接程序化调用仅跳过模型激活检查。连接所有者负责取消、超时与恢复；失败仍表现为失败调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[base](../../bundle/base/README.zh.md) 与独立的 [sdk-minimal](../../bundle/sdk-minimal/README.zh.md) bundle 分别拥有以下配置行：

```yaml
- id: mcp-resources
  name: '@deepseek-ai/dsh-mcp-resources'
```

作用域中的首个提供方注册共享工具，最后一个移除时注销本地工具，继承的提供方与工具仍可见。资源服务独立于单一提供方拥有工具 effect，并依赖 `tools` 与 `mcpDiscovery`。资源注册表解析服务器，发现服务检查已记录的请求激活；服务器名称与指令由发现目录统一呈现。

规范结果为程序化调用方保留完整 JSON。纯文本渲染器添加服务器归属，并将字符串 `blob` 字段替换为 base64 长度说明；URI、MIME 类型与文本字段仍保留在渲染后的 JSON 中。工具流水线负责记录结果。[发现服务](../mcp-discovery/README.zh.md)负责服务器指令的准入与请求身份。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 作用域提供方选择与请求激活检查 |
| [`src/tools.ts`](src/tools.ts) | 共享资源操作与参数 schema |
| [`src/render.ts`](src/render.ts) | 带归属信息且不内联二进制载荷的文本投影 |

不发布运行时不变式伴生入口：资源工具注册与派发使用同一组由 effect 拥有的提供方。请求激活由发现服务在调用时检查；注册表 effect 检查不属于运行时不变式。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面介绍服务器配置、执行机制与资源访问决策。

- [MCP 客户端](../mcp-client/README.zh.md)——服务器传输、指令与连接生命周期。
- [工具子系统](../../../docs/subsystems/tools.zh.md)——规范值与模型可见结果。
- [资源可见性决策](../../../.agents/notes/implemented/feature/2026-09-13-mcp-resources-in-profiles.zh.md)——profile 统一挂载及由已配置服务器决定的可见性。
- [资源与指令决策](../../../.agents/notes/implemented/feature/2026-09-12-mcp-resources-and-instructions.zh.md)——作用域、按需访问及未纳入的机制。

-----

<a id="model-experience"></a>
## 模型体验

### 共享资源工具

#### 模型看到什么

[生成的工具 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-mcp-resources)定义了所有调用方可见服务器共享的三个工具。没有可见服务器时，native schema 与 PTC 声明均不存在。激活客户端的连接、断开或重试不会改变这些共享定义。[发现服务](../mcp-discovery/README.zh.md#model-experience)提供有界服务器目录，并在激活后准入完整指令；本包不添加服务器名称提示词。

#### Token 影响

没有调用方可见的已配置服务器时，本包不增加工具或提示词 token。否则，三个共享定义贡献固定的 schema 开销；目录与指令开销归发现服务所有。资源列表和文档仅在操作返回后增加内容。

#### KV Cache 影响

添加首个调用方可见服务器或移除最后一个时，改变后续工具 schema 或 PTC 声明前缀。中间服务器变动与连接失败不改变这三个共享定义；发现服务决定目录与指令文本的变化。

### 资源结果

#### 模型看到什么

成功结果以 `MCP server: <server>` 开头，随后是换行和返回的 JSON。每个字符串值的 `blob` 都变为 `[binary resource: <length> base64 characters; available to programmatic callers]`。服务器提供的文本、元数据与续传游标仍然可见。

#### Token 影响

渲染后的结果向工具历史添加文本。二进制说明文字替代载荷的 base64 token 开销；本包不设置额外的文本大小限制。

#### KV Cache 影响

每个结果追加到历史中，不改写此前的结果。后续读取可以返回已变化的服务器内容并追加不同结果；本包不会刷新此前已记录的内容。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

资源访问由显式调用按需发起。

- 不具备 MCP `resources` 能力的已配置服务器仍出现在发现目录中，并保持共享工具可用。激活后，SDK 返回空资源与模板列表；不受支持的读取失败。
- `tools.restrict()` 在注册过滤条件时检查全局或祖先作用域提供的名称。引用这些作用域中不存在的资源工具名称会报未知工具错误。注册在调用方自身作用域中的资源工具不受 allow/deny 掩码过滤。
- 不支持资源订阅与更新通知；再次调用列表或读取工具以获取当前内容。
- 二进制资源不会投影为原生图片或音频。程序化调用方保留其规范 base64 值。
- 调用方必须提供服务器名称。共享工具不会聚合不同服务器；分页遵循 MCP SDK。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
