# 个人助理持续跟进实施计划

[English](assistant-experience_20261111.md) | 中文

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 让现有助理支持交代工作、跟进进度与接收结果，并修复取消与失败恢复。

**Architecture:** 保持一个共享助理任务域与普通执行 Session。在助理页内通过已注册 factory 复用 Conversation，让任务导航与进度保持可见。从持久执行事实推导进度与有界结果摘要，提供带作用域的模型读取，并通过既有持久 inbox 交付有明确归属的完成通知。

**Tech stack:** TypeScript、Cordis、React、CSS Modules、Typert Remote、Vitest、既有 dsh Web profile 与录制会话测试框架。

**Spec:** 用户已认可本聊天中的实现审查并要求智能体执行；下列验收要求构成本次工作规格。独立的多 bot/thread 提案不属于本轮实现范围。

## 全局约束

- 只在 `/Users/jelvin/.codex/worktrees/assistant-experience/zhiliao` 的 `codex/assistant-experience-20261111` 分支工作，基于 `codex/local-testbed-integration-20261106`。不修改 master、现有 worktree 或已安装应用，不发布。
- 保留全局与项目助理作用域、正常执行审批、普通用户 Session 导航，以及 Schedule 的独立领域与 Automation 视图。不新增 IM/thread/supervisor 包。
- 阅读适用的 AGENTS.md、架构、防御模式、错误处理、文字、生命周期与测试可靠性技能。通过 `/Users/jelvin/.nvm/versions/node/v24.19.0/bin` 使用 Node v24.19.0。
- 保留既有任务记录。可选持久字段新增仍须兼容解码并完成声明类型评审；外部可见 API 变更附升级指南。不新增 unknown 断言。
- 使用所有受支持语言的 typed locale 字典、既有共享控件与语义 token、Conversation/SessionProvider 组合及 effect 作用域注册。不复制聊天渲染器，不绕过模型或审批限制。
- 新 worktree 实现前，四个助理聚焦文件共 24 项测试通过。修复前先写有意义且失败的回归测试。默认不跑全仓测试套件。
- 智能体共享 worktree，但各自拥有互不重叠的文件。不暂存、提交、切分支，不运行会改写其他所有者文件的生成器／构建，也不派生智能体。源代码稳定后由主智能体串行生成、验证并安排评审。

## 验收要求

- 打开助理即可使用带作用域的对话及可访问的任务面板，无需离开页面就能向所选助理发送消息。390 CSS px 下两部分仍可访问，无重叠或全页横向滚动。
- 新建全局助理无需所属 Workspace 即可输入。普通空白用户 Session 保持 Workspace 前置条件，模型可用性与审批继续生效。
- 模型通过 `list_tasks` 与 `get_task` 读取限定范围内的进度与结果。完成或失败向真正的创建助理 Session 产生有明确归属、持久去重的通知；不冒充人类指令，也不把未知结果表示为成功。
- 任务摘要受经过校验的配置限制，保留结果归属，跨重启存活，并出现在列表／详情读取中。没有新字段的旧记录仍能加载。
- 取消立即阻止新工作，执行排空期间可见地显示 cancelling；只有静止后才提交 cancelled。不得持有结算所需写队列再等待 worker 结算。
- 任务卡片订阅当前状态。列表提供活动／待处理／已完成视图，并支持读取 Host 默认 50 条之外的历史；暂时失败保留数据，取消失败与加载失败使用不同报告。
- 快速切换项目不会打开或向错误助理提交。并发刷新与插件释放不得发布过期状态；visibility 暂时失败不得暴露隐藏会话。
- 增加聚焦服务与渲染组件回归、真实组装 Web 交互用例，以及新模型工具／通知的录制会话覆盖。GIF 来自真实服务与模型流程，不用静态 mock 替代行为证据。

### Task 1: 持久任务跟进与生命周期

**Files:** 拥有 `packages/assistant/task/**`、`packages/assistant/tool-task/**`、`packages/bundle/web-app/presets/assistant.patch.yml`、这些包的文档，以及新增且范围明确的任务域持久化／升级／决策记录。不修改 `packages/client/**` 或共享生成产物。

**Consumes:** 既有任务创建、执行 Session 事件、带作用域工具注册与普通持久 inbox API。

**Produces:** `AssistantTaskStatus` 增加 `cancelling`；`AssistantTaskView` 增加可选 `resultSummary?: string`；`assistantTasks/task` 接收 `{ id: AssistantTaskId }` 并返回已授权的 `AssistantTaskView`；既有 `tasks({ assistantId?, workspaceId?, limit?, offset? })` 保持可用。在 `create_task` 旁增加仅对登记助理开放的 `list_tasks` 与 `get_task`。任何无法避免的接口调整，在消费方实现前先协调。

