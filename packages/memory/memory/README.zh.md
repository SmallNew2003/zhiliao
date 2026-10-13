---
description: "长期记忆服务（ctx.memory）：插件与工具作者如何按 workspace 通过可互换的提供方召回、搜索与保留持久记忆，以及统一的选择策略与错误词汇。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

[English](README.md) | 中文

## 概述

使用 `dsh-memory` 为组合增加长期记忆，而无需让调用方依赖特定后端。它拥有提供方注册表、按 workspace 解析记忆库，并在统一的选择策略与统一的错误词汇下暴露召回、搜索与保留三项能力。当插件必须跨会话读写持久记忆时选择它。必须挂载一个后端，因为该 seam 自身不发起网络访问；已交付的 `dsh-memory-hindsight-http` 提供方会为你注册一个。位于 agent 热路径的调用方应当捕获 `MemoryError` 并继续，因为记忆绝不能阻塞一个回合。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

需要长期记忆的组合会加载 `dsh-memory` 服务并挂载至少一个提供方——插件与工具作者随后直接调用 `ctx.memory.resolveBank()`、`ctx.memory.recall()`、`ctx.memory.search()` 与 `ctx.memory.retain()`。服务会为每次调用解析提供方，因此除非调用方配置了提供方 id，否则它们看不到提供方 id。

### 何时选择

当插件必须跨会话记住某些内容、又不希望硬编码存储时选择本服务；只需要 hindsight 支撑的记忆的部署挂载已交付的 `dsh-memory-hindsight-http` 提供方即可。当组合不保留超出当前会话的状态时，你不需要它。服务本身不增加任何网络访问能力：没有至少一个可用提供方时，每次调用都会以结构化 `MemoryError` 失败。

### 最小配置

加载服务并让唯一挂载的提供方自动选择，或用 `provider` 固定提供方 id。环境变量 `$DSH_MEMORY_PROVIDER` 提供相同字段，不是另一条优先级链。

```yaml
- name: '@deepseek-ai/dsh-memory'
- name: '@deepseek-ai/dsh-memory-hindsight-http'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | （未设置） | 固定的提供方 id；未设置时仅在恰好一个可用时自动选择 |

### 召回、搜索与保留

`resolveBank()` 把一个 workspace 目录映射到拥有它的记忆库，在缺失时创建该库。`recall()` 接收会话的开场提示并返回值得注入的记忆单元；`search()` 针对一个记忆库接收一段自由文本查询。两者都把结果限制在 `request.limit` 以内：服务截断 `units[]` 并设置 `truncated`，因此超量返回的提供方不可能泄漏超出调用方要求的数量。`retain()` 把完成的 transcript 交给后端，并报告它接受了什么。

```text
// Resolve the bank that owns this workspace, creating it when absent:
const bankId = await ctx.memory.resolveBank(workspaceRoot)

// Session opening: recall what matters, bounded by limit:
const recalled = await ctx.memory.recall({ prompt, limit: 6 }, bankId)

// Mid-task lookup against the same bank:
const found = await ctx.memory.search({ query: 'why is the retry cap 3?', limit: 8 }, bankId)

