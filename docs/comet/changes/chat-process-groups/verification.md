---
generated_from_state_version: 11
---

# 验证

## 当前结果

- 结果: **验收通过，需要你确认**
- 验证情况: **已完成检查，但需要你确认验证结果**
- 目标周期: 2
- 迭代: 2
- 验证器尝试次数: 1
- 完成时间: 2026-10-22T04:52:54.929Z
- 摘要: 修复真实有效。执行组 key 已从可重复的 turn-tail fallback 改为首成员稳定标识，并在增量投影中按旧成员包含关系复用；未发现其他 key 冲突、组覆盖、错误完成态或折叠导致 renderer 重挂载的问题。当前候选的 8 项 Runtime 检查全部通过，补充的 98 项聚焦测试也全部通过，A1-A16 均通过。

## 验收

| 编号 | 结果 | 来源 | 验收项 | 原因 |
| --- | --- | --- | --- | --- |
| A1 | passed | brief.md | 在一个已完成轮次中渲染“执行组、Assistant 正文、执行组、Assistant 正文、最终回答”时，会话顺序与日志一致；两段正文保持可见，两个执行组各自可展开，已完成组默认收起。 | 已完成轮次按日志顺序投影为正文、执行组和最终回答；两个正文保持独立可见，两个完成组默认收起且标题按钮可展开。 |
| A2 | passed | brief.md | 在一个运行中的轮次中，当前执行组默认展开并显示运行状态与经过时间；上一条正文出现后，前一个执行组默认收起，组内最新过程仍可辨认。 | 当前运行组默认展开并按轮次 startTime 显示本地化状态与经过时间；可见正文出现后执行组由 running 转为 closed，默认折叠。增量场景确认新运行组不会覆盖前一个完成组。 |
| A3 | passed | specs/chat-process-groups/spec.md | Assistant 正文分隔执行组 - **WHEN** 一个轮次包含“过程内容、可见 Assistant 正文、过程内容、可见 Assistant 正文、最终回答” - **THEN** 两段可见正文都留在执行组之外并保持原顺序 - **AND** 每段连续过程内容分别形成一个执行组 - **AND** 首个正文之前的独立过程内容也可以形成执行组 | projectProcessGroups 在可见 Assistant 正文前 flush 当前过程段，正文作为独立 seat 输出，后续过程重新建组；首个正文前的过程也能成组，顺序与输入日志一致。 |
| A4 | passed | specs/chat-process-groups/spec.md | 单个 Assistant Node 按内容分拆 - **WHEN** 一个 Assistant Node 同时包含非空推理块和可见回复块 - **THEN** 推理块进入所在执行组 - **AND** 可见回复块留在执行组之外 - **AND** 同一内容块不会重复渲染 | 同一 Assistant Node 的 reasoning 块只进入组的 reasoning part，非 reasoning 块只进入 response seat；ChatNodeSeat 按 part 过滤块，未发现同一内容被重复渲染。 |
| A5 | passed | specs/chat-process-groups/spec.md | 独立行不进入执行组 - **WHEN** 轮次中出现用户消息、steering、系统提示词、错误、最大 token 提示或轮次尾部 - **THEN** 该行保持独立并按原顺序渲染 - **AND** 它成为相邻执行组之间的边界 | System prompt、User、steering、错误、最大 token 提示和 turn-tail 均属于独立边界，会关闭当前组并保持自身顺序；Context 等连续过程内容仍进入组内。 |
| A6 | passed | specs/chat-process-groups/spec.md | 运行中的组默认展开 - **WHEN** 执行组仍处于运行中 - **THEN** 组默认展开 - **AND** 标题显示当前活动状态和该轮已经过时间 - **AND** 进行中的思考或工具行显示运行状态 | 未完成组使用 running 标题，优先显示当前进行中的工具活动，否则显示思考状态；elapsed 使用该轮计时并按秒刷新。 |
| A7 | passed | specs/chat-process-groups/spec.md | 已完成组显示摘要并默认收起 - **WHEN** 后续可见 Assistant 正文出现或轮次结束关闭执行组 - **THEN** 组默认收起 - **AND** 仅含思考的组显示“已处理” - **AND** 含工具调用的组显示“执行工具 N 次” - **AND** 存在失败调用时追加“其中 M 次失败” - **AND** 组标题使用执行组内去重后的工具调用计数 | 后续正文或 turn/end 会关闭组；无工具时显示“已处理”，有工具时显示去重后的调用总数并追加失败数。组 key 修复后完成态不会再被后一运行组覆盖。 |
| A8 | passed | specs/chat-process-groups/spec.md | 展开组限高并内部滚动 - **WHEN** 用户展开一个执行组 - **THEN** 组内过程区域最大高度为 `min(400px, 50vh)` - **AND** 内容超出高度时在执行组内部滚动 - **AND** 可继续向上或向下滚动时对应边缘显示渐隐提示 | 展开区域 CSS 使用 max-height: min(400px, 50vh) 和 overflow-y: auto；滚动位置同步 data-scroll-up/down，并映射为上下边缘渐隐。 |
| A9 | passed | specs/chat-process-groups/spec.md | 组内过程保持紧凑且可独立展开 - **WHEN** 执行组展开并包含多条思考或工具行 - **THEN** 每行保持现有紧凑摘要形态 - **AND** 已完成、失败和进行中状态可区分 - **AND** 思考行和工具行仍可各自展开详情 | 组内继续复用 ChatNodeSeat、ReasoningRow 和现有工具渲染器；每条成员独立 key，原有完成、失败、运行状态及各自展开能力未被替换。 |
| A10 | passed | specs/chat-process-groups/spec.md | 组标题支持键盘和指针操作 - **WHEN** 用户点击执行组标题或聚焦后按 Enter 或 Space - **THEN** 执行组切换展开状态 - **AND** 标题暴露 `aria-expanded` - **AND** 展开前的焦点停留在标题上 | 组标题是原生 button，Enter/Space 可触发点击；aria-expanded 随状态更新，点击时显式保持标题焦点。 |
| A11 | passed | specs/chat-process-groups/spec.md | 页内查找揭示隐藏过程 - **WHEN** 浏览器页内查找命中已收起执行组内的文字 - **THEN** 对应执行组自动展开并显示命中内容 | 组正文使用 hidden='until-found'，监听 beforematch 后设为展开并持久化显式展开选择；组件测试确认命中后状态同步变化。 |
| A12 | passed | specs/chat-process-groups/spec.md | Compact 使用执行组 - **WHEN** 会话展示设置为 `Compact` - **THEN** 符合条件的连续过程内容使用执行组 - **AND** 运行中组展开、已完成组收起 | Compact 分支从 snapshot.processGroups.layout 渲染，运行组默认展开、完成组默认收起；切换时组标题和分组布局重新出现。 |
| A13 | passed | specs/chat-process-groups/spec.md | Normal 保持平铺 - **WHEN** 会话展示设置为 `Normal` - **THEN** 过程行按现有平铺方式显示 - **AND** 不显示执行组标题或组级限高 | Normal 分支继续按原始 order 平铺 ChatNodeSeat，不渲染 ProcessGroupSeat，因此无组标题和组级限高。 |
| A14 | passed | specs/chat-process-groups/spec.md | 流式追加与历史分页保持顺序 - **WHEN** 执行组内容流式增长、轮次完成或历史分页改变已加载窗口 - **THEN** 既有成员保持稳定 key 和相对顺序 - **AND** 用户手动展开状态仅在对应组仍存在时保留 - **AND** 不因重新渲染改变工具或思考节点已选择的状态 | 组 key 由首成员稳定 nodeKey/part 生成，并以旧组成员包含关系复用；回归测试和额外只读场景确认完成组与后续运行组得到两个不同 key，折叠不卸载 renderer。 |
| A15 | passed | specs/chat-process-groups/spec.md | 执行组文案来自本地化字典 - **WHEN** 执行组显示运行状态、完成摘要、工具计数或失败计数 - **THEN** 文案来自 `ui-chat` 的本地化字典 - **AND** 中文与英文均覆盖全部新增键 | 运行状态、完成摘要、工具计数和失败计数均通过 ui-chat 的 t 字典输出；zh 与 en 覆盖全部 activity 和标题键。 |
| A16 | passed | specs/chat-process-groups/spec.md | 运行状态不依赖颜色单独表达 - **WHEN** 执行组或组内行处于运行中 - **THEN** 同时提供文本或状态语义 - **AND** 动画在 `prefers-reduced-motion` 下停止 | 运行状态同时由标题文本表达，不只依赖颜色；running 动画及 chevron transition 在 prefers-reduced-motion: reduce 下均被禁用。 |

