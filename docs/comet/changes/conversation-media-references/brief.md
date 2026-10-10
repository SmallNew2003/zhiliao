# 目标

支持 Agent 在会话回复过程中引用图片与文件，确保模型输出的 Markdown 链接和图片在前端客户端能够被正确解析，实现代码文件直接跳转与本地/工作区图片内嵌渲染。

# 范围

1. 前端图片渲染增强：
   - 升级 `packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx` 中的 `localPathMediaUrl`，接入会话工作区 `cwd`，支持解析工作区相对路径图片。
   - 在 `packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx` 中向 `AssistantMarkdown` 传递 `cwd`。
2. 系统提示词引用规范：
   - 更新 `packages/client/ui-deliverables/src/index.ts` 中的 `FILE_REFERENCE_PROMPT`，增加对图片使用 Markdown 图片语法 `![alt](path)` 的明确指引。
3. 测试与快照：
   - 补充 `packages/client/ui-chat/tests/assistant-markdown-path-images.client.spec.tsx` 针对 `cwd` 相对路径解析的测试。
   - 同步 `packages/client/ui-deliverables/tests/prompt.host.spec.ts` 及 `snapshots/web/*` 预期快照。

# 非目标

1. 实现音视频独立播放器卡片节点。
2. 调整后端 `/api/file` 的底层权限校验逻辑或支持非 HTTP 传输（如 Electron `file://`）。

# 验收示例

- Scenario: 前端根据 cwd 渲染工作区相对路径图片
  - **WHEN** Agent 在回复中输出包含相对路径的图片（如 `![图表](charts/figure.png)` 或 `./figure.png`），且提供了有效的会话 `cwd`
  - **THEN** 前端将其解析为指向 `/api/file?path=...` 的绝对路径并在界面中渲染图片

- Scenario: 缺失 cwd 时保持非绝对路径静态回退
  - **WHEN** 未提供 `cwd` 且图片目标为相对路径
  - **THEN** 前端不构造 `/api/file` 请求，保持安全降级

- Scenario: 系统提示词注入完整的文件与图片引用指引
  - **WHEN** 挂载 `ui-deliverables` 插件并装配系统提示词
  - **THEN** 生成的系统提示词中包含文件 Markdown 链接与图片 Markdown 嵌入语法的指导说明

# 约束与不变量

1. 保持对非 HTTP 页面传输（如 Electron `file://`）和协议相对链接的安全忽略。
2. 严格遵循 TypeScript `strict: true` 与 ESM 模块规范。

# 决策

- 决策 1: 采用方案 A（完整闭环），结合前端相对路径解析增强与系统提示词指引，确保模型输出与前端渲染行为一致。

# 待解决问题

无。

# 验证预期

1. `pnpm vitest run packages/client/ui-chat/tests/assistant-markdown-path-images.client.spec.tsx` 测试通过。
2. `pnpm vitest run packages/client/ui-deliverables/tests/prompt.host.spec.ts` 测试通过。
3. 相关包通过 `tsc -b` 类型检查。
