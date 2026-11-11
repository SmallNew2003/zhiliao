---
description: "Host 全局的助理记录与任务记录，执行会话与用户任务分离。"
kind: "package-reference"
---

# @deepseek-ai/dsh-assistant-task

[English](README.md) | 中文

## 概述

`dsh-assistant-task` 拥有个人助理界面背后的持久记录：一个全局助理、每个已注册项目一个项目助理，以及各助理创建的任务。助理会话与任务执行会话都是通过 Session 控制器创建的普通 Session；任务归属、状态与分离的 Session id 存放在本包的存储域中，不写入 Session 头部。面向模型的创建与查询工具位于同组的 `tool-task` 包。

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

服务通过 Typert Remote 暴露 `ensureAssistant`、`assistants`、`task`、`tasks`、`cancelTask` 与 `visibility`，并向模型工具提供 Host 侧的 `createTask`。助理 preset、worker preset、单轮与活跃任务上限、prompt 与标题边界、列表每页大小都通过插件校验过的配置设置。`visibility` 返回每个分离会话及其所属助理或任务，客户端据此标注会话并返回对应助理。任务视图带有 `sessionAvailable`；调用方复用同一 `requestId`，或同一助理轮次出现完全相同的创建在部分失败后重试时，`createTask` 会复用既有任务与执行会话。

非 owner Remote 调用方需要每个实体的 Session 授权，项目实体还需要 Workspace 授权；列表与可见性逐项过滤返回的实体。此类调用方可确保已有可见对话存在，创建或替换助理对话则仅限 owner。读取 Session 元数据失败时错误向上传递，不会替换持久对话映射。

取消操作先持久保存 `cancelling`，拒绝工作智能体的新步骤，等待执行智能体和其管理的后代全部停止，再记录 `cancelled`。停止失败时保留 `cancelling` 并记录 `cancel_failed`；可以重试取消。后代的准入限制只作用于该执行智能体实例。

每条结果通知都携带任务和执行 Session 标识，以及工作智能体的最终文字或公开的失败说明。`maxResultChars` 默认将结果文字限制为 2,048 个 UTF-16 单元。提供方和传输层诊断保留在执行 Session 中。轮次结束表示工作智能体已给出报告，外部操作是否成功还需独立验证。

<a id="model-experience"></a>
## 模型体验

助理通过任务工具查询自己的工作，并从创建任务的 Session 收到带来源标识的 `assistant-task` 收件箱通知。

#### KV Cache 影响

终态通知在创建者对话中增加一条普通收件箱输入；中间状态不会追加到该对话的模型历史。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 任务执行会话是普通 Session；未挂载助理界面的已发布客户端仍会列出它们。
- 全局助理可指向任一已注册项目；项目助理只能在自己的项目内创建任务。
- 周期任务仍留在现有 Schedule 界面，不聚合进助理任务列表。
- 一个任务对应一个执行会话。部分失败后的重试复用该记录与会话；主动重跑已完成任务留待后续。
- 执行会话从未创建成功时，任务视图返回 `sessionAvailable: false`；其失败码在重启对账后仍保留。

<a id="dev-note"></a>
### 开发备注

`assistant` 存储域将通知及其稳定消息 ID 与终态结果一同保存。重启后，服务通过创建者 Session 的收件箱收据核对未确认投递，包括已被领取的输入。启动时，服务从驻留或已存的执行 Session 读取首个工作轮次的结果。尚未结束的驻留 worker 继续运行。恢复扫描成功后，服务才开始投递待发通知。Session 读取失败时，服务保留原任务记录供恢复，并报告存储错误。已尝试投递但没有收据时，结果保持未知，不会重复发送。缺少确切创建者的旧任务仍可读取，不补发历史通知。
