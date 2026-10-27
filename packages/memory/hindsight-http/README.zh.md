---
description: "hindsight HTTP 记忆提供方：ctx.memory 后端如何接入本机 hindsight daemon、按 workspace 解析记忆库，跨召回、搜索与保留为服务端推理延迟设定边界，并实现面向人的消费方读写的浏览表面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-hindsight-http

[English](README.md) | 中文

## 概述

使用 `dsh-memory-hindsight-http` 通过 HTTP 把 hindsight daemon 作为 `ctx.memory` 的后端。它按 workspace 解析一个记忆库，通过 hindsight 的混合索引回答召回与搜索，保留完成的 transcript，并把每一次传输与状态失败映射为 `MemoryError`。它还实现了 seam 的浏览表面：记忆库列表、一个库的记忆单元、统计与知识页，以及一个人执行的两项写入——记录一条发现与策展一条已有单元。当部署已经在运行一个本机 hindsight daemon 时选择它。请为延迟做好预算：召回与搜索由服务端推理作答，单次调用可能超过一分钟，因此 `recallTimeoutMs` 默认给到两分钟。位于 agent 热路径的调用方必须捕获 `MEMORY_BACKEND_TIMEOUT` 并继续。

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

想要 hindsight 支撑的记忆的组合会先加载 `dsh-memory` 服务，然后挂载本提供方。该插件以 id `hindsight` 注册一个 `MemoryProvider`，因此只挂载一个后端的部署可以不设置 `provider`，让 seam 自动选择。

### 何时选择

