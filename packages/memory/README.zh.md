---
description: "长期记忆能力族的包索引：memory 服务、hindsight HTTP provider，以及负责召回、回写与播种的会话生命周期接线。"
kind: "package-group"
---

# memory/ — 长期记忆能力族

[English](README.md) | 中文

## 摘要

`memory/` 包组让 agent（智能体）召回工作区决策，并保留有用的对话上下文。记忆服务选择提供方；Hindsight 适配器将其连接到 HTTP daemon。独立的消费方拥有生命周期补充与面向模型的工具。提供方失败保持显式，生命周期补充则可降级而不使用户轮次失败。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## 包

服务、提供方与生命周期消费方可以独立组合。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`memory/`](memory/README.zh.md) | 记忆服务：bank 解析，以及通过可替换 provider 完成的召回、搜索与回写 | `ctx.memory` |
| [`hindsight-http/`](hindsight-http/README.zh.md) | 基于 hindsight HTTP daemon 的 provider；按工作区解析 bank | 注册到 `ctx.memory` |
| [`tool-memory/`](tool-memory/README.zh.md) | Consumer：开场召回、轮次回写、冷 bank 播种，以及 `hindsight_search` / `hindsight_remember` 工具 | 消费 `ctx.memory` |

<a id="related-documentation"></a>
## 相关文档

- [记忆子系统](../../docs/subsystems/memory.zh.md) — 记忆库标识、提供方操作与浏览器值。
- [Web client](../../docs/subsystems/web-client.zh.md) —— 记忆浏览面板如何挂载
- [Adding a package](../../docs/cookbook/adding-a-package.zh.md) —— 本组遵循的 seam/provider/consumer 拆分

<a id="dev-note"></a>
## Dev Note

无。
