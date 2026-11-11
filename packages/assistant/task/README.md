---
description: "Host-wide assistant records and assistant tasks with separated execution Sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-assistant-task

English | [中文](README.zh.md)

## Summary

`dsh-assistant-task` owns the durable records behind the personal assistant surface: one global assistant, one assistant per registered project, and the tasks each assistant creates. Assistant conversations and task execution Sessions are ordinary Sessions created through the Session controller; task ownership, status, and the separated Session ids live in this package's storage domain, never in Session headers. The model-facing creation and read tools live in the sibling `tool-task` package.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount the plugin in the Host composition beside the Session controller and Workspace registry:

```yaml
- name: '@deepseek-ai/dsh-assistant-task'
```

The service exposes `ensureAssistant`, `assistants`, `task`, `tasks`, `cancelTask`, and `visibility` over Typert Remote, and a Host-only `createTask` method used by the model tool. Configure the assistant and worker presets, per-turn and active task limits, prompt and title bounds, and the default list page size through the plugin's validated configuration. `visibility` reports every separated Session with its owning assistant or task, so a client can label the conversation and return to the right assistant. Task views carry `sessionAvailable`, and a repeated `createTask` reuses an existing task and execution Session when the caller supplies the same `requestId`, or when an identical creation partially failed in the same assistant turn.

Non-owner Remote callers need grants for each entity's Session and, for project entities, its Workspace; lists and visibility filter every returned entity. They may ensure an existing visible conversation, while creating or replacing an assistant conversation is owner-only. A failed Session metadata read propagates without replacing the durable conversation mapping.

Cancellation persists `cancelling`, refuses new worker steps, and drains the execution Agent and its managed descendants before recording `cancelled`. A failed drain keeps the task in `cancelling` with `cancel_failed`; retry cancellation to finish stopping it. The descendant admission cutoff applies to that exact live Agent.

Each result notice identifies the task and execution Session and includes the worker’s final text or a public failure explanation. `maxResultChars` limits that text to 2,048 UTF-16 units by default. Provider and transport diagnostics stay in the execution Session. A completed turn records the worker’s report. Verifying an external effect requires independent evidence.

<a id="model-experience"></a>
## Model Experience

Indirectly, through task tools that read the assistant’s own work and attributed `assistant-task` inbox notices delivered to the creating Session.

#### KV Cache effect

A terminal notice adds one ordinary inbox input to the creating conversation. Intermediate status writes do not append to its model history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Task execution Sessions are ordinary Sessions; a released client that does not mount the assistant surface can still list them.
- The global assistant may target any registered project; project assistants are confined to their own project.
- Recurring tasks remain on the existing Schedule surface and are not aggregated into the assistant task list.
- Task history is one execution Session per task. A retried partial creation reuses that record and Session; deliberately re-running a finished task is deferred.
- A task whose execution Session was never created reports `sessionAvailable: false`; its failure code survives restarts through reconciliation.

<a id="dev-note"></a>
### Dev Note

The `assistant` domain stores each notice and its stable message id with the terminal result. After restart the service compares outstanding deliveries with the creating Session’s inbox receipts, including already claimed inputs. At startup the service reads the first worker turn’s outcome from the resident or stored Session. A resident worker with no outcome keeps running. Pending notice delivery begins after the recovery scan succeeds. A Session read failure leaves the task record available for recovery and propagates the storage error. A missing receipt after an attempted admission leaves the outcome unknown and prevents a duplicate send. Older tasks without an identified creator remain readable and generate no historical notice.
