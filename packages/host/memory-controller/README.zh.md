---
description: "只读 Remote 投影部署保留的长期记忆：bank 列表、每个 bank 的统计、知识页树、知识库搜索与页面正文，供浏览器记忆面板使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-memory-controller

[English](README.md) | 中文

## 摘要

客户端在 `memoryController` 命名空间上调用五个方法，展示部署的长期记忆里有什么：`list` 给出记忆库及其事实数与最后写入时间，`stats` 给出单个库的节点、链接、文档总数以及事实类型与链接类型分布，`pages` 给出某个库的知识页，`search` 检索知识索引，`page` 给出单个页面的正文。每个方法都返回结构化状态而不是抛异常，因此浏览器能说明**具体**命中了哪种情况——记忆未启用、部署配置有误、daemon 不可达、请求失败——而不是只显示一个笼统的传输错误。该接口只读：不能写入、编辑或删除记忆。

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

把本包与[记忆能力 seam](../../memory/memory/README.zh.md)及一个 provider 一起装配，然后从客户端调用 `memoryController` 命名空间。Remote 是唯一入口：该服务仅存在于 Remote，刻意不声明同进程的 Cordis `Context` 合并。它的服务键是 `memoryController`，与 seam 自身的 `memory` 键不同，因此装配本包绝不会遮蔽它所读取的能力。

### 读取记忆库

`memoryController/list` 返回 daemon 持有的每个库：其 provider 自有的 id、已发布的显示名、事实数，以及后端上报时的最后写入时间。该 id 含有 `::`，因为 hindsight 以 `<前缀>::<项目>` 作为库键；客户端据此拼接后续 URL 时必须做百分号编码。后端未给出 id 的行会被跳过，而不是列出一个打不开的库。

### 读取单个库的统计

`memoryController/stats` 接受一个库 id，返回该库的总计——节点、链接、文档——以及按事实类型统计的节点数、按链接类型统计的链接数（两者都按数量降序排列，因此顺序不依赖后端的序列化顺序），还有待处理与失败的操作计数。缺失或非数值的字段读作 `0` 而不是让整个调用失败：页面上有部分计数比没有页面更有用。这是客户端渲染为该库构成情况的区块，而不是健康结论——待处理与失败的操作是后端上报的，不是本包评判的。

### 浏览与搜索知识页

`memoryController/pages` 把某个库的知识页作为一个扁平的深度优先列表返回：每页的 id、名称、生成它所用的提示词、最后刷新时间，以及后端是否标记它已过期。没有 id 的树节点被跳过，但**它的子树被保留**——子节点按各自的 id 寻址，因此丢掉父节点不会丢失任何可达页面。

`memoryController/search` 检索的是**知识索引**，而不是 seam 的 `search`。这个区别是关键：seam 的搜索由 daemon 运行推理作答，耗时一分钟以上，浏览器面板无法等待，因此本控制器改为查询整理好的知识页，并连同后端自己的匹配总数一起返回命中。没有 id 或没有摘要的命中会被丢弃，因为既打不开也引用不了的命中不算命中。调用方传入的 limit 被夹到 `[1, 100]`，默认 20，因此客户端不能让 daemon 返回整个库。

`memoryController/page` 接受库 id 与页面 id，返回该页的名称与 Markdown 正文。后端没有正文的页面返回为「可用但不带页面」的应答，而不是失败：请求成功了，只是没有内容可展示。

### 不可用是应答，不是异常

每个方法都返回 `available: false` 并带上 `reason` 与 `detail`，而不是 reject。这一点很重要：被拒绝的 Remote 调用到达浏览器时只是一个不透明的传输失败，无法说明发生了哪种后端情况，而*这个构建里没有记忆*与*daemon 挂了*需要用户做出不同的反应。四种原因是：

| 原因 | 含义 |
|---|---|
| `unavailable` | 没有可用的 provider 已注册，即该部署未启用记忆。不会打开任何连接。 |
| `misconfigured` | Host 固定了一个未注册的 provider id，或有多个可用 provider 竞争而未固定。两者都通过配置一个 provider id 解决。 |
| `unreachable` | daemon 在配置的时间预算内没有应答。 |
| `failed` | daemon 返回了错误、返回了非 JSON 内容、没有该库，或传输失败。 |

`detail` 承载 Host 或 provider 自己的原话，用于原因本身不足以解释的情况。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

`memory` seam 负责 agent 热路径上的召回、搜索与保留，并且刻意不投影 bank、统计或知识页，因为热路径上没有任何东西需要它们。本控制器为人类补上这个浏览面，因此它直接读取 daemon 的 REST 端点，而不是拓宽 seam——一个长出纯展示投影的 seam 会把 UI 词汇压到 agent 的关键依赖上。

