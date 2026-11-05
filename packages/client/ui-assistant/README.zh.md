---
description: "助理界面：全局与项目助理，以及分离的任务列表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-assistant

[English](README.md) | 中文

## 摘要

`dsh-client-ui-assistant` 为 Web 与 Desktop 侧栏增加一个助理入口和一个主面板。面板可选择全局助理或项目助理，打开该助理的会话，展示其任务列表，打开任务执行会话并取消进行中的任务。插件还注册 `create_task` 的对话卡片、带返回动作的会话头部标识（同时用于助理会话与任务会话），以及客户端分离源，使助理会话不进入普通用户的 Workspace 分组、未分组列表与搜索，但仍可从助理界面访问。

## 使用本包

在 Host 助理任务服务与 API Remote 组装之后，把插件挂到 web bundle：

```yaml
- id: ui-assistant
  name: '@deepseek-ai/dsh-client-ui-assistant'
```

仅在 Host 助理服务可读时显示入口。首次选择某个项目时，通过 Host 服务创建该项目助理。

## 模型体验

界面不新增系统提示，也不新增模型可见输入。它从 Host 记录渲染 `create_task` 结果卡片与助理任务列表。任务状态来自 Host 的 `assistant-task/changed` 事件，而不是客户端推断。

## 已知限制与后续工作

- 分离是客户端渲染接缝；未挂载本插件的客户端仍可能列出助理任务会话。
- 全局任务列表受 Host 每页大小限制；第一版不提供更早任务的分页。
- 定时任务仍在现有 Automation 页面，不在这里聚合。
- 没有可用执行会话的任务行显示失败状态，且不提供打开动作。
- 助理页面不会恢复打开任务前的那个用户会话。

## 开发说明

插件在 `remoteAccess.whenAccess('assistantTasks/assistants', ...)` 内注册主面板、侧栏行、任务卡片与隐藏会话源，因此没有读权限时不出现任何界面。隐藏源读取 Host 提供的可见性快照，其中同时标明助理会话与任务执行会话的归属；会话头部动作据此标注会话并返回所属助理。两项注册都随插件释放。
