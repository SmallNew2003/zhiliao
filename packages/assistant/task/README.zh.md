---
description: "Host 全局的助理记录与任务记录，执行会话与用户任务分离。"
kind: "package-reference"
---

# @deepseek-ai/dsh-assistant-task

[English](README.md) | 中文

## 概述

`dsh-assistant-task` 拥有个人助理界面背后的持久记录：一个全局助理、每个已注册项目一个项目助理，以及各助理创建的任务。助理会话与任务执行会话都是通过 Session 控制器创建的普通 Session；任务归属、状态与分离的 Session id 存放在本包的存储域中，不写入 Session 头部。模型可见的 `create_task` 工具位于同组的 `tool-task` 包。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在 Host 组合中，与 Session 控制器和 Workspace 注册表一起挂载：

```yaml
- name: '@deepseek-ai/dsh-assistant-task'
```

服务通过 Typert Remote 暴露 `ensureAssistant`、`assistants`、`tasks`、`cancelTask` 与 `visibility`，并向模型工具提供 Host 侧的 `createTask`。助理 preset、worker preset、单轮与活跃任务上限、prompt 与标题边界、列表每页大小都通过插件校验过的配置设置。`visibility` 返回每个分离会话及其所属助理或任务，客户端据此标注会话并返回对应助理。任务视图带有 `sessionAvailable`；调用方复用同一 `requestId`，或同一助理轮次出现完全相同的创建在部分失败后重试时，`createTask` 会复用既有任务与执行会话。

非 owner Remote 调用方需要每个实体的 Session 授权，项目实体还需要 Workspace 授权；列表与可见性逐项过滤返回的实体。此类调用方可确保已有可见对话存在，创建或替换助理对话则仅限 owner。读取 Session 元数据失败时错误向上传递，不会替换持久对话映射。

取消在记录 `cancelled` 前请求执行 agent（智能体）停止，并丢弃排队输入。取消失败保持可见，任务保留此前状态。

<a id="model-experience"></a>
## 模型体验

通过同组的 `create_task` 消费方间接影响模型：该消费方将用户授权的任务提示词提交到独立执行 Session。

#### KV Cache 影响

worker 所选的 preset 拥有其请求上下文；任务记录与状态更新不会向助理的模型历史添加文本。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 任务执行会话是普通 Session；未挂载助理界面的已发布客户端仍会列出它们。
- 全局助理可指向任一已注册项目；项目助理只能在自己的项目内创建任务。
- 周期任务仍留在现有 Schedule 界面，不聚合进助理任务列表。
- 一个任务对应一个执行会话。部分失败后的重试复用该记录与会话；主动重跑已完成任务留待后续。
- 执行会话从未创建成功时，任务视图返回 `sessionAvailable: false`；其失败码在重启对账后仍保留。

<a id="dev-note"></a>
### 开发备注

本包打开 `assistant` 存储域，包含 `assistants` 与 `tasks` 两张表及全局助理标识。写入通过单一队列串行化，启动时对中断任务进行对账，绝不写入 Session 格式标记。