当可以通过 HTTP 访问到 hindsight daemon、且希望使用它的记忆库、混合召回与事实抽取而不想自己写后端时选择本提供方。由于默认 `baseUrl` 指向同一台机器上的 daemon，WorkBuddy 与本 Harness 读写同一份记忆库，因此在一条工具链中学到的事实，可以在另一条中被召回。当记忆应当只存在于进程内时你不需要它——seam 没有其他已交付后端。每一项操作都需要 daemon 存活：没有它时 `available()` 返回 false，seam 调用抛出 `MEMORY_PROVIDER_UNAVAILABLE`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-memory'
- name: '@deepseek-ai/dsh-memory-hindsight-http'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:9077` | daemon 基础 URL；尾部斜杠会被去掉 |
| `defaultBankSuffix` | `main` | 无法解析出项目名时使用的库 id 后缀 |
| `metadataTimeoutMs` | `5000` | health、库列表等廉价元数据端点的超时 |
| `recallTimeoutMs` | `120000` | 召回与搜索的超时，它们在服务端运行推理 |
| `retainTimeoutMs` | `30000` | 保留 transcript 的超时 |
| `maxRetainChars` | `200000` | 单次保留请求发送的 transcript 字符上限 |

每个数值字段都必须是正的有限数；非正值或无穷值会在配置时被拒绝，而不是悄悄变成 1 毫秒的定时器。把 `baseUrl` 指向远程 daemon 并相应提高超时，无需改动代码。

### 记忆库命名

记忆库命名为 `coding-agent::<项目目录名>`，其中项目名是 workspace 根路径的最后一段。因此同一仓库的同级 checkout 会各自保有独立的记忆库，而不是合并成一个；路径中得不到可用末段的 workspace 则回退到 `defaultBankSuffix`。解析流程是先 `GET /v1/default/banks`，随后在缺失时用 `PUT` 创建该库，因此新 workspace 中的首个会话不会是一次失败。

### 浏览表面

本提供方以自身承载 seam 的浏览表面：`ctx.memory.browse()` 返回的提供方，其公开方法就是该表面。`listBanks()`、`listUnits()`、`remember()` 与 `curateUnit()` 分别应答自 daemon 的库列表、记忆单元列表、保留与策展端点；`bankStats()`、`listPages()`、`searchPages()` 与 `pageBody()` 应答自 hindsight 策展的统计与知识库端点。单元列表把 hindsight 的 `type` 过滤当作事实类型、`q` 过滤当作子串过滤，并以 `limit` 与 `offset` 分页；事实类型字段在列表上拼作 `fact_type`、在单元端点上拼作 `type`，因此一个投影同时读取两种拼写。

写入遵循 daemon 自己的语义。`remember()` 把发现作为一条异步保留条目提交，在 daemon 接受后即返回——提取是服务端推理，单元随后才可列出——并以操作 id 作为结果的 detail。`curateUnit()` 修补文本、上下文或事实类型；daemon 会拒绝它派生的事实类型（例如 observation），拒绝消息原样作为结果的 detail 传出。每次浏览读取共享廉价元数据预算，因为单元列表是扫描而非推理调用。

### 延迟是关键运维事实

hindsight 回答召回与搜索靠的是运行推理，而不是查索引。在冷 daemon 上单次召回或搜索可能耗时远超一分钟，这正是 `recallTimeoutMs` 默认 120 秒、而元数据与保留默认按秒计的原因。调用方必须把 `MEMORY_BACKEND_TIMEOUT` 当作预期结果而非异常：已交付的消费方会捕获它、记录一条警告，并在没有记忆的情况下继续本回合。保留反而比看上去便宜，因为它异步——调用在 daemon 接受条目后就返回，抽取在服务端继续进行。

### 失败与恢复

每次失败都以 `MemoryError` 呈现，携带可路由的 code：超过该类超时未作答时为 `MEMORY_BACKEND_TIMEOUT`，daemon 不可达、返回非 2xx 状态或返回的内容不是 JSON 时为 `MEMORY_BACKEND_ERROR`，404 时为 `MEMORY_BANK_NOT_FOUND`。可用性被惰性探测并记忆：`available()` 在首次探测仍在进行时报告 true，并把结果缓存整个进程生命周期，因此在成功探测之后宕机的 daemon 会在下一次调用时被发现，而不是被探测发现。要恢复，请重启 daemon 或重新指向 `baseUrl`；不涉及代码改动。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本提供方建立在三个刻意的选择之上：

- **一个 REST 界面，全部能力。** daemon 的 `/v1/default` 端点覆盖了全部需要：用于解析的库列表与创建、同时承担召回与搜索的一个混合召回端点、面向完成会话的文档保留，以及浏览表面背后的列表、策展、统计与知识库端点。
- **召回与搜索是同一个请求。** hindsight 把搜索暴露为带上限的召回，因此两项能力共用一条代码路径与一份超时预算，而不是假装它们是不同的操作。
- **每次调用都有边界且被分类。** 没有任何请求在缺少超时的情况下发出，也没有任何失败以原始传输错误的形式逸出；每一种都被映射到 seam 的分类体系上，使调用方按 code 而非异常消息路由。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema 与默认值、数值校验，以及把提供方注册进 `ctx.memory` |
| [`src/provider.ts`](src/provider.ts) | HTTP 客户端与 `MemoryProvider` 实现：库解析、召回／搜索、保留、浏览表面与错误映射 |
| — | 不发布运行时不变式配套项；该提供方不持有注册表，除自身的可用性探测外也不发布观测流。 |

### 数据模型

`HindsightProviderLimits` 是插件交给提供方的传输与行为约定：与谁通信、每类请求可以花多久，以及一次保留请求可以携带多少 transcript。两个投影塑造了面向 seam 的结果。库列表被防御性地读取——裸数组与 `{ banks: [...] }` 信封都被接受，因为每行只读取 `bank_id`。召回行通过跳过缺少字符串 `id` 与 `text` 的条目投影为 `MemoryUnit`，因此格式错误的后端响应会降级为更少的单元，而不是抛出异常。浏览投影遵循同样的纪律：没有 id 的库行被跳过；单元行在后端上报时投影可选的事实类型、上下文、状态、标签与时间戳；读不出单元的策展响应是一条拒绝，其 detail 原样传出而不靠猜测。

### 请求流程

`resolveBank()` 从 workspace 路径推导库 id，在元数据超时内列出库，缺失时用 `PUT` 创建。`recall()` 与 `search()` 都调用 `recallUnits()`，它在 `recallTimeoutMs` 下向库的召回端点发送 `{ query, limit }` 并返回 `truncated: false`——上限由 seam 在本提供方返回之后施加，因此提供方不去二次质疑这个边界。`retain()` 把每个 transcript 回合转成一个保留条目，在 `maxRetainChars` 之前停下，使长会话不会产生无界请求，并以 `async: true` 发送。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从本提供方注册进入的 seam，走到它的延迟强加给调用方的防御规则。

- [dsh-memory](../memory/README.zh.md)——seam 约定：提供方选择、`MemoryError` 分类体系，以及本提供方让渡给它的结果上限。
- [能力 seam](../../../docs/capability-seams.zh.md)——可替换的能力 seam 相对核心服务与 bundle 的定位。
- [防御式模式](../../../docs/defensive-patterns.zh.md)——捕获缓慢后端而不是让一个回合失败的规则。
- [生成配置目录](../../../docs/config-catalog.zh.md)——整个 Harness 的每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 被召回的记忆内容

#### What the model sees

通过挂载本提供方的消费方，这里返回的单元会成为模型作为召回背景知识读到的文本。本提供方决定了这些文本的内容，因为 `MemoryUnit.text` 是 daemon 对一个抽取事实的自身渲染，而不是逐字 transcript，并且每个单元只投影出它的 `id` 与 `text`。召回与搜索返回相同的形状，因此模型无法从载荷判断它来自哪一次操作。

#### Token effect

依赖数据且不受本包限制：单元文本长度就是 daemon 抽取产生的结果，唯一的封顶是调用方的 `limit`，而它由 seam 在本提供方返回之后施加。保留反而是有界的，受请求侧的 `maxRetainChars` 约束。

#### KV Cache effect

没有直接影响：本提供方不注册提示词段落，也不注册 schema。延迟才是真正的代价——一次跑满 `recallTimeoutMs` 的召回会延迟回合，却不会改变可复用的请求前缀；而一次超时的召回只是不贡献任何注入内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方单独使用时在哪些方面不完整。它们是当前包约束。

- **可用性依赖一个本包并不管理的 daemon**——daemon 必须已经在运行；这里没有任何东西负责启动、安装或守护它。当它宕机时，`available()` 最终返回 false，seam 调用抛出 `MEMORY_PROVIDER_UNAVAILABLE`，热路径调用方必须越过这次失败继续。
- **召回延迟按设计就很高**——服务端推理意味着单次调用可能超过一分钟，冷 daemon 更慢。`recallTimeoutMs` 默认为 120 秒，超过它抛出 `MEMORY_BACKEND_TIMEOUT` 而不是返回部分结果；没有流式或部分召回模式。
- **一次成功的健康探测会被缓存整个进程生命周期**——`available()` 在首次探测进行中时报告 `true` 并记忆结果，因此在一次成功探测之后宕机的 daemon 会被下一次真实调用发现，而不是被探测发现。
- **只使用了 hindsight REST 接口的一个子集**——召回、保留与库端点已实现；mental models、entities 与 knowledge-base 端点没有实现。更丰富的管理界面属于控制器层，而不是这个传输层。
- **搜索与召回无法分别调优**——两者在同一个超时下发送相同的召回载荷，因此部署无法给搜索比会话开场召回更短的预算。
- **库 id 仅由目录名推导**——没有 Git 感知的项目检测，因此共享目录名的两个无关 checkout 会共享一个记忆库，而 `defaultBankSuffix` 只覆盖路径中没有可用末段的情形。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文为准。

#### 未来：更丰富的 hindsight 端点

本提供方止步于召回、保留与库。mental models、entities 与 knowledge-base 端点被刻意留给本传输层之上的控制器，因此暴露它们是扩展控制器词汇的问题，而不是教会本提供方一种新请求形状的问题。

#### 未来：更廉价的可用性信号

`available()` 乐观地报告 `true`，并把首次探测记忆整个进程生命周期，这使热路径没有请求开销，但也意味着 daemon 宕机会被发现得较晚。对被记忆的结果加一个较短 TTL，可以用一点热路径成本换取更快的检测；目前没有消费方需要它。

</details>