// End of session: keep the transcript.
const outcome = await ctx.memory.retain({ turns }, bankId)
```

每次调用都接受可选的 `AbortSignal`，用于把取消转发给提供方。拥有回合并算预算的调用方应当传入它，并且仍然捕获失败：缓慢、不可达或配置有误的记忆后端应当只造成一个降级的回合，而不是一个失败的回合。

### 提供方选择

每次调用都在执行时解析提供方，注册或加载顺序从不影响结果。已配置的提供方 id 在已注册且可用时优先；没有配置 id 时，服务运行唯一可用的提供方，或在情况不明时明确失败：

| 情况 | 结果 |
|---|---|
| 已配置 id 已注册且可用 | 运行该提供方 |
| 已配置 id 未注册 | `MEMORY_PROVIDER_CONFIGURED_MISSING` |
| 已配置 id 已注册但不可用 | `MEMORY_PROVIDER_UNAVAILABLE` |
| 无 id，恰好一个已注册的可用提供方 | 运行它 |
| 无 id，没有可用提供方 | `MEMORY_PROVIDER_UNAVAILABLE` |
| 无 id，多个可用提供方 | `MEMORY_PROVIDER_UNAVAILABLE`，消息列出每个候选 |

注册基于 effect：提供方随调用 fiber 注册，fiber 释放时注销；重复的 id 会在注册时被拒绝，抛出 `MEMORY_DUPLICATE_PROVIDER`。`isAvailable()` 回答当前是否已注册了可用提供方，因此热路径调用方可以先检查一次，而不是为一次失败调用付出代价。

### 失败与恢复

失败抛出 `MemoryError`，携带稳定、可按机器路由的 code；消息补充细节，例如缺失的提供方 id 或歧义候选集合。`MEMORY_PROVIDER_UNAVAILABLE`、`MEMORY_PROVIDER_CONFIGURED_MISSING` 与 `MEMORY_DUPLICATE_PROVIDER` 由本服务抛出；`MEMORY_BACKEND_ERROR`、`MEMORY_BACKEND_TIMEOUT` 与 `MEMORY_BANK_NOT_FOUND` 来自提供方。要改变一次调用使用的后端，请重新配置固定的 id、挂载或卸载提供方，或修正提供方配置使其可用性检查通过。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包建立在一个刻意的分离之上：

- **约定本身就是产品。** 提供方实现 `MemoryProvider`；调用方可以依赖的一切——库身份、结果上限、选择、错误分类体系——都归 seam 所有，因此替换后端不会改变可观察行为。
- **选择绝不依赖顺序。** 服务要么固定提供方 id，要么在恰好注册一个可用提供方时自动选择，并且它在执行时而非注册时解析。
- **seam 拥有结果上限。** `limit` 由 seam 在提供方返回后强制执行，因此超量返回的后端会被纠正，而不是被信任。
- **失败是显式的，降级由调用方决定。** 服务绝不吞掉错误；位于 agent 热路径的调用方决定缺失的记忆是一条警告还是一次失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`MemoryRuntime` 服务、提供方注册表、执行时选择与 `capUnits` |
| [`src/types.ts`](src/types.ts) | 词汇：`MemoryProvider` 约定、请求／结果形状、 branded 标识符与 `MemoryError` 分类体系 |
| — | 不发布运行时不变式配套项；提供方映射是私有数据，服务会在每次调用时执行提供方选择并强制执行结果上限；该 seam 不发布独立注册表，也不发布召回／结果观测流。 |

### 数据模型

提供方约定与请求／结果类型定义了调用方赖以构建的规范化词汇，穷尽式字段与 JSDoc 见 [`src/types.ts`](src/types.ts)。三个刻意的选择塑造了它们。`MemoryBankId`、`MemoryId` 与 `KnowledgePageId` 都是 branded 字符串，因此库 id 绝不会被当作记忆 id 传入；强制转换辅助函数的存在，是因为表示方式归提供方而非调用方所有。`MemoryUnit.text` 被定义为已经为模型消费格式化好的，从而把渲染策略挡在 seam 的消费方之外。`MemoryError` 继承 `Error` 并携带封闭的 `code` 联合，因此调用方可以按一个小的稳定集合路由，而不必解析消息。

### 选择流程

执行时，服务先按配置 id、再按唯一可用提供方解析提供方，没有明确赢家时抛出对应的 `MemoryError`。召回与搜索结果随后经过 `capUnits`：把 `units[]` 截断到 `request.limit` 并标记 `truncated`。`resolveBank()` 是异步的，因为解析一个库可能需要后端列出或创建它；其余方法都把请求原样转发给选中的提供方。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从已交付后端进入共享的 seam 词汇与本包遵循的设计规则。

- [dsh-memory-hindsight-http](../hindsight-http/README.zh.md)——已交付的 hindsight 提供方，包括它的召回超时为何是两分钟。
- [dsh-web](../../web/web/README.zh.md)——同构的搜索／抓取 seam，可作为提供方选择与结果上限模式的参考。
- [能力 seam](../../../docs/capability-seams.zh.md)——可替换的能力 seam 相对核心服务与 bundle 的定位。
- [防御式模式](../../../docs/defensive-patterns.zh.md)——让生命周期监听器降级而不是让一个回合失败的规则。
- [生成配置目录](../../../docs/config-catalog.zh.md)——整个 Harness 的每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 召回的记忆单元与记忆结果

#### What the model sees

本包自身不直接贡献任何内容：该 seam 不注册工具、不注册提示词段落，也不注册结果渲染器。模型看到的内容由消费本 seam 的 `dsh-tool-memory` 产出——一次以带来源归属的用户消息注入的开场召回，加上 `hindsight_search` 与 `hindsight_remember` 的结果。本包仍然决定了模型会读到内容的一部分，因为 `MemoryUnit.text` 被定义为已经为模型消费格式化好，因此提供方在任何消费方渲染之前就选定了措辞。

#### Token effect

召回的记忆单元依赖数据，并会在压缩之前反复重发。`capUnits` 按 `request.limit` 约束单元数量，这是本包施加的唯一尺寸控制；`MemoryUnit.bankId` 仅出现在跨库的结果中。

#### KV Cache effect

没有直接影响：本包不贡献提示词段落，也不贡献 schema。注入持久消息的消费方会改变请求前缀，因此召回注入会从第一个被注入的 token 起使复用失效；而工具结果追加在可复用前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本服务单独使用时在哪些方面不完整。它们是当前包约束。

- **多种选择失败共用一个 code**：已配置但不可用的提供方、没有可用提供方，以及多个可用提供方，都抛出 `MEMORY_PROVIDER_UNAVAILABLE`；只有消息能把它们区分开，因此必须区别处理的调用方只能读取文本。不存在独立的歧义 code。
- **没有观测接口**：没有提供方变更事件或能力状态查询；可用性只能通过 `isAvailable()`，或执行一次调用并按抛出的 code 路由来观测。
- **`MEMORY_BANK_NOT_FOUND` 已声明但从不由此抛出**：该 code 存在于分类体系中供提供方使用，已交付的 hindsight 提供方在 daemon 返回 404 时会抛出它，但本服务从不产生它。
- **`MemoryRetainRequest.bankId` 在这条路径上是惰性的**：`retain()` 把记忆库作为自己的参数接收并原样转发请求，因此请求形状中的这个可选字段从未被读取。
- **`KnowledgePageId` 在此没有消费方**：该 branded 类型与 `knowledgePageId()` 是导出的词汇，为本包并未实现的精选知识页界面预留。
- **请求只携带查询与上限**：新近程度窗口、记忆类型过滤与跨库查询暂缓至有后端能诚实支持为止。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文为准。

#### 未来：把歧义与缺失区分开

当前三种不同的运维错误——固定的 id 已宕机、没有挂载任何东西、挂载了太多东西——都折叠成 `MEMORY_PROVIDER_UNAVAILABLE`。一个独立的歧义 code 能让组合在启动时以精确消息失败，而不是在首次调用时失败。封闭的 `MemoryErrorCode` 联合使这成为一次增量的、由编译强制执行的变更。

#### 未来：更丰富的请求词汇

`MemorySearchRequest` 与 `MemoryRecallRequest` 只携带查询与上限。真实后端能诚实支持的过滤项——新近程度、记忆类型、按库限定范围——要等到有提供方能真正满足它们，而不是被接受后忽略。

</details>
