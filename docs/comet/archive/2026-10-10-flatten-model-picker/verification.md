---
generated_from_state_version: 12
---

# 验证

## 当前结果

- 结果: **已归档**
- 验证情况: **已完成检查，验证结果已确认**
- 目标周期: 2
- 迭代: 1
- 验证器尝试次数: 1
- 完成时间: 2026-10-10T04:44:29.401Z
- 摘要: 独立只读验收通过，A1–A7 均满足。核对完整 brief/spec、实现差异、候选绑定 Runtime 回执、布局与交互截图及真实 Session 后，未发现本次单层模型选择范围内的阻断缺陷；无需补充 Runtime 检查。保留既有全仓文档失败和截图串联 GIF 的限制；最终用户接受、归档与任何 Git 交付仍由主流程处理。

## 验收

| 编号 | 结果 | 来源 | 验收项 | 原因 |
| --- | --- | --- | --- | --- |
| A1 | passed | brief.md | In a session that permits model selection, one click opens provider-grouped models and marks the current model without an intermediate Model submenu. | ModelSelect 直接渲染目录顺序的 provider group 与 menuitemradio，不存在中间 Model 子菜单；当前模型的 aria-checked 和勾选标记由共享目录 current 派生。组件测试、两份更新的 ARIA 快照及实际页面截图相符。 |
| A2 | passed | brief.md | When the current model supports reasoning, the same panel shows exactly its provider-declared efforts and current value. Models without reasoning omit this section; arbitrary efforts are not introduced and provider default semantics remain intact. | 同一面板下方仅从当前模型 reasoning.efforts 构造选项；无 reasoning 元数据时省略等级区，未配置 defaultEffort 时保留 Default。组件测试覆盖有默认值、无默认值和缺失目录项；declared-reasoning 浏览器回归验证仅提供声明等级并持久化 high。 |
| A3 | passed | brief.md | Successful model or effort selection updates the trigger from the Host-confirmed result, closes the panel, and restores trigger focus. Selecting the current value closes without another write. Existing persistence scope and subsequent-request semantics remain unchanged. | 模型与等级选择继续调用原 ModelDirectory/Host API，current 仍读取持久化投影而非乐观改写；成功后关闭并恢复触发器焦点，选中当前值直接关闭且不写入。组件测试覆盖上述关闭/焦点/无重复写入，default-model 浏览器回归保留后续会话默认值与已有日志会话的独立语义；实际 Session 记录模型/等级变更及后续请求配置。 |
| A4 | passed | brief.md | Arrow keys move among actionable options; Enter, Space, or the existing Tab gesture selects. Escape or Shift+Tab closes in one step and restores trigger focus; outside clicks also close. A pending selection prevents duplicate submissions. | 方向键遍历并环绕未禁用选项，Tab 激活当前按钮，Escape 与 Shift+Tab 单步关闭并恢复焦点；Enter/Space 保留原生 button 激活语义。组件测试覆盖焦点遍历、Tab、两种关闭、真正外部点击及 selecting 禁用；浏览器回归验证跨模型/等级导航与关闭焦点。 |
| A5 | passed | brief.md | Loading, retryable catalog errors, partial provider failures, empty lists, and rejected selections have explicit feedback. Rejected selections retain the original value and remain retryable. | 加载、目录错误 Retry、部分 provider 失败和空列表直接在面板显示；选择失败使用既有 Toast，原目录 current 不因失败改写，selecting 结束后可重新选择。组件与 catalog 测试覆盖对应反馈、保留旧目录、失败重试及 writer-held 指引；未引入目录缺失即不可路由的判断。 |
| A6 | passed | brief.md | In Chinese and English, light and dark themes, desktop and 390px viewports, the panel stays within the viewport; long names and many options remain readable or scrollable, and the effort section is visually distinct from the model list. | Runtime 的 declared-reasoning 回归实际执行中/英 × 明/暗 × 1280/390px 八组长名称与17项模型布局，断言四边在视口内、无横向溢出且最末等级可滚动到达。独立目视检查中文明色、英文深色及390px深色截图，等级标题与分隔线清晰，模型名称受限宽度显示。 |
| A7 | passed | brief.md | Provide the current worktree’s real Web UI and a date-stamped interaction GIF showing the list, model selection, and effort selection when supported. Update and validate relevant component tests, browser regressions, and owner-local snapshots, and complete independent read-only acceptance. | 核对当前 worktree、HEAD、TSX/CSS 与日期戳 GIF 的 SHA256 均匹配证据记录；目视检查模型列表、切换模型、切换等级及真实回复截图。隔离 Session 中存在 model/selection、实际 request/header（deepseek-flash/off）、目标 assistant/message 与 completed 回合。候选绑定 Runtime 回执证实3文件40组件/目录测试、7文件33浏览器测试、Host/Client类型检查、lint、3双语配对和空白检查通过；两份 owner-local ARIA 快照已更新。本报告完成独立只读逐项验收。 |

