---
description: "Host-wide assistant records and assistant tasks with separated execution Sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-assistant-task

English | [中文](README.zh.md)

## Summary

`dsh-assistant-task` owns the durable records behind the personal assistant surface: one global assistant, one assistant per registered project, and the tasks each assistant creates. Assistant conversations and task execution Sessions are ordinary Sessions created through the Session controller; task ownership, status, and the separated Session ids live in this package's storage domain, never in Session headers. The model-facing `create_task` tool lives in the sibling `tool-task` package.

## Use this package

Mount the plugin in the Host composition beside the Session controller and Workspace registry:

```yaml
- name: '@deepseek-ai/dsh-assistant-task'
```

The service exposes `ensureAssistant`, `assistants`, `tasks`, `cancelTask`, and `visibility` over Typert Remote, and a Host-only `createTask` method used by the model tool. Configure the assistant and worker presets, per-turn and active task limits, prompt and title bounds, and the default list page size through the plugin's validated configuration. `visibility` reports every separated Session with its owning assistant or task, so a client can label the conversation and return to the right assistant. Task views carry `sessionAvailable`, and a repeated `createTask` reuses an existing task and execution Session when the caller supplies the same `requestId`, or when an identical creation partially failed in the same assistant turn.

## Model Experience

The service adds no model-visible input by itself. `create_task` is registered by `@deepseek-ai/dsh-tool-assistant-task`; it creates an independent task Session and returns the task and Session identities. Task status is derived from durable Session facts and pushed to clients; it is not injected into the assistant conversation.

## Known Limitations and Deferred Work

- Task execution Sessions are ordinary Sessions; a released client that does not mount the assistant surface can still list them.
- The global assistant may target any registered project; project assistants are confined to their own project.
- Recurring tasks remain on the existing Schedule surface and are not aggregated into the assistant task list.
- Task history is one execution Session per task. A retried partial creation reuses that record and Session; deliberately re-running a finished task is deferred.
- A task whose execution Session was never created reports `sessionAvailable: false`; its failure code survives restarts through reconciliation.

## Dev Note

The package opens the `assistant` storage domain with `assistants` and `tasks` tables plus the global assistant identity. It serializes writes through one chain, reconciles interrupted tasks on startup, and never writes a Session-format marker.
