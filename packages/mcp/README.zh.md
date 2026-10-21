---
description: "MCP 包组：连接外部 Model Context Protocol 服务器，调用其工具并读取其资源。"
kind: "package-group"
---

# MCP — 模型上下文协议

[English](README.md) | 中文

## 概述

`mcp/` 组让模型按需加载外部 Model Context Protocol（MCP）工具并读取服务器资源。只需配置 `mcp-client` 条目；随附 profile 已挂载共享发现与资源服务。发现服务先提供有界目录，再将所选工具的完整定义与服务器指令加入模型请求。没有可见的已配置服务器时，不添加 MCP 工具或提示词文本。配置与限制由各包的 README 说明。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

客户端拥有每个已配置连接；发现服务管理面向模型的选择，资源服务提供共享列表与读取工具。

| 包 | 提供的能力 |
|---|---|
| [`mcp-discovery/`](mcp-discovery/README.zh.md) | 搜索并按需加载工具、激活资源服务器，管理请求预算与选择 |
| [`mcp-client/`](mcp-client/README.zh.md) | 连接一台 MCP 服务器，发现其工具与指令，并提供其资源操作 |
| [`mcp-resources/`](mcp-resources/README.zh.md) | 通过显式选择服务器的共享工具发现和读取资源 |

-----

<a id="related-documentation"></a>
## 相关文档

先用可运行的示例配置体验插件，再阅读 Agent Note 了解其背后的行为决策。

- [MCP 客户端插件 Agent Note](../../.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.zh.md)——桥接的设计：服务器限定命名、发现、执行与环境清洗。
- [资源与指令 Agent Note](../../.agents/notes/implemented/feature/2026-09-12-mcp-resources-and-instructions.zh.md)——按需资源访问与作用域服务器指引。
- [第三方记忆 MCP 指南](../../docs/user/guide/mcp-memory.zh.md)——可运行的 overlay 配置行与设置说明。
- [工具子系统参考](../../docs/subsystems/tools.zh.md)——接收已注册工具的 `ToolRuntime`。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
