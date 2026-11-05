---
description: "Host 全局的助理记录与任务记录，执行会话与用户任务分离。"
kind: "package-reference"
---

# @deepseek-ai/dsh-assistant-task

[English](README.md) | 中文

## 摘要

`dsh-assistant-task` 拥有个人助理界面背后的持久记录：一个全局助理、每个已注册项目一个项目助理，以及各助理创建的任务。助理会话与任务执行会话都是通过 Session 控制器创建的普通 Session；任务归属、状态与分离的 Session id 存放在本包的存储域中，不写入 Session 头部。模型可见的 `create_task` 工具位于同组的 `tool-task` 包。

## 使用本包

在 Host 组合中，与 Session 控制器和 Workspace 注册表一起挂载：

```yaml
- name: '@deepseek-ai/dsh-assistant-task'
```

服务通过 Typert Remote 暴露 `ensureAssistant`、`assistants`、`tasks`、`cancelTask` 与 `visibility`，并向模型工具提供 Host 侧的 `createTask`。助理 preset、worker preset、单轮与活跃任务上限、prompt 与标题边界、列表每页大小都通过插件校验过的配置设置。`visibility` 返回每个分离会话及其所属助理或任务，客户端据此标注会话并返回对应助理。任务视图带有 `sessionAvailable`；调用方复用同一 `requestId`，或同一助理轮次出现完全相同的创建在部分失败后重试时，`createTask` 会复用既有任务与执行会话。

## 模型体验

本服务本身不新增模型可见输入。`create_task` 由 `@deepseek-ai/dsh-tool-assistant-task` 注册；它创建独立的任务会话并返回任务与会话标识。任务状态由持久会话事实推导并推送给客户端，不会注入助理对话。

## 已知限制与后续工作

- 任务执行会话是普通 Session；未挂载助理界面的已发布客户端仍会列出它们。
- 全局助理可指向任一已注册项目；项目助理只能在自己的项目内创建任务。
- 周期任务仍留在现有 Schedule 界面，不聚合进助理任务列表。
- 一个任务对应一个执行会话。部分失败后的重试复用该记录与会话；主动重跑已完成任务留待后续。
- 执行会话从未创建成功时，任务视图返回 `sessionAvailable: false`；其失败码在重启对账后仍保留。

## 开发说明

本包打开 `assistant` 存储域，包含 `assistants` 与 `tasks` 两张表及全局助理标识。写入通过单一队列串行化，启动时对中断任务进行对账，绝不写入 Session 格式标记。
