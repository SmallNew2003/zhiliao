---
description: "Model-facing create_task tool over the Host assistant task service."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-assistant-task

English | [中文](README.zh.md)

## Summary

`dsh-tool-assistant-task` registers the `create_task` model tool in the scope that resolves the Host `ctx.assistantTasks` service. The assistant preset mounts it; a step-time condition keeps it invisible to assistant-preset Sessions that are not registered assistants. A call creates an independent root Session through the Session controller and returns the task and Session identities.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Add the row to the assistant preset's plugin list:

```yaml
- id: tool-assistant-task
  name: '@deepseek-ai/dsh-tool-assistant-task'
```

A global assistant may name a registered project; a project assistant is confined to its own project. The tool description and `tool:create_task` guidance tell the model to create tasks only at the user's explicit request and not to claim a task finished before its status says so.

Guidance and tool declarations use the same step admission. An ordinary Session receives neither the tool schema nor its assistant guidance and project catalog.

<a id="model-experience"></a>
## Model Experience

### Task creation tool

#### What the model sees

The tool input is `prompt`, optional `title`, optional `workspaceId`, and optional `requestId`. Its result is either `{ taskId, sessionId }` or a structured error code; a failure after the task record exists also carries `taskId` and, when created, `sessionId` so the caller can open or retry it. Reusing the same `requestId` reuses the existing task and execution Session and never delivers the first prompt twice. The tool exposes no worker preset choice; execution uses the Host-configured worker preset. A task runs with the normal tool approval and permission policy of its execution Session.

#### Token effect

Admitted assistant steps include the tool schema and guidance, including the registered project directory when present. Results add task identities or structured failure details; the worker's transcript stays in its own Session.

#### KV Cache effect

The schema and guidance remain stable while the admitted tool and project directory are unchanged. Task results append ordinary tool history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The tool is available only when the Host `assistantTasks` service is mounted and the calling Session is a registered assistant. Step-time activation excludes other Sessions from both model declarations and execution.
- The tool does not expose task listing, cancellation, or status reads; the assistant surface owns those operations.
- A registered assistant that is not the global or project record cannot create tasks.

<a id="dev-note"></a>
### Dev Note

The tool resolves `ctx.assistantTasks` in its mounting scope, passes the caller Session id to the Host service, and keeps provider and storage failures out of the model except through declared error codes.
