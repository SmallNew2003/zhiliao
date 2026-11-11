---
kind: upgrade-guide
description: "Assistant task clients must handle cancellation in progress and Hosts must accept task domain version 2."
---

# Assistant task cancellation and results

English | [中文](guide.zh.md)

## Change

`AssistantTaskStatus` includes `cancelling` until the execution Agent and its descendants stop. The Host writes assistant storage domain version 2 and reads version 1. Existing tasks without a known creating Session do not send retrospective notices. New tasks can append messages whose source kind is `assistant-task` to the creating Session. The assistant client export `AssistantState.selected` now contains an `AssistantView | null` instead of `AssistantId | null`, and `AssistantState.assistants` is removed.

## Migration

1. Handle `cancelling` as active in task clients. If cancellation fails, show the failure and allow cancellation to be retried. Treat `resultSummary` as optional worker output. Read the current id from `selected?.id`; use `assistantTasks/assistants` for the catalog.
2. Include `sessionProjections` in custom Host compositions mounting the assistant service. In Session consumers, display `assistant-task` as a task result, not a human request.
3. Retain a pre-upgrade backup if you must return to an older Host: once the assistant domain is written, a version 1 Host cannot open it. Verify that `assistantTasks/tasks` still lists old tasks and that a new task’s result reaches its creating conversation.