## 检查

| 检查 | 命令 | 工作目录 | 状态 | 退出码 | 耗时 |
| --- | --- | --- | --- | ---: | ---: |
| Repository typecheck | run typecheck | . | passed | 0 | 8921 ms |
| ui-chat focused tests | vitest run packages/client/ui-chat/tests | . | passed | 0 | 5549 ms |
| ui-chat 100 percent coverage | vitest run --coverage --coverage.include=packages/client/ui-chat/src/** packages/client/ui-chat/tests | . | passed | 0 | 6342 ms |
| ui-chat changed-file lint | exec oxlint --config .oxlintrc.json packages/client/ui-chat/src/client/contract/process-groups.ts packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts packages/client/ui-chat/src/client/chat/process-group-title.ts packages/client/ui-chat/src/client/chat/ProcessGroupSeat.tsx packages/client/ui-chat/tests/process-groups.client.spec.ts packages/client/ui-user-questions/tests/plan-review-panel.client.spec.tsx packages/client/ui-user-questions/tests/user-questions-composer.client.spec.tsx | . | passed | 0 | 2469 ms |
| Client UI locale ownership | run verify-client-ui-i18n | . | passed | 0 | 2073 ms |
| Client implementation build | run build:lib:client | . | passed | 0 | 4003 ms |
| Package README summary budget | run verify-package-readme-summaries | . | passed | 0 | 1765 ms |
| ui-chat README bilingual pairing | run verify-translation-pairing packages/client/ui-chat/README.md | . | passed | 0 | 1890 ms |

### Builder 报告的证据

以下为 Builder 报告，不等同于 Runtime 检查凭据或独立验收结果。

- pnpm run typecheck: passed — 修复后的 Host build 与 client TypeScript project references 均通过
- pnpm vitest run --coverage --coverage.include='packages/client/ui-chat/src/**' packages/client/ui-chat/tests: passed — 31 个测试文件、364 项测试通过；Statements/Branches/Functions/Lines 均为 100%
- pnpm exec oxlint --config .oxlintrc.json <changed-files>: passed — 修复文件及相关测试通过 lint
- pnpm run verify-client-ui-i18n: passed — 699 个 Client UI source file 使用 locale-owned copy
- pnpm run build:lib:client: passed — 修复后的 Client TypeScript 与 tsdown 实际构建通过
- pnpm run verify-package-readme-summaries: passed — 346 个英文 package README Summary 均在 100 词内
- pnpm run verify-translation-pairing packages/client/ui-chat/README.md: passed — 中英文 README Summary 已同步，双语配对一致
- git diff --check: passed — 无空白或行尾错误
- pnpm run test:docs: failed — 上次完整 doc-quick 为 18 passed / 2 failed，剩余为既有 docs/comet 双语配对缺口与顶层 spec 缺失 spec.zh.md；ui-chat README Summary 与命名配对专项门禁已通过。
- 已知限制: 未执行真实模型流的 Web 手工预览；组件行为、Client 构建与完整聚焦门禁已通过。
- 已知限制: 仓库存量 docs/comet 文档双语配对和断链问题使全量 test:docs 仍为红；本次未扩大范围修复这些既有文档债务。

## 阻塞项

- **user**: The generic Skill bridge cannot prove an independent Verifier execution; user confirmation is required before Archive. — next: `await-user`

## 风险与跳过的工作

- 未执行真实模型流的 Web 手工预览，真实浏览器中的页内查找、滚动渐隐和计时组合仍属于组件/CSS 级证据。
- 全量 pnpm run test:docs 仍因既有 docs/comet 双语配对和断链问题失败；本次涉及的 ui-chat README Summary 与命名配对专项门禁均已通过。

## 之前的迭代

| 目标周期 | 迭代 | 尝试 | 结果 | 未解决项 | 摘要 | 完成时间 |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | 0 | 0 | recovery | — | Native Shape artifacts changed | 2026-10-22T03:30:06.772Z |
| 2 | 1 | 1 | fail | A2, A3, A7, A14 | 候选实现的大部分交互、可访问性、本地化和 Compact/Normal 呈现符合要求，且未发现 Session 事件、持久化格式、SDK 投影或模型输入变更。但执行组 fallback key 未防重，导致流式过程中前一组数据被覆盖、组 key 重复并破坏手动展开和 renderer 状态，因此整体判定 fail。 | 2026-10-22T04:40:41.574Z |
| 2 | 2 | 1 | pass | — | 修复真实有效。执行组 key 已从可重复的 turn-tail fallback 改为首成员稳定标识，并在增量投影中按旧成员包含关系复用；未发现其他 key 冲突、组覆盖、错误完成态或折叠导致 renderer 重挂载的问题。当前候选的 8 项 Runtime 检查全部通过，补充的 98 项聚焦测试也全部通过，A1-A16 均通过。 | 2026-10-22T04:52:54.929Z |



## 结论

修复真实有效。执行组 key 已从可重复的 turn-tail fallback 改为首成员稳定标识，并在增量投影中按旧成员包含关系复用；未发现其他 key 冲突、组覆盖、错误完成态或折叠导致 renderer 重挂载的问题。当前候选的 8 项 Runtime 检查全部通过，补充的 98 项聚焦测试也全部通过，A1-A16 均通过。
