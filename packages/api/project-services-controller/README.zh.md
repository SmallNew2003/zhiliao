---
description: "面向 Web 与 Desktop 客户端的主机 Remote 控制器：服务清册、留存日志、生命周期控制与实时更新流。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-project-services-controller

[English](README.md) | 中文

## 概述

`dsh-api-project-services-controller` 为 Web 与 Desktop 客户端的项目服务面板供数：它经 `projectServices` Remote 命名空间暴露受信主机运行时的服务清册、留存日志、生命周期控制与实时更新。每个端点都把领域记录映射为普通 JSON 视图，品牌标识符不过线。读取统一走一个共享读取身份；每次变更调用都必须声明自己的 `caller`，并带上面板观测到的修订号。本控制器不注册工具、提示词段或 Session 事件；当客户端需要项目服务数据时，把它与 `dsh-project-services` 和 Typert Gateway 一起挂载。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

主机控制器持有 `ctx.projectServicesController` 与生成的 `ctx.remote.projectServices` 命名空间；Web 应用 bundle 把它与 Typert Gateway、项目服务运行时一起挂载。每个操作都以请求携带的工作目录为作用域，缺省取主机进程的当前目录。

- `list` —— 返回一页活跃服务、Git checkout 可用性、Docker/Compose 分组与提供方状态。
- `logs` —— 读取某个服务目标的运行时留存输出，上限为调用方的 `maxBytes`。
- `control` —— 按启动定义启动服务，或按 id 停止、重启既有目标。每次变更都要声明 `caller` 与调用方观测到的 `expectedRevision`；缺少 caller、缺少修订号或修订号不再匹配，本次调用即失败。
- `follow` —— 先流式推送一份清册基线，再推有序更新帧，直到客户端取消。

本包不声明配置字段。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`ProjectServicesController` 继承 `TypertRemoteService`，命名空间为 `projectServices`。每个端点先为请求方构造人类授权的 `ServiceAccess`，再把调用转给 `ctx.projectServices`；随后 `mapInventoryView` 与 `mapLogsView` 把品牌标识符、可选字段与嵌套记录压平为 `src/types.ts` 中的 `Api*View` 类型。`list`、`logs` 与 `follow` 使用共享的 `remote:reader` 身份，`control` 则使用请求里的 `remote:<caller>`。`control` 在客户端未提供请求 id 时代为生成，并拒绝把启动定义与 `start` 以外的动作配对。`follow` 逐帧转发运行时流并重新映射每份快照，因此线上契约始终是那套 JSON 视图。

</details>

<a id="model-experience"></a>
## 模型体验

### 面向 GUI 的数据供给

#### 模型可见内容

无直接可见内容。本控制器经 Remote 传输应答浏览器与 Desktop 客户端，不注册工具、系统提示词段或 Session 事件，因此它返回的字符串都不进入模型请求。同一批服务的模型可见界面是 [`dsh-tool-project-services`](../../workspace/tool-project-services/README.zh.md)。

#### Token 影响

直接 Token 成本为零。本控制器不贡献请求内容，也不追加会话历史；没有任何模型请求会为它的输出付出 Token。

#### KV Cache 影响

不直接修改请求前缀，也不使缓存失效。本控制器不组装 provider 请求，已可复用的前缀保持可复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制说明这个 Remote 界面不校验、不恢复的内容。它们是当前包约束，不是任务清单。

- **读取未被收窄** —— 每个端点的 `canRead` 都授出全部观测到的资源，读取过滤交给运行时及其提供方，控制器自己不收窄。
- **变更调用走人类授权，不经 Agent 审批接缝** —— 浏览器或 Desktop 客户端的 `control` 调用由控制器自己的 `authorize` 放行，不会询问人工应答方；这条路径的访问策略归挂载本包的那个组合所有。Agent 工具那道需要审批的路径是 `dsh-tool-project-services`。
- **所有读取共用一个读取身份** —— 读取固定使用 `remote:reader` 标签，无法归属到某个具体连接；变更调用则必须声明自己的 `caller`。
- **`follow` 没有追赶游标** —— 每一代流都从运行时取一份全新基线，重连得到的是另一份基线，而不是断开期间错过的增量。
- **日志读取止于运行时留存** —— 控制器原样透传调用方的 `maxBytes`，不另设上限，运行时已丢弃的输出无法经本界面取回。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

用 `pnpm exec vitest run packages/api/project-services-controller` 跑控制器用例；该用例经桩 Typert Gateway 驱动全部四个端点，底层是模拟的 `ProjectServiceRuntime`，不需要 key，也不需要主机进程。

</details>

**运行时不变式：** 不发布运行时不变式伴生入口。控制器投影的事实都由运行时持有，控制器本身不持有任何可被独立观察拆分的所属关系。
