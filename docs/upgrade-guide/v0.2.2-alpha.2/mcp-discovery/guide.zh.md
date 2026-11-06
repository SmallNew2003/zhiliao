---
kind: upgrade-guide
description: "MCP 模型工具与资源需要显式发现和激活。"
---

# 先发现 MCP 能力再调用

[English](guide.md) | 中文

## 变更

默认 profile 暴露 `discover_mcp_tools`，不再暴露所有已连接的 MCP 工具。Agent 的资源请求要求目标服务器已激活。曾经可见的工具可能需要先通过发现准入当前定义；服务器说明或定义变化会使选择失效。没有 Agent 的程序化资源请求仍免于激活要求。

## 迁移

1. 挂载 `dsh-mcp-client` 且需要渐进发现的自定义组合必须同时挂载 `dsh-mcp-discovery`，并在 profile resolver 依赖中保留这两个包。
2. 更新工具调用指令，先用 `discover_mcp_tools` 搜索并加载准确的工具名，或激活资源服务器，再发起调用。发现结果从下一次模型请求生效。
3. 遇到 `MCP_SERVER_INACTIVE` 时激活指定服务器再重试；遇到 `MCP_STALE_DEFINITION` 时重新发现并加载当前定义。
4. 确认下一次请求包含选中工具的 schema，资源访问只在激活后成功。回放行为见 [MCP 参考](../../../subsystems/mcp.zh.md)和[持久化确认记录](../../../persistence-changes/2026-11-07-local-testbed-integration.zh.md)。
