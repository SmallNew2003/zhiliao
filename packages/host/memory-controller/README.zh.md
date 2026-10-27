---
description: "Remote 投影部署保留的长期记忆：bank 列表、每个 bank 的统计、知识页树、知识库搜索、页面正文、记忆单元分页，以及一个人执行的两项写入，供浏览器记忆面板使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-memory-controller

[English](README.md) | 中文

## 概述

客户端在 `memoryController` 命名空间上调用八个方法，展示并编辑部署的长期记忆：`list` 给出记忆库及其事实数与最后写入时间，`stats` 给出单个库的节点、链接、文档总数以及事实类型与链接类型分布，`pages` 给出某个库的知识页，`search` 检索知识索引，`page` 给出单个页面的正文，`units` 给出单个库一页记忆单元，`remember` 与 `curate` 承担一个人执行的两项写入。每个方法都返回结构化状态而不是抛异常，因此浏览器能说明**具体**命中了哪种情况——记忆未启用、部署配置有误、provider 不提供该分区、daemon 不可达、请求失败——而不是只显示一个笼统的传输错误。

本服务是投影而非传输：每个方法都解析记忆 seam 的浏览表面并经它调用，因此面板面对的是部署挂载的那个 provider，更换后端无需改动这里。

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

### 分页浏览一个库的记忆单元

`memoryController/units` 返回一个库一页的记忆单元——后端提取出的单条事实，统计与知识页只概括它们、从不逐一列出。每个单元携带其文本，并在后端上报时携带事实类型、上下文、标签以及提及与更新时间。调用方的 `query` 是对单元文本与上下文的大小写不敏感子串过滤，`factType` 限定一个后端分类；空过滤会被丢弃而不是发出，页大小钳制在 `[1, 100]`、默认 20。应答携带后端对当前过滤的总数，客户端因此可以分页而无需自己计数。该列表在 daemon 上是一次扫描而非推理调用：它是浏览辅助，而 seam 自己的搜索仍是 agent 使用的那次按推理计价的查找。

### 写入记忆

`memoryController/remember` 记录一条发现：脱离上下文仍成立的文本，以及后端归档它时使用的可选上下文。在通过推理提取事实的后端上保留是异步的，因此应答报告受理结果并携带后端的操作细节；提取完成后单元即可列出，客户端刷新后即可看到。空发现在任何调用之前就被拒绝，以 `remembered: false` 加一条说明原因的 detail 返回。

`memoryController/curate` 编辑一条已有单元：替换文本、上下文或事实类型，只在调用方传入时发送。什么都不改的策展会以同样方式被拒绝，会把文本清空的也一样。拒绝该事实类型的后端——hindsight 拒绝它派生的事实——以后端自己的话作为结果的 detail 应答，客户端原样展示。

### 不可用是应答，不是异常

每个方法都返回 `available: false` 并带上 `reason` 与 `detail`，而不是 reject。这一点很重要：被拒绝的 Remote 调用到达浏览器时只是一个不透明的传输失败，无法说明发生了哪种后端情况，而*这个构建里没有记忆*与*daemon 挂了*需要用户做出不同的反应。五种原因是：

| 原因 | 含义 |
|---|---|
| `unavailable` | 没有可用的 provider 已注册，即该部署未启用记忆。不会打开任何连接。 |
| `misconfigured` | Host 固定了一个未注册的 provider id，或有多个可用 provider 竞争而未固定。两者都通过配置一个 provider id 解决。 |
| `unsupported` | provider 有应答，但不提供浏览表面、或不提供所要求的分区——即只服务 agent 路径的后端。修复方式是指向一个可浏览的 provider。 |
| `unreachable` | daemon 在配置的时间预算内没有应答。 |
| `failed` | daemon 返回了错误、返回了非 JSON 内容、没有该库，或传输失败。 |

`detail` 承载 Host 或 provider 自己的原话，用于原因本身不足以解释的情况。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

`memory` seam 与拥有 agent 的召回、搜索、保留一样，拥有面向人的浏览表面：该表面的词汇——库、统计、知识页、记忆单元与写入结果——由 seam 声明一次，本控制器把它投影到 Typert Remote 上。直接与 daemon 对话的控制器会把面板绑死在一个后端上，而这正是 seam 要防止的事；自建一份词汇副本的控制器则会任线上用词与 seam 漂移。

表面经 `ctx.memory.browse()` 逐次解析，因此两次调用之间出现或消失的 provider 会被尊重，缺失或配置错误的 provider 的分类发生在任何连接打开之前。没有浏览表面的 provider——或缺少可选的统计与知识页成员的——以 `MEMORY_CAPABILITY_UNSUPPORTED` 拒绝，它投影为 `unsupported` 原因：只服务 agent 路径的后端是合法部署，面板就地说明，而不是让每次读取都失败。

### 端点归属

本包不映射任何端点。daemon 的 URL、超时与响应投影归 provider 所有——已交付的是 [`dsh-memory-hindsight-http`](../../memory/hindsight-http/README.zh.md)——因此挂载第二个后端无需触碰本控制器。客户端传回的线上 id 归 provider 所有，并在 seam 边界处被 branding。这里任何方法都刻意不投影 `memories/recall`：它在服务端运行推理，一分钟以上才返回，对交互式页面不可用。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `MemoryController`：`memoryController` Remote 服务、seam 浏览委派与 seam 分类投影 |
| [`src/types.ts`](src/types.ts) | 线上词汇：状态信封与每个方法的载荷，浏览词汇自 seam 再导出 |
| — | 不发布运行时不变式伴生检查；每个应答都直接由 seam 的表面投影而来。 |

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


这些限制说明这个浏览加写入界面做不到什么。它们是当前包约束，不是任务积压。

- **搜索只覆盖知识页，不覆盖记忆**——`search` 查询整理好的知识索引，因为 seam 的记忆搜索在服务端运行推理、一分钟以上才返回；本 Remote 提供的事实级辅助是单元列表的子串过滤，它只扫描不排序。
- **无删除、无历史**——写入只记录与策展；这里不删除单元、不触发合并，也不记录自上次读取以来发生了什么变化。拥有删除端点的后端需要先在 seam 中有对应成员，本 Remote 才能投影它。
- **可用性是门槛，不是诊断**——控制器报告记忆不可用，但不报告是哪个 provider 注册了、它的后端为什么不健康；这些在 provider 自己的日志里。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

这里直接读取 daemon 的 REST 接口而不是经过某个 provider，因此 daemon 侧的端点改名表现为一个 `failed` 应答，而不是编译错误。出于这个原因，bank 列表与统计信封是逐字段读取的：形状变化会把某个计数降级为 `0`，而不是抛异常。知识库搜索端点是唯一其延迟特征要紧的端点——它是页面每次按键都会调用的唯一端点，而且与 `memories/recall` 不同，它是索引查找而非推理运行。

</details>