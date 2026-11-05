---
description: "面向模型的 create_task 工具，基于 Host 助理任务服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-assistant-task

[English](README.md) | 中文

## 摘要

`dsh-tool-assistant-task` 在解析到 Host `ctx.assistantTasks` 服务的作用域中注册 `create_task` 模型工具。助理 preset 挂载它；步骤级条件使它只对已登记助理会话可见。调用通过 Session 控制器创建独立根会话，并返回任务与会话标识。

## 使用本包

把该行加入助理 preset 的插件列表：

```yaml
- id: tool-assistant-task
  name: '@deepseek-ai/dsh-tool-assistant-task'
```

全局助理可指定已注册项目；项目助理只能在自己的项目内创建任务。工具描述与 `tool:create_task` 指引要求模型只在用户明确请求时创建任务，并且在状态显示完成前不得声称任务已完成。

## 模型体验

工具输入为 `prompt`、可选 `title`、可选 `workspaceId` 与可选 `requestId`。结果为 `{ taskId, sessionId }` 或结构化错误码；任务记录已存在后的失败还会带上 `taskId`，执行会话已创建时还带上 `sessionId`，便于调用方打开或重试。复用同一 `requestId` 会复用既有任务与执行会话，且首条 prompt 不会重复投递。工具不暴露 worker preset 选择；执行使用 Host 配置的 worker preset。任务执行沿用其执行会话正常的工具审批与权限策略。

## 已知限制与后续工作

- 仅在 Host 挂载 `assistantTasks` 服务时可用。
- 工具不提供任务列表、取消或状态读取；这些操作属于助理界面。
- 未登记为全局或项目助理的会话不能创建任务。

## 开发说明

工具在其挂载作用域解析 `ctx.assistantTasks`，把调用者 Session id 传给 Host 服务，并只通过声明的错误码把提供方与存储失败暴露给模型。
