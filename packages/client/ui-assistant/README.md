---
description: "Assistant surface: global and project assistants with separated task lists."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-assistant

English | [中文](README.zh.md)

## Summary

Choose the global assistant or a project assistant in the Web or Desktop sidebar. The conversation stays beside the task list on wide panels and above it on narrow panels. Tasks are grouped into needs attention, active, and finished. Open a task to review its execution Session, or return from the Session header to its owning assistant.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount the plugin in the web bundle after the Host assistant task service and the API Remote assembly:

```yaml
- id: ui-assistant
  name: '@deepseek-ai/dsh-client-ui-assistant'
```

The global list includes all authorized tasks. Selecting a project limits the list to that project. Load earlier tasks to extend the history. A task’s creation card follows its current status and displays the worker’s result summary when available. Cancellation remains pending until execution stops. If stopping fails, retry cancellation from the task.

The entry appears only while the Host assistant service is readable. An owner selecting a project for the first time creates that project assistant through the Host service; non-owner callers can open only an existing authorized assistant.

<a id="model-experience"></a>
## Model Experience

None, as the client renders Host assistant records and tool results without adding model input.

#### KV Cache effect

Navigation, task cards, and status updates do not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Separation is a client rendering seam; clients without this plugin can still list assistant task Sessions.
- Scheduled tasks remain on the existing Automation page and are not aggregated here.
- A task can be opened only when its execution Session is available.
- The assistant page does not restore the exact user conversation that was open before a task.

<a id="dev-note"></a>
### Dev Note

The plugin registers its surfaces and hidden-Session source under `remoteAccess.whenAccess('assistantTasks/assistants', ...)`. The panel retains the selected Session and renders `conversation.embedded` in its scope. Task cards read `assistantTasks/task` and refresh on their own task’s change events. A temporary read failure preserves the open conversation, task history, and previously read task details. If the Host denies access or reports a missing task, the card withdraws its details. The ordinary workspace list hides each newly discovered Session until an ownership check covering that Session succeeds. Sessions arriving during a check trigger a follow-up check together. If a check fails, previously confirmed ordinary Sessions stay visible. The workspace Session list and the assistant task panel both offer a retry. Switching projects discards the previous project’s pending selection and reads.
