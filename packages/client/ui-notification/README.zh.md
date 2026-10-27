---
description: "会话完成、等待审批与 agent-loop 失败的原生系统通知，带合并窗口与点击跳转。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-notification

[English](README.md) | 中文

## 概述

本包在会话需要用户、而该会话又不在屏幕上时，弹出操作系统原生通知。三种转变会被通知：另一个会话占据主视图时本会话停止、领域请求等待用户、以及 agent-loop 失败。传输层每页选择一次：Desktop 上由 Electron 外壳承担，Web 上由浏览器 Notification API 承担。同时到达的通知按种类合并为一条，点击后聚焦窗口并打开通知所指的会话。偏好存放在 `ui-notification` 用户设置分区中。

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

把本插件挂进 Web 组合；该设置行不接受任何配置，`web-app` bundle 已包含它。设置的「通用」分区会出现一行**系统通知**，带一个总开关和每个通知种类各一个开关。关闭总开关会静默所有种类，同时保留各种类的选择。

### 预期行为

另一个会话占据主视图时本会话跑完，会弹出一条以该会话命名的通知；用户正在阅读的会话跑完则不弹。审批或提问在请求到达时弹出一条，请求持续待处理期间不重复弹。agent-loop 失败会弹出一条，正文带失败信息。多个会话同时跑完只弹一条，说明数量——因为 800 毫秒内到达的触发会按种类合并。点击通知会恢复并聚焦应用窗口，并打开通知所指的会话；合并通知打开它的第一个会话。设置行显示 OS 授权状态；Web 构建在第一条通知时向浏览器请求权限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

node 半（[`src/index.ts`](src/index.ts)）注册 `ui-notification` schemastery 分区，它是所有默认值的唯一权威。浏览器半（[`src/client/index.ts`](src/client/index.ts)）绑定该分区、选择传输层，并注册两个 slot 条目。

[`src/planner.ts`](src/planner.ts) 是纯判定面：比较两个 `SessionStatusSnapshot`，返回该转变挣得的触发。完成类要求会话已停止**且**在主视图之外仍未确认，这正是 `SessionStatus.completionUnread` 的含义；失败的轮次改发错误类触发，因此一次停止不会同时发两种。 [`src/coalescer.ts`](src/coalescer.ts) 是合并窗口：一个防抖收集器，每个触发都重启窗口，刷新时每种类产出一个批次。两者的定时器都由注入提供，因此测试不需要客户端运行时。

[`src/client/NotificationBridge.tsx`](src/client/NotificationBridge.tsx) 是喂给 planner 的席位。它什么都不渲染，注册在 `shell.overlay` 上，因此只有一个实例跨越每次会话切换；它把上一个快照存在 ref 中，并推送挣得的触发。 [`src/client/runtime.ts`](src/client/runtime.ts) 持有合并窗口，通过 locale 服务渲染通知文案，并在 `ctx.uiWorkspace` 这个可选协作者被组合时把点击路由到 `ctx.uiWorkspace.openSession`。 [`src/client/notifier.ts`](src/client/notifier.ts) 持有 `Notifier` 接口与两个实现；只要 Electron 外壳拥有该文档就优先选它，因为只有它能在点击时聚焦窗口。

Desktop 上，[`apps/desktop/src/notifications.ts`](../../../apps/desktop/src/notifications.ts) 校验每个 IPC 载荷——IPC 是进程边界——通过 Electron 的 `Notification` 呈现，并在聚焦窗口后把点击作为 `notify-clicked` 消息转发。每个 handler 只接受主窗口的顶层 frame。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-client-ui-session](../ui-session/README.zh.md) —— 本包消费的 `SessionStatus` 信号。
- [dsh-settings](../../settings/settings/README.zh.md) —— 持久化偏好背后的分区注册与解析契约。
- [dsh-client-ui-theme](../ui-theme/README.zh.md) —— 用同样方式自持设置行的同类功能。

-----

<a id="model-experience"></a>
## 模型体验

无，因为通知文案取自本包自己的 locale 词典，任何通知文本都不会进入会话日志或模型请求。

#### KV Cache 效果

无；本包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **macOS 在首次通知前不报告授权状态。** Electron 没有权限查询接口，因此外壳在 OS 回应之前一律报告 `default`，设置行显示「首次通知时系统会请求权限」而非已授权或已拒绝。
- **合并通知只打开它的第一个会话。** 点击目标是批次的第一个 session id；其余会话留在侧栏中，以未读完成标记显示。
- **Web 构建依赖活着的页面。** 浏览器通知由文档触发，因此关闭的标签页不发通知；Desktop 则持续通知，因为窗口进程独占传输层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

触发信号本就存在：`SessionStatus.completionUnread` 编码了「在主视图之外停止，仍未确认」，`ui-workspace` 已把它渲染成完成圆点。对共享表面的唯一新增是 `SessionStatus.lastAgentError`，由已有的 `api-session/error` remote 事件供给，而该事件正是 `agent/error` 在 agent loop 失败边界发出的。

</details>

**运行时不变式:** 不发布伴随包。planner 与 coalescer 是无分叉第二副本可偏离的纯函数，唯一的有状态对象是设置镜像与合并窗口，二者都由同一个插件 fiber 持有，其销毁由 HMR 安全性测试证明。