## 检查

| 检查 | 命令 | 工作目录 | 状态 | 退出码 | 耗时 |
| --- | --- | --- | --- | ---: | ---: |
| model-unit | exec vitest run packages/client/ui-model-selection/tests | . | passed | 0 | 3263 ms |
| web-regressions | exec vitest run --config vitest.web.config.ts apps/web/tests/declared-reasoning.e2e.ts apps/web/tests/default-model.e2e.ts apps/web/tests/deepseek-messages-settings.e2e.ts apps/web/tests/deepseek-messages-chat.e2e.ts apps/web/tests/file-upload-round.e2e.ts apps/web/tests/feedback-release.e2e.ts apps/web/tests/onboarding-deepseek-config.e2e.ts | . | passed | 0 | 25170 ms |
| typecheck | exec tsc -b tsconfig.host.json tsconfig.client.json | . | passed | 0 | 7167 ms |
| lint | run lint:contracts-ready | . | passed | 0 | 26355 ms |
| bilingual-pairs | run verify-translation-pairing packages/client/ui-model-selection/README.md docs/comet/changes/flatten-model-picker/brief.md docs/comet/changes/flatten-model-picker/specs/composer-model-picker/spec.md | . | passed | 0 | 1116 ms |
| whitespace | diff --check | . | passed | 0 | 36 ms |

### Builder 报告的证据

以下为 Builder 报告，不等同于 Runtime 检查凭据或独立验收结果。

- pnpm run build: passed — 完整构建通过；CSS长名称修补后重建模型选择包。
- pnpm exec vitest run packages/client/ui-model-selection/tests: passed — 3文件40测试通过。
- Web affected regressions: passed — 7文件32测试通过；随后增加8组布局矩阵，declared-reasoning 3测试replay通过；两个owner-local ARIA快照已更新。
- Host/client typecheck and lint: passed — tsc -b tsconfig.host.json tsconfig.client.json通过；全仓lint:contracts-ready通过。
- Scoped bilingual pairing: passed — README、brief、spec三个双语对通过。
- test:docs and doc-sync: failed — 本次新增配对已补齐；剩余缺失链接与配对均来自HEAD已有comet-workflow-integration记录，详见验证记录。
- Real browser demonstration: passed — .playwright-mcp/model-picker-20261010/验证记录_20261010.json 与 GIF；真实模型回复“模型切换成功”。
- 已知限制: 全仓文档检查仍被不属于本次变更的既有Comet链接/配对缺失阻断。
- 已知限制: GIF由同一真实页面的六张截图组成，停留时长用于阅读，不代表模型响应耗时；编码使用现有Pillow。

## 阻塞项

_无。_

## 风险与跳过的工作

- 全仓 test:docs/doc-sync 尚未全绿：已确认 HEAD 中既有 comet-workflow-integration 规格引用缺失 spec.zh.md；该规格与 2026-09-22 归档 verification 的双语配对缺失属于本次差异之外。本次 README、brief、spec 三对的 Runtime 检查通过，不能据此声称全仓文档检查通过。
- 日期戳 GIF 由同一真实页面的六张截图按状态串联，展示列表、模型/等级结果与真实回复，但不展示连续鼠标动作，也不能用于判断响应耗时；编码使用现有 Pillow，未使用 ffprobe。
- 独立验证复用了当前候选、同一 workspace/machine 的 Runtime 检查回执，没有重新运行全套测试或再次发送真实模型请求；已核对相关源码/测试修改时间早于回执，演示源码哈希一致，并读取隔离 Session 佐证真实请求。

## 之前的迭代

| 目标周期 | 迭代 | 尝试 | 结果 | 未解决项 | 摘要 | 完成时间 |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | 1 | 0 | recovery | — | Native confirmed acceptance criteria changed | 2026-10-10T04:31:56.224Z |
| 2 | 1 | 1 | pass | — | 独立只读验收通过，A1–A7 均满足。核对完整 brief/spec、实现差异、候选绑定 Runtime 回执、布局与交互截图及真实 Session 后，未发现本次单层模型选择范围内的阻断缺陷；无需补充 Runtime 检查。保留既有全仓文档失败和截图串联 GIF 的限制；最终用户接受、归档与任何 Git 交付仍由主流程处理。 | 2026-10-10T04:44:29.401Z |



## 结论

独立只读验收通过，A1–A7 均满足。核对完整 brief/spec、实现差异、候选绑定 Runtime 回执、布局与交互截图及真实 Session 后，未发现本次单层模型选择范围内的阻断缺陷；无需补充 Runtime 检查。保留既有全仓文档失败和截图串联 GIF 的限制；最终用户接受、归档与任何 Git 交付仍由主流程处理。
