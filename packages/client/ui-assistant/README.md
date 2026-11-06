---
description: "Assistant surface: global and project assistants with separated task lists."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-assistant

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-assistant` adds one assistant entry to the Web and Desktop sidebar and one main panel. The panel selects the global assistant or a project assistant, opens that assistant's conversation, shows its task list, opens task execution Sessions, and cancels active tasks. The plugin also registers a conversation card for `create_task`, a Session-header marker with a return action for assistant conversations and task Sessions, and a client separation source so assistant Sessions stay out of ordinary user Workspace groups, the ungrouped bucket, and search while remaining reachable from the assistant surface.

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

The entry appears only while the Host assistant service is readable. An owner selecting a project for the first time creates that project assistant through the Host service; non-owner callers can open only an existing authorized assistant.

<a id="model-experience"></a>
## Model Experience

None, as the client renders Host assistant records and tool results without adding model input.

#### KV Cache effect

Navigation, task cards, and status updates do not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Separation is a client rendering seam; clients without this plugin can still list assistant task Sessions.
- The global task list is bounded by the Host page size; older tasks are not paginated in the first release.
- Scheduled tasks remain on the existing Automation page and are not aggregated here.
- Task rows without a usable execution Session show the failed state and offer no open action.
- The assistant page does not restore the exact user conversation that was open before a task.

<a id="dev-note"></a>
### Dev Note

The plugin registers its main panel, sidebar row, task card, and hidden-Session source inside `remoteAccess.whenAccess('assistantTasks/assistants', ...)`, so no surface appears without read access. The hidden source reads the Host-provided visibility snapshot, which also names each assistant conversation and task execution Session; the header action uses those roles to mark the Session and return to its owning assistant. Both registrations are disposed with the plugin.
