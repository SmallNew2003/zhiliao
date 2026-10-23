---
description: "长期记忆能力族的包索引：memory 服务、hindsight HTTP provider，以及负责召回、回写与播种的会话生命周期接线。"
kind: "package-group"
---

# memory/ — 长期记忆能力族

[English](README.md) | 中文

## 摘要

`memory/` 这组包让 agent 对一个工作区拥有持久记忆：早先做过什么决策、遵循哪些约定、这个仓库大致是做什么的。会话开启时召回，轮次结束时回写，冷 bank 首次打开时用近期提交播种，因此第一个会话不会失忆。这一族与 web 族采用同一套拆分方式 —— 与后端无关的 seam、具体的 provider、面向模型的 consumer —— 所以换掉底层存储不需要动生命周期接线。

召回由 hindsight daemon 通过推理作答，因此 daemon 缓慢或缺席的代价只是一条警告和一个未被服务的轮次，永远不会让轮次失败：每个生命周期监听器都降级而不抛出。

## 目录

- [包](#packages)
- [记忆如何流转](#how-memory-flows)
- [相关文档](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`memory/`](memory/README.zh.md) | 记忆服务：bank 解析，以及通过可替换 provider 完成的召回、搜索与回写 | `ctx.memory` |
| [`hindsight-http/`](hindsight-http/README.zh.md) | 基于 hindsight HTTP daemon 的 provider；按工作区解析 bank | 注册到 `ctx.memory` |
| [`tool-memory/`](tool-memory/README.zh.md) | Consumer：开场召回、轮次回写、冷 bank 播种，以及 `hindsight_search` / `hindsight_remember` 工具 | 消费 `ctx.memory` |

<a id="how-memory-flows"></a>
## 记忆如何流转

1. **会话开启。** `tool-memory` 解析该工作区的 bank（`coding-agent::<checkout>`）；若 bank 是冷的，则用近期提交标题播种。两者都在后台进行，都不会拖慢第一句提示。
2. **首个请求。** `agent/pre-step` 针对开场提示召回记忆，并作为一条持久化的 user-role 消息追加，措辞明确标注为「可能已过时的背景知识」。
3. **轮次结束。** `agent/turn-stopping` 回写刚完成的对话；后端异步抽取事实。
4. **模型主动询问。** `hindsight_search` 查注入的记忆没覆盖到的内容；`hindsight_remember` 刻意记录一条值得保留的发现。

被委派的 subagent 会话不持有自己的 bank：它们继承父会话的工作区但工作集不同，折算进父会话的记忆会把两段对话搅在一起。

<a id="related-documentation"></a>
## 相关文档

- [Web client](../../docs/subsystems/web-client.zh.md) —— 记忆浏览面板如何挂载
- [Adding a package](../../docs/cookbook/adding-a-package.zh.md) —— 本组遵循的 seam/provider/consumer 拆分

<a id="dev-note"></a>
## Dev Note

本组不发布 `./invariant` 伴生包：它不持有任何可能与其他包的观察发生漂移的跨切面结论。seam 与 provider 针对脚本化的 daemon 验证，生命周期接线针对真实发出的 agent 事件验证。
