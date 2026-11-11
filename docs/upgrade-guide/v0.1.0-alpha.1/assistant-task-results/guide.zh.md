---
kind: upgrade-guide
description: "助理任务客户端须处理取消中状态，Host 须支持版本 2 的任务存储域。"
---

# 助理任务的取消与结果

[English](guide.md) | 中文

## 变更

`AssistantTaskStatus` 增加了 `cancelling`，直到执行智能体和后代停止。Host 写入版本 2 的助理存储域，也能读取版本 1。旧任务缺少确切创建者 Session 时不补发历史通知。新任务可向创建者 Session 追加来源类型为 `assistant-task` 的消息。助理客户端导出的 `AssistantState.selected` 现在是 `AssistantView | null`，不再是 `AssistantId | null`，且不再提供 `AssistantState.assistants`。

## 迁移

1. 在任务客户端中将 `cancelling` 视为活跃状态。取消失败时展示原因并允许重试取消。`resultSummary` 是可选的工作智能体输出。通过 `selected?.id` 读取当前助理 ID，通过 `assistantTasks/assistants` 查询助理目录。
2. 挂载助理服务的自定义 Host 组合须包含 `sessionProjections`。Session 消费方应将 `assistant-task` 展示为任务结果，而非人类请求。
3. 如果需要回到旧版 Host，请保留升级前的数据备份：一旦写入助理存储域，版本 1 的 Host 就无法打开它。验证 `assistantTasks/tasks` 仍能列出旧任务，并确认新任务的结果送达创建者对话。