- [x] 为取消排空／死锁及失败、旧记录持久化、越权查询、有界摘要持久化、完成归属／去重／重启和中断／未知结果编写回归。使用 deferred promise 与显式事件屏障，不使用时长等待。
- [x] 运行受影响的服务／工具文件并记录预期失败断言。通过当前扩展点加入最小生命周期、读取、摘要投影与持久通知实现，不修改 agent-loop。
- [x] 代表性取消断言：假 Agent 的 `whenIdle()` 尚未完成时，`expect(service.getTask(taskId)?.status).toBe('cancelling')`；使其完成并等待取消后，再断言 cancelled。通知重试须保持同一通知身份，重启后 inbox 仅有一份输入。
- [x] 重跑聚焦测试，更新双语所有者文档与兼容记录，检查差异，报告精确命令／结果、接口、限制与文件。保留未暂存改动供主智能体评审。

### Task 2: 助理工作页面、实时卡片与客户端恢复

**Files:** 仅拥有 `packages/client/ui-assistant/**`，包括渲染组件测试、manifest 与双语文档。不修改 Conversation 内部或 Host 源码。

**Consumes:** Task 1 的可选摘要、cancelling 状态及单任务读取；Task 3 的 `conversation.embedded` factory。既有任务列表通过 offset 提供 Host 默认大小的分页，不得静默限制为第一页。

**Produces:** 全局／项目选择、页内对话、相邻任务面板、实时状态／结果卡片、历史加载与逐操作错误／重试状态。暂时失败保留选择状态及已有任务／visibility 数据。

- [x] 为当前空管理页编写失败渲染测试：不离开面板就渲染助理对话；当前任务状态替代仅创建时标签；取消错误保留任务行；后续历史页可访问；过期项目响应不能改变当前助理；visibility 失败保留隐藏 id。
- [x] 使用框架 SessionProvider 绑定所选助理的 Session reference 与助理拥有的 session 作用域子 slot；由该子 slot 渲染 `conversation.embedded`。不向 `renderFactorySlot` 直接传 Session id，也不导入其他插件的具体组件。
- [x] 使用共享 Button/Menu/EmptyState/loading 模式和语义 CSS token。空状态提供有效说明及明确开始动作；状态分组展示待处理工作与完成结果。窄屏可访问两个区域，不丢输入或主要动作。英文 sentence case，更新所有 locale 键。
- [x] 卡片由 Host 状态与单任务查询驱动，提供摘要访问和明确的打开／取消动作。历史分页与项目选择限定作用域并使用代际检查；暂时读取失败不能用空数组替换保留数据。
- [x] 运行聚焦渲染与插件测试；主智能体服务可用后检查响应式／明暗主题，更新所属文档，报告证据及缺少的扩展点。保留未暂存改动供主智能体评审。

### Task 3: 可复用嵌入式 Conversation 与真实流程验证

**Files:** 拥有 `packages/client/ui-conversation/**`，以及 `apps/web/tests` 和 `snapshots` 下的助理专属 Web／录制会话 fixture 与测试。不修改 ui-assistant 或 Host 任务文件；共享生成产物和整体构建由主智能体串行执行。

**Consumes:** 既有 `conversation.content`、SessionProvider 作用域、Session 投影、真实 dsh profile 测试设施，以及随后就绪的 Host／UI 功能。

**Produces:** 注册 session 作用域的 `conversation.embedded` factory，输入 `{ workspaceMode?: 'required' | 'optional' }`；计算既有 Conversation phase，并以嵌入布局渲染共享内容。必要时为既有内容输入增加相同的可选策略。默认 required；助理使用 optional，但不削弱 Host 鉴权、模型选择或普通 Workspace 会话行为。

- [x] 增加渲染回归：明确选择 optional 的嵌入区域中，无归组全局助理可以输入；普通主区域空 Session 仍要求 Workspace。覆盖正常输入控件、等待模型选择、焦点与释放。
- [x] 实现可复用 factory 及最小的带作用域 Workspace 策略改动。复用既有 phase 逻辑和公开声明，为新支持的 factory 输入提供 JSDoc 与双语文档。
- [x] 增加确定性的组装 Web 用例，覆盖助理选择、页内对话、任务创建／状态／结果卡片与保留导航。为模型可见 `list_tasks`／`get_task` 和完成通知增加真实录制会话场景；沿用既有 fixture／录制约定，不伪造期望日志或无效断言。
- [x] Task 1／Task 2 源码就绪时进行协调。运行聚焦组件／fixture 检查，明确需要构建产物或真实提供方的命令，由主智能体统一执行一次。主智能体拥有真实服务 GIF 录制及最终集成验证。
- [x] 报告精确覆盖与剩余环境约束。保留未暂存改动供主智能体评审。

## 主智能体验证与评审

每项任务完成后保存限定路径的 diff 与实现报告，安排独立规格／质量评审，处理重要问题后再集成。全部编辑稳定后，统一串行生成 Typert／catalog／持久化产物，运行有关聚焦测试、build:artifacts 后的 build:check（或该分支等价命令）、文档门禁、lint 与 diff 检查。浏览器／GIF 证据使用真实实现的服务与模型流程；明确报告不可用的真实提供方检查。交付前完成一次独立全分支评审及必要修复／复审。保留 worktree 供用户审阅，不合并、不发布、不替换安装应用。
