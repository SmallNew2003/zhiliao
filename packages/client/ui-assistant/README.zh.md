---
description: "助理界面：全局与项目助理，以及分离的任务列表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-assistant

[English](README.md) | 中文

## 概述

在 Web 或桌面端侧栏选择全局助理或项目助理。宽面板将对话与任务并排显示，窄面板将对话放在任务上方。任务按待处理、进行中和已结束分组。打开任务可查看执行会话，也可从会话头部返回创建该任务的助理。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在 Host 助理任务服务与 API Remote 组装之后，把插件挂到 web bundle：

```yaml
- id: ui-assistant
  name: '@deepseek-ai/dsh-client-ui-assistant'
```

全局列表包含所有已获授权的任务，选择项目后只显示该项目的任务。点击“加载更早的任务”可继续查看历史。对话中的任务创建卡片显示最新状态，并在可用时展示执行助理的结果摘要。执行停止后，任务才显示为已取消。若停止执行失败，可在任务上重试取消。

仅在 Host 助理服务可读时显示入口。owner 首次选择某个项目时，通过 Host 服务创建该项目助理；非 owner 调用方只能打开已有且获得授权的助理。

<a id="model-experience"></a>
## 模型体验

没有影响，因为客户端渲染 Host 助理记录与工具结果，不添加模型输入。

#### KV Cache 影响

导航、任务卡片与状态更新不改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 分离是客户端渲染接缝；未挂载本插件的客户端仍可能列出助理任务会话。
- 定时任务仍在现有 Automation 页面，不在这里聚合。
- 执行会话可用时才能打开任务。
- 助理页面不会恢复打开任务前的那个用户会话。

<a id="dev-note"></a>
### 开发备注

插件在 `remoteAccess.whenAccess('assistantTasks/assistants', ...)` 内注册界面与隐藏会话源。面板持有所选会话的引用，并在该会话作用域渲染 `conversation.embedded`。任务卡片读取 `assistantTasks/task`，收到本任务的变更事件时刷新。临时读取故障保留已打开的对话、任务历史和已读取的任务详情。Host 拒绝访问或报告任务不存在时，卡片撤回详情。普通工作区列表暂时隐藏每个新出现的会话，直至覆盖该会话的归属检查成功。检查期间新增的会话会一同触发补查。检查失败时，已确认的普通会话保持可见，可在工作区会话列表或助理任务面板重试。切换项目会使上个项目未完成的选择和读取失效。
