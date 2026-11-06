---
description: "assistant 包组：持久助理对话、独立任务记录与面向模型的任务创建工具。"
kind: "package-group"
---

# assistant/ — Host 拥有的助理与助理任务

[English](README.md) | 中文

## 摘要

`assistant/` 包组提供持久的全局与项目助理对话，以及独立任务。任务服务拥有持久标识与状态；工具让已注册助理通过共享 Session 控制器创建工作。助理归属存放在 Session 头部之外。[客户端界面](../client/ui-assistant/README.zh.md)呈现这些记录，并将其 Session 与普通导航分离。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## 包

服务与面向模型的工具分别拥有各自的职责。

| 包 | 角色 |
|---|---|
| [`task`](task/README.zh.md) | 持久助理与任务记录、状态、取消及 Session 可见性数据流 |
| [`tool-task`](tool-task/README.zh.md) | 仅限助理使用的 `create_task` 工具与模型指导 |

<a id="related-documentation"></a>
## 相关文档

- [助理子系统](../../docs/subsystems/assistant.zh.md) — 标识、请求、失败与 Session 可见性。
- [Session 子系统](../../docs/subsystems/session.zh.md) — 普通对话与执行 Session。

<a id="dev-note"></a>
## Dev Note

无。
