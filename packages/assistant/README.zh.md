# assistant/ — Host 全局的助理与助理任务

[English](README.md) | 中文

本包组拥有个人助理界面背后的持久记录：

- **task**（`@deepseek-ai/dsh-assistant-task`）——全局助理与每个项目助理的助理记录、助理任务记录、任务状态推导、取消，以及客户端使用分离 Session id。
- **tool-task**（`@deepseek-ai/dsh-tool-assistant-task`）——助理 preset 使用的面向模型的 `create_task` 工具。

助理会话与任务执行会话都是通过共享 Session 控制器创建的普通 Session。任务归属存放在 `storage-domain`，绝不写入 Session 头部，因此已发布的 Session 格式及其 `origin` 词汇保持不变。

Web 客户端界面位于 [`packages/client/ui-assistant`](../client/ui-assistant/README.zh.md)。
