# Comet 工作流接入

[English](spec.md) | 中文

## 双工作流配置

仓库必须将 Native 和 Classic 同时列为可用的 Comet 工作流，且项目本地的默认工作流选择必须可由 Comet CLI 解析。

### Scenario: 解析已提交的项目工作流

- **WHEN** 开发者在仓库根目录执行 Comet 工作流解析命令
- **THEN** 命令返回项目保存的有效配置
- **AND** 返回的可用工作流包含 Native 和 Classic

## 客户端写入适配

仓库必须提供 Codex 与 WorkBuddy 的 Comet 写入钩子。每个钩子必须执行仓库内的 Comet 路由器，不得依赖开发者机器上的绝对路径。GitHub Copilot 和 Trae 适配层不属于该项目的已提交配置。

### Scenario: 客户端调用可移植路由器

- **WHEN** Codex 或 WorkBuddy 在仓库检出中调用已提交的写入钩子
- **THEN** 钩子调用仓库内可解析的 Comet 路由器
- **AND** 该调用不包含特定开发者的绝对项目路径

## DSH 钩子适配

仓库必须提供一个显式启用的 DSH overlay。该 overlay 挂载 `dsh-hooks-codex` 并引用共享的 Codex 钩子配置，使 DSH 在 `PreToolUse` 时调用 Comet 路由器。overlay 必须显式开启 bridge 的原始工具参数传递，使路由器能够识别 DSH 文件操作目标。共享配置必须匹配每个 DSH 工具调用；路由器自行放行非写入调用，在 Native Build 阶段允许实现写入，在 Shape 阶段拒绝实现写入，并在 Verify 阶段使写入候选失效并返回 Build。

### Scenario: DSH 复用 Comet 写入约束

- **WHEN** DSH 使用项目的 Comet overlay 运行工具调用
- **THEN** `dsh-hooks-codex` 在 `PreToolUse` 时调用 Comet 路由器
- **AND** bridge 将工具参数传递给路由器以识别文件操作目标
- **AND** 非写入调用继续执行
- **AND** Native Build 阶段的实现写入继续执行
- **AND** Native Shape 阶段的实现写入被拒绝
- **AND** Native Verify 阶段的实现写入使候选失效并返回 Build

## DSH bridge 参数兼容性

`dsh-hooks-codex` 必须将完整工具参数传递定义为默认关闭的配置选项。未启用时，bridge 必须继续提供仅含 `command` 的 Codex `tool_input`；启用时，bridge 必须保留原始工具参数，并保持 `command` 为字符串。

### Scenario: 未启用参数传递时保留现有 payload

- **WHEN** `dsh-hooks-codex` 未启用工具参数传递
- **THEN** 每个 Codex tool payload 的 `tool_input` 仅包含字符串 `command`

### Scenario: Comet overlay 启用参数传递

- **WHEN** DSH 使用 Comet overlay 调用带文件路径的工具
- **THEN** Codex hook payload 保留该文件路径
- **AND** `tool_input.command` 仍为字符串

## 可提交状态

仓库必须跟踪项目级 Comet 配置、所选客户端适配层、DSH overlay 与正式变更工件，并忽略 Comet 的机器本地运行时状态。

### Scenario: 干净检出不含本机状态

- **WHEN** 开发者在另一台机器检出该仓库
- **THEN** 所有已跟踪的 Comet 配置和适配文件可用
- **AND** 本机运行时状态不在 Git 跟踪中
