---
description: "The assistant package group: persistent assistant conversations, independent task records, and the model-facing task creation tool."
kind: "package-group"
---

# assistant/ — Host-owned assistants and assistant tasks

English | [中文](README.zh.md)

## Summary

The `assistant/` packages provide persistent global and project assistant conversations with independent tasks. The task service owns durable identities and status; the tool lets a registered assistant create work through the shared Session controller. Assistant ownership lives outside Session headers. The [client surface](../client/ui-assistant/README.md) presents these records and separates their Sessions from ordinary navigation.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The service and model-facing tool have separate owners.

| Package | Role |
|---|---|
| [`task`](task/README.md) | Durable assistant and task records, status, cancellation, and Session visibility feed |
| [`tool-task`](tool-task/README.md) | Assistant-only `create_task` tool and its model guidance |

<a id="related-documentation"></a>
## Related documentation

- [Assistant subsystem](../../docs/subsystems/assistant.md) — identities, requests, failures, and Session visibility.
- [Session subsystem](../../docs/subsystems/session.md) — ordinary conversation and execution Sessions.

<a id="dev-note"></a>
## Dev Note

None.
