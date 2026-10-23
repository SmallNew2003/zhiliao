# 上游提案：MCP 工具的渐进式发现与加载

[English](upstream-discussion.md) | 中文

> 拟发布到 deepseek-ai/deepseek-harness 的 GitHub Discussion 草稿。分类选择 **Ideas**（若不存在 Ideas 则退回 **General** 或 **Q&A**）。发布需要已登录的浏览器会话；本地 SmallNew2003 的 `gh` token 当前已失效。

## 建议标题

MCP 工具定义在任务需要之前就进入主模型上下文——提案：渐进式发现与加载

## 正文

### 问题

DSH 连接多个 MCP server 时，每个工具的完整描述、参数 schema 与 PTC SDK 接口都会在第一次及之后每次请求进入主模型上下文，无论当前任务是否使用这些工具。随着 server 与工具不断累积，未使用的定义挤占工作上下文，工具选择噪声更大，完整载荷每轮还会重发一次。

### 提案

运行时保留完整 MCP 元数据，但只让任务所需的部分到达模型：

1. **有预算的发现目录。** 已连接 server 及其工具以紧凑目录（名称加简短描述）呈现，控制在可配置的 UTF-8 预算内。未选中的工具不发送完整定义。
2. **按需加载。** 主模型检索目录（按 server、名称或自由文本查询，带结果数量与字节上限），只加载它选中的工具。原生定义与 PTC SDK 接口由同一个呈现决策渲染，两种模式行为一致。执行继续走现有注册表、参数校验、审批、取消与结果记录管线。
3. **可选的辅助模型预选（默认关闭）。** 显式配置 provider/模型后，一次辅助调用只接收有界的近期任务上下文加简短目录——绝不包含完整参数 schema——所选工具已出现在第一次主请求中。不确定、"no MCP needed" 与失败分别记录，绝不回退到全量加载。
4. **显式指定。** 用户消息中的完整公开工具名在预算允许时直接加载，即使预选关闭或失败。点名 server 只缩小候选范围，不加载该 server 的完整工具集。
5. **按需的 server 指令与资源。** server 指令与需要它的工具原子加载；纯资源 server 通过目录激活。准入与硬预算原子绑定：超大的单项或累计提案整项拒绝，绝不截断成无效工具。
6. **请求绑定的正确性。** 工具调用按它自己请求所声明的定义执行；飞行途中同名定义变更返回 stale-definition 诊断，而不是执行新内容。选择是持久化会话事件，恢复、fork 与压缩精确重建模型所见。

一切模型可见内容都可从会话日志重建，包括辅助模型的实际输入、路由与选择结果。

**与 `deferLoading` 的关系。** `ToolSchema.deferLoading` 标记一个 schema，使 provider 可以稍后接收其定义。本提案回答该标记上游的互补问题：一个 scope 的模型究竟看到哪些定义，由目录加准入按 agent scope 决策，延迟标记随后随 wire 传递给确实加载的工具。两者组合，互不替代。

### 证据

我们在一个下游 fork 端到端实现，并在本地完成验证（全部免密钥）：

- 890 个定向行为测试、22 个免密钥 MCP 协议测试
- 更新 10 个录制会话快照，外加 TypeScript 与 Python SDK 预期输出
- hygiene、lint、typecheck、导出 JSDoc、工具/Cordis/依赖目录、文档图谱与双语配对门禁

第二个分支将同一功能移植到当前 master（dsh 0.2.1-rc.2），通过 539 个单元测试、22 个免密钥协议测试、干净的 typecheck 与 lint 以及文档门禁；那里唯一红着的门禁是录制的 MCP 快照——其 v3 时代 fixture 携带新会话事件，需要按当前格式重新录制——以及依赖 sandbox、在非特权环境中无法运行的快照。

诚实说明：未运行付费真实模型评估，召回率、成本与端到端时延均未测量；因缺少可执行文件，跳过了外部浏览器/computer 的实时 E2E。

### 参考实现

由于不接受外部 pull request，实现可在我们的公开 fork `SmallNew2003/zhiliao` 检视：

- 分支 `feat/mcp-progressive-loading`——0.1.6-alpha.2 时代的原始功能
- 分支 `port/mcp-progressive-loading-upstream`——同一功能 rebase 到当前 master，已解决上游 API 漂移（新增包 `packages/mcp/mcp-discovery`，外加 `core/tools`、`core/system-prompt` 与 agent-loop assemble 路径的小钩子）

### 征询

- 渐进式 MCP 工具加载是团队希望 DSH 发展的方向吗？
- 如果核心改动（工具呈现决策、assemble-context 输入、会话事件）是阻碍其作为 `dsh-plugin` 话题下的社区插件发布的瓶颈，你们会优先开放哪些扩展点？

我们乐意 rebase 到当前 master、将改动拆成可评审的块，并适配你们偏好的任何扩展点。
