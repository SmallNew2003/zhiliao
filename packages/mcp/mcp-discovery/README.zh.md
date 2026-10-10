---
description: "面向部署者和插件维护者的渐进式 MCP 发现、加载限制与辅助模型预选。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-discovery

[English](README.md) | 中文

## 概述

模型可发现已配置的 MCP 能力，只加载所需定义。`ctx.mcpDiscovery` 拥有作用域目录和每个 Agent 的选择。Native 请求和 PTC SDK 提示只包含选中的工具；调用者仍可发现其他可见能力。完整服务器说明与工具或资源激活进行原子加载。原有工具权限、审批、取消和连接执行仍然生效。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

随附的 base 和最小 SDK 组合提供此服务。它要求 `tools`、`systemPrompt` 和 `sessionProjections`。通过已配置服务器插件的上下文，先注册服务器来源，再注册工具。销毁该上下文会移除其目录条目和注册。没有可见服务器时，不贡献发现工具、提示或请求快照事件。

`discover_mcp_tools` 接受 `action: search | load | release`，以及可选的 `query`、`server`、公共 `names` 和 `offset`。搜索返回有限描述及 `nextOffset`。加载确切名称会为下一次请求原子接纳完整定义和服务器说明。仅加载服务器会激活资源访问，不读取任何资源。释放只影响后续请求。较早请求产生的调用仍使用其记录版本；当前定义或说明不同时返回 `MCP_STALE_DEFINITION`。

直接人类输入可以指定 `mcp__<server>__<tool>` 或 `mcp:<server>`。确切公共名称会在该输入的首次请求前加载，即使辅助预选被禁用或不可用。服务器标记限定自动候选并标识主模型的发现目标，不会选中服务器的全部工具。工具输出或插件上下文中的名称不会触发直接加载。

所有限制都是正整数。UTF-8 字节限制衡量包含发现包装的完整贡献内容：`catalogBytes` 默认 8192；`nativeBytes` 和 `sdkBytes` 默认 32768；`instructionBytes` 默认 16384；`resultBytes` 默认 8192。`resultLimit` 默认 20 项。字节上限不超过 16777216，`resultLimit` 不超过 1000。过大的定义、累计提案或完整说明会拒绝整个加载，并保留上一有效选择。可提高所指限制、释放旧选择或减少工具数。Schema 和说明不会被截断。连接握手的说明限制仍由 [mcp-client](../mcp-client/README.zh.md) 独立拥有。

省略 `selector` 时禁用自动预选。启用须明确提供 `provider`、`model`、`inputBytes`、`outputBytes`、`maxTokens` 和 `timeoutMs`；任何字段都不继承会话路由。缺少 LLM 服务会在加载时失败；明确的 provider/model 在适配器初始化后的首次预选请求中解析。预选字节限制具有相同最大值，`maxTokens` 允许 1–1000000，`timeoutMs` 允许 1–2147483647。辅助输入包含当前需求、有效选择、近期真实人类/助手文字和不含参数 Schema 的短描述。必要时确定性移除较早记录并记录省略数量。大目录先根据去重后的可见工具描述筛选服务器；预览摘要在输入预算内确定性缩短，优先保留近期任务上下文。加载前根据当前权限校验选中名称。`none`、`uncertain` 和 `failed` 是不同的记录结果，都不启用全量加载。成功预选会原子替换先前自动选择；同次输入的直接名称优先。失败保留上一有效选择和发现路径。

<a id="understand-the-implementation"></a>

## 理解实现

<details>
<summary>展开实现细节</summary>

作用域目录由服务器注册拥有。加载状态通过宿主侧 `mcpDiscovery` 会话投影从完整的 `mcp/selection` 事件派生。恢复和 fork 只复用各自保留的事件；定义、说明或权限变化使相应选择失效。每次组装都会根据当前限制和 SDK 渲染重新检查保留选择；超预算的集合会为后续请求原子清空，已开始请求的快照保持不变。暂时断线保留元数据，执行返回 `MCP_DISCONNECTED`；相同内容的重连可以复用有效选择。

提示组装在下游组装监听器之前刷新 MCP 贡献，保留监听器的返回结果，并暂存最终定义和 SDK 文字。`agent/assistant-stream` 的 start 将不可变暂存内容绑定到 turn/step 坐标一致的尝试，记录 `mcp/request-snapshot`。绑定根据已提交系统历史校验捕获的说明与完整 PTC SDK。SDK 或说明变化会启动新请求序列并合并旧提示；卸载最后一个服务器会记录一次清空快照。工具和资源守卫比较产生调用的请求标识与当前注册内容，因此改变或释放最新选择不会替换已经开始请求的定义。未激活资源调用在网络访问前失败；不带 Agent 的直接程序化资源调用只跳过模型说明激活要求。

辅助请求和结果记录为 `mcp/selector-request` 与 `mcp/selector-result`；直接指定和接纳诊断使用 `mcp/diagnostic`，不暗示辅助调用。作用域或服务销毁会取消其拥有的辅助工作并等待其结束；被取消或移除的注册不能发布迟到选择。本包不发布 invariant 伴随模块：展示选择直接从持久投影和当前作用域注册计算，执行在分派时校验历史请求标识；不存在独立可变的加载投影。

</details>

<a id="further-exploration"></a>

## 进一步探索

参见 [MCP 子系统](../../../docs/subsystems/mcp.zh.md)、[工具执行](../../core/tools/README.zh.md) 与 [系统提示组装](../../core/system-prompt/README.zh.md)。

<a id="model-experience"></a>

## 模型体验

### 发现与已选定义

#### 模型看到的内容

存在可见 MCP 服务器时，模型获得有限能力目录和 `discover_mcp_tools`，以及完整已加载 Native 定义或 PTC 接口和激活后的 literal 服务器说明。资源正文仅通过显式读取进入历史。未知目标、断线、预算拒绝和过期定义提供诊断及发现或释放路径。

#### Token 影响

未使用的 MCP Schema 和完整说明不贡献请求成本。已加载定义和完整说明按选择重复出现；辅助预选仅在新直接人类输入时添加独立受限请求。UTF-8 限制约束本包的贡献，不约束总会话 tokens 或普通工具。

#### KV Cache 影响

稳定目录和选择保留相同贡献文字。加载、释放、失效或说明变化会改变 Schema 或提示文字，可能从变化位置影响缓存复用。供应商缓存行为和节省量需要实际测量。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **预选准确率：** 质量取决于配置的辅助模型；本包不承诺通用成本或召回率。
- **输入预算：** 放不下目录或最新需求时，记录失败并保留主模型发现。
- **目录分页：** 偏移指向当前目录，刷新可能改变分页成员。
- **提示覆盖：** 自定义 SDK 改写须保留完整生成节，否则 PTC MCP 绑定保持未激活；完整提示覆盖须包含所需 literal 服务器说明，才能激活相应请求。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作上下文</summary>

确定性包测试覆盖 Native/PTC 展示、多字节原子限制、资源、过期请求版本、fork 恢复、权限、重连、预选结果与取消。随附 profile 的 Loader 场景和录制会话快照由集成变更拥有。

</details>
