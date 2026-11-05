---
description: "Model-facing create_task tool over the Host assistant task service."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-assistant-task

English | [中文](README.zh.md)

## Summary

`dsh-tool-assistant-task` registers the `create_task` model tool in the scope that resolves the Host `ctx.assistantTasks` service. The assistant preset mounts it; a step-time condition keeps it invisible to assistant-preset Sessions that are not registered assistants. A call creates an independent root Session through the Session controller and returns the task and Session identities.

## Use this package

Add the row to the assistant preset's plugin list:

```yaml
- id: tool-assistant-task
  name: '@deepseek-ai/dsh-tool-assistant-task'
```

A global assistant may name a registered project; a project assistant is confined to its own project. The tool description and `tool:create_task` guidance tell the model to create tasks only at the user's explicit request and not to claim a task finished before its status says so.

## Model Experience

The tool input is `prompt`, optional `title`, optional `workspaceId`, and optional `requestId`. Its result is either `{ taskId, sessionId }` or a structured error code; a failure after the task record exists also carries `taskId` and, when created, `sessionId` so the caller can open or retry it. Reusing the same `requestId` reuses the existing task and execution Session and never delivers the first prompt twice. The tool exposes no worker preset choice; execution uses the Host-configured worker preset. A task runs with the normal tool approval and permission policy of its execution Session.

## Known Limitations and Deferred Work

- The tool is available only when the Host `assistantTasks` service is mounted.
- The tool does not expose task listing, cancellation, or status reads; the assistant surface owns those operations.
- A registered assistant that is not the global or project record cannot create tasks.

## Dev Note

The tool resolves `ctx.assistantTasks` in its mounting scope, passes the caller Session id to the Host service, and keeps provider and storage failures out of the model except through declared error codes.
