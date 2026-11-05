# assistant/ — Host-owned assistants and assistant tasks

English | [中文](README.zh.md)

This package group owns the durable records behind the personal assistant surface:

- **task** (`@deepseek-ai/dsh-assistant-task`) — assistant records for the global assistant and each project assistant, assistant task records, task status derivation, cancellation, and the separated Session ids consumed by the client.
- **tool-task** (`@deepseek-ai/dsh-tool-assistant-task`) — the model-facing `create_task` tool used by the assistant preset.

Assistant conversations and task execution Sessions are ordinary Sessions created through the shared Session controller. Task ownership lives in `storage-domain`, never in Session headers, so the released Session format and its `origin` vocabulary stay unchanged.

The Web client surface lives in [`packages/client/ui-assistant`](../client/ui-assistant/README.md).
