# 目标

[English](brief.md) | 中文

将 Comet 作为可复用、可提交的协作工作流接入，使团队成员解析同一项目工作流，并由本地适配层约束写入操作。

# 范围

- 提交 Comet 项目配置、工作流适配层、客户端钩子配置和 Native 工作流文档根目录。
- 提交用于 DSH 的项目级 overlay；它挂载 `dsh-hooks-codex` 并复用 Comet 的 Codex 钩子定义。
- 扩展 `dsh-hooks-codex`：通过显式配置选择将原始工具参数提供给 Codex hook，使 Comet 能识别 DSH 的文件操作目标。
- 校验接入后的配置在本仓库可解析，且不改变未启用该配置的 DSH bridge 行为。

# 非目标

- 不修改 `dsh-hooks-codex` 以外的 DeepSeek Harness 运行时代码、包配置、测试行为或发布流程。
- 不实现业务功能，也不把当前 Native 变更的运行时状态作为团队共享配置提交。
- 不把 WorkBuddy 接入 DSH；它作为独立客户端使用相同的 Comet 路由器。

# 验收示例

- 在干净检出中执行 `comet workflow resolve . --activate --json` 时，返回本仓库保存的工作流选择及有效的 Comet 配置。
- 已纳入范围的客户端写入钩子调用仓库内的 Comet 路由器，不引用开发者机器上的绝对路径。
- DSH 通过项目 overlay 加载 `dsh-hooks-codex` 后，bridge 将原始工具参数提供给 Comet 路由器；非写入调用继续执行，Native Build 阶段允许实现写入，Shape 阶段拒绝实现写入，Verify 阶段写入使候选失效并返回 Build。
- 未启用工具参数传递的 DSH bridge 继续仅向 Codex hook 提供 `tool_input.command`。
- Git 仅跟踪项目级 Comet 配置、适配层、DSH overlay 和正式文档工件，忽略本机运行时状态。

# 约束与不变量

- 根目录 AGENTS.md、现有开发命令和 `dsh-hooks-codex` 之外的 DeepSeek Harness 运行时代码保持不变。
- 所有新建的可提交路径在其他开发者克隆仓库后仍有效。
- DSH 的适配只使用其已发布的 `dsh-hooks-codex` 插件和 Codex 的 `PreToolUse` 协议子集。
- 工具参数传递必须由 `dsh-hooks-codex` 的显式配置启用，默认行为保持兼容。

# 决策

- 当前仓库干净，未发现其他 Native 变更；本变更在 `master` 的当前目录中进行，不新建工作树。
- 保留 Native 与 Classic 两套 Comet 工作流，使团队可按任务选择相应流程。
- 提交 Codex 与 WorkBuddy 适配层；不提交 GitHub Copilot 和 Trae 适配层。
- DSH 通过 `dsh-hooks-codex` 复用 Codex 配置；WorkBuddy 不进入 DSH 运行时。
- 共享 Codex 配置匹配所有工具调用，由 Comet 路由器识别并约束写入操作，以兼容 DSH 与 Codex 的不同工具名。
- `dsh-hooks-codex` 新增默认关闭的工具参数传递配置；Comet overlay 显式开启它。
- Verify 阶段的实现写入遵循 Comet 的候选失效和修复行为，不走拒绝路径。

# 待解决问题

无。

# 验证预期

- 运行 Comet 的配置解析命令，并检查已提交配置中不存在机器特定的绝对项目路径。
- 载入 DSH overlay，确认 `dsh-hooks-codex` 可读取共享 Codex 配置，并以可重放的检查覆盖允许与拒绝的工具调用。
- 覆盖默认 bridge 的兼容 payload，以及 Comet overlay 开启参数传递后的 DSH 文件写入守卫。