每个请求之前都通过 `ctx.memory.isAvailable()` 读取可用性，因为那是廉价的同步答案：未启用记忆的部署不消耗任何连接。`isAvailable()` 从不抛异常，因此配置错误的 provider id 在这里只是「不可用」，而不是需要分类的第二个失败；`misconfigured` 只有在 provider 自身的请求路径抛出时才可达。

### 端点映射

| 方法 | daemon 端点 |
|---|---|
| `list` | `GET /v1/default/banks` |
| `stats` | `GET /v1/default/banks/{bank}/stats` |
| `pages` | `GET /v1/default/banks/{bank}/knowledge-base/tree` |
| `search` | `GET /v1/default/banks/{bank}/knowledge-base/search?q=&limit=` |
| `page` | `GET /v1/default/banks/{bank}/knowledge-base/pages/{page}` |

每个路径段都做百分号编码，因为库 id 含 `::`，页面 id 可能含任意字符。这里任何方法都刻意不调用 `memories/recall`：它在服务端运行推理，一分钟以上才返回，对交互式页面不可用。

### 传输

每个请求都是在 `AbortSignal.timeout` 下的有界 `GET`。超时、不可达的连接、`404`、非 2xx 状态与非 JSON 正文，都在请求边界变成带分类的 `MemoryError`，再由 `answer()` 投影为线上原因。读取同时容忍裸数组与 `{ 字段: [...] }` 信封，因此后端即使去掉信封也仍能应答。

### 配置

`baseUrl`（默认 `http://127.0.0.1:9077`）与 `timeoutMs`（默认 `10000`）就是全部配置面。默认预算取 provider 的**廉价元数据**预算，而不是它的推理预算，因为这里用到的每个端点都是元数据读取。`baseUrl` 末尾的斜杠会被去掉，因此 `http://host:9077/` 与 `http://host:9077` 行为一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `MemoryController`：`memoryController` Remote 服务、daemon 传输与 seam 分类投影 |
| [`src/types.ts`](src/types.ts) | 公开载荷类型：`MemoryBankSummary`、`MemoryBankStats`、`MemoryKnowledgePage`、`MemoryKnowledgeHit`、`MemoryAnswer` |
| — | 不发布运行时不变式伴生检查；每个应答都直接由 daemon 响应投影而来。 |

Typert 生成 `./typert` 与 `./remote` 暴露的 Host 与 Client Remote 产物。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当浏览契约不够用时读这些：被投影的能力、它背后的 daemon，以及渲染它的界面。

- [记忆能力 seam](../../memory/memory/README.zh.md)——本控制器以其可用性为门槛的 `ctx.memory` provider 注册表。
- [hindsight HTTP provider](../../memory/hindsight-http/README.zh.md)——注册本控制器所读取的 daemon 的 provider。
- [记忆浏览器](../../client/ui-memory-browser/README.zh.md)——渲染这些应答的浏览器侧面板。
- [Remote 装配](../../api/remotes/README.zh.md)——客户端如何在不导入 Host 实现的前提下消费 `memoryController.*`。

-----

<a id="model-experience"></a>
## 模型体验

无。这个仅限 Host 的只读记忆投影不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明只读浏览面做不到什么。它们是当前包约束，不是任务积压。

- **搜索只覆盖知识页，不覆盖记忆**——`search` 查询整理好的知识索引，因为 seam 的记忆搜索在服务端运行推理、一分钟以上才返回；因此事实级搜索无法通过本 Remote 提供。
- **不投影原始记忆**——daemon 的记忆行携带本包不做映射的 provider 内部上下文，因此该界面展示的是库、统计与知识页，而不是单条记忆单元。
- **无写入、无历史**——这里的一切都不保留、不编辑、不合并、不删除，快照也不记录自上次读取以来发生了什么变化。
- **可用性是门槛，不是诊断**——控制器报告记忆不可用，但不报告是哪个 provider 注册了、它的后端为什么不健康；这些在 provider 自己的日志里。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

这里直接读取 daemon 的 REST 接口而不是经过某个 provider，因此 daemon 侧的端点改名表现为一个 `failed` 应答，而不是编译错误。出于这个原因，bank 列表与统计信封是逐字段读取的：形状变化会把某个计数降级为 `0`，而不是抛异常。知识库搜索端点是唯一其延迟特征要紧的端点——它是页面每次按键都会调用的唯一端点，而且与 `memories/recall` 不同，它是索引查找而非推理运行。

</details>