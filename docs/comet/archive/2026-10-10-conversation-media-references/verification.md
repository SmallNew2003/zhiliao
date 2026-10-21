---
generated_from_state_version: 10
---

# 验证

## 当前结果

- 结果: **已归档**
- 验证情况: **已完成检查，验证结果已确认**
- 目标周期: 1
- 迭代: 1
- 验证器尝试次数: 1
- 完成时间: 2026-10-10T08:32:08.972Z
- 摘要: 所有 5 项验收条件（A1-A5）均已通过测试验证，前端工作区相对路径图片解析和系统提示词嵌入指导运行正常

## 验收

| 编号 | 结果 | 来源 | 验收项 | 原因 |
| --- | --- | --- | --- | --- |
| A1 | passed | brief.md | Scenario: 前端根据 cwd 渲染工作区相对路径图片 - **WHEN** Agent 在回复中输出包含相对路径的图片（如 `![图表](charts/figure.png)` 或 `./figure.png`），且提供了有效的会话 `cwd` - **THEN** 前端将其解析为指向 `/api/file?path=...` 的绝对路径并在界面中渲染图片 | 已通过测试用例验证：在提供 cwd 时，相对路径图片正确解析为指向 /api/file?path=... 的绝对路径并在 AssistantMarkdown 中渲染 |
| A2 | passed | brief.md | Scenario: 缺失 cwd 时保持非绝对路径静态回退 - **WHEN** 未提供 `cwd` 且图片目标为相对路径 - **THEN** 前端不构造 `/api/file` 请求，保持安全降级 | 已通过测试用例验证：在缺失 cwd 时，相对路径图片保持静态回退，不构造 /api/file 请求 |
| A3 | passed | brief.md | Scenario: 系统提示词注入完整的文件与图片引用指引 - **WHEN** 挂载 `ui-deliverables` 插件并装配系统提示词 - **THEN** 生成的系统提示词中包含文件 Markdown 链接与图片 Markdown 嵌入语法的指导说明 | 已通过单元测试验证：ui-deliverables 的 FILE_REFERENCE_PROMPT 注入包含文件链接与图片嵌入说明 |
| A4 | passed | specs/conversation-media-references/spec.md | 解析并渲染相对路径图片 - **WHEN** Agent 输出 `![图表](charts/figure.png)` 且提供有效 `cwd` - **THEN** 前端构造指向 `/api/file?path=...` 的请求地址并在界面中渲染图片 | Spec 验收通过：Agent 输出 ![图表](charts/figure.png) 且提供有效 cwd 时前端正确构造 /api/file?path=... 请求 |
| A5 | passed | specs/conversation-media-references/spec.md | 提示词包含图片嵌入指引 - **WHEN** 挂载 `ui-deliverables` 插件并装配提示词 - **THEN** 提示词文本明确指示使用 `![alt](path)` 嵌入图片 | Spec 验收通过：挂载 ui-deliverables 插件时提示词明确指示使用 ![alt](path) 嵌入图片 |

## 检查

| 检查 | 命令 | 工作目录 | 状态 | 退出码 | 耗时 |
| --- | --- | --- | --- | ---: | ---: |
| vitest ui-chat path images | vitest run packages/client/ui-chat/tests/assistant-markdown-path-images.client.spec.tsx | . | passed | 0 | 5212 ms |
| vitest ui-deliverables prompt | vitest run packages/client/ui-deliverables/tests/prompt.host.spec.ts | . | passed | 0 | 3357 ms |

### Builder 报告的证据

以下为 Builder 报告，不等同于 Runtime 检查凭据或独立验收结果。

- pnpm vitest run packages/client/ui-chat/tests/assistant-markdown-path-images.client.spec.tsx: passed — 8 tests passed
- pnpm vitest run packages/client/ui-deliverables/tests/prompt.host.spec.ts: passed — 1 test passed, snapshots aligned

## 阻塞项

_无。_

## 风险与跳过的工作

_未报告风险。_

## 之前的迭代

| 目标周期 | 迭代 | 尝试 | 结果 | 未解决项 | 摘要 | 完成时间 |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | 1 | 1 | pass | — | 所有 5 项验收条件（A1-A5）均已通过测试验证，前端工作区相对路径图片解析和系统提示词嵌入指导运行正常 | 2026-10-10T08:32:08.972Z |



## 结论

所有 5 项验收条件（A1-A5）均已通过测试验证，前端工作区相对路径图片解析和系统提示词嵌入指导运行正常
