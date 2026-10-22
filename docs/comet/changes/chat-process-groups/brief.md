# 目标

将 `ui-chat` 的紧凑会话展示调整为 Codex/Qoder 风格的“正文段 + 半折叠执行组”：Assistant 的可见正文继续作为段落总结，正文之间连续的思考、工具调用和重试行按段时间聚合；运行中的组展开，已完成的组默认收起，展开后的组内过程限高滚动，避免整串执行日志铺满会话。

# 范围

- `packages/client/ui-chat` 的 Chat Node 投影、分组渲染、折叠交互、本地化文案、样式和相关测试。
- `Compact` 会话展示使用执行组；`Normal` 保持当前平铺展示。
- 更新 `packages/client/ui-chat/README.md` 与 `README.zh.md` 中“轮次过程折叠”的当前行为说明。
- 用户提供的 Qoder 截图是行为与视觉参考，不是要复制的品牌资产；实现使用现有设计 token、图标和字体阶梯。

## Source coverage

| Source item and location | Read status | Content to preserve | Spec location | Acceptance ID | Coverage status | Reason or replacement |
| --- | --- | --- | --- | --- | --- | --- |
| S1: 截图，完成态折叠行 | complete | 只有思考过程的已完成执行组显示简洁的“分析请求”摘要并可展开 | `specs/chat-process-groups/spec.md` 的“已完成组显示摘要并默认收起”场景 | A7 | covered | 当前需求 |
| S2: 截图，第一段 Assistant 正文 | complete | Assistant 的可见正文段保留在会话流中，不被并入执行组 | `specs/chat-process-groups/spec.md` 的“Assistant 正文分隔执行组”场景 | A3 | covered | 当前需求 |
| S3: 截图，完成态执行摘要 | complete | 含工具调用的已完成组根据去重后的动作类型生成简短描述，最多展示两类主要动作且不显示次数；存在失败时追加“部分操作失败” | `specs/chat-process-groups/spec.md` 的“已完成组显示摘要并默认收起”和“完成摘要只描述动作类型”场景 | A7 | covered | 当前需求 |
| S4: 截图，第二段 Assistant 正文 | complete | 后续 Assistant 正文继续分隔前后执行组，并保持原始时间顺序 | `specs/chat-process-groups/spec.md` 的“Assistant 正文分隔执行组”场景 | A3 | covered | 当前需求 |
| S5: 截图，“正在执行中 · 86s”展开行 | complete | 运行中的执行组默认展开，标题显示运行状态和该轮已经过的时间 | `specs/chat-process-groups/spec.md` 的“运行中的组默认展开”场景 | A6 | covered | 当前需求 |
| S6: 截图，运行组内的思考、搜索、终端、打开网页和进行中思考行 | complete | 组内保留逐项状态行，已完成项与进行中项状态可区分，逐项仍可独立折叠 | `specs/chat-process-groups/spec.md` 的“组内过程保持紧凑且可独立展开”场景 | A9 | covered | 当前需求 |
| S7: 截图，运行组左侧缩进线和渐隐区域 | complete | 展开组采用缩进的半折叠容器，内容超过高度上限时内部滚动并在可滚动边缘渐隐 | `specs/chat-process-groups/spec.md` 的“展开组限高并内部滚动”场景 | A8 | covered | 当前需求 |
| S8: 截图，执行过程未铺满整个会话 | complete | 已完成组收起；运行中组的过程区域有高度上限，不把完整日志长串铺开 | `specs/chat-process-groups/spec.md` 的“展开组限高并内部滚动”场景 | A8 | covered | 当前需求 |

# 非目标

- 不调用模型生成新的过程总结，不新增模型请求或模型可见输入。
- 不修改 Session 事件、持久化格式、SDK 投影或轨迹视图。
- 不重做工具卡片、思考 Markdown、运行轨迹详情或统计面板。
- 不为 `Normal` 模式新增分组标题；它继续平铺展示过程行。
- 不移植上游完整的多档 work-details 设置体系。

# 验收示例

- 在一个已完成轮次中渲染“执行组、Assistant 正文、执行组、Assistant 正文、最终回答”时，会话顺序与日志一致；两段正文保持可见，两个执行组各自可展开，已完成组默认收起。
- 在一个运行中的轮次中，当前执行组默认展开并显示运行状态与经过时间；上一条正文出现后，前一个执行组默认收起，组内最新过程仍可辨认。

# 约束与不变量

- 分组只改变展示：不得改变 `SessionEventMap`、Session 日志、模型历史或应答顺序。
- 用户消息、steering、系统提示词、错误、最大 token 提示和轮次尾部保持独立，不进入执行组。
- 同一个 Assistant Node 可以贡献两部分：推理进入执行组，可见正文留在组外；不得重复渲染同一块内容。
- 执行组以首成员的稳定标识作为 key；流式追加、轮次完成和历史分页不得改变既有成员相对顺序。
- 切换折叠状态不得重新挂载有状态的工具 renderer；折叠通过可见性、高度或滚动状态完成。
- 组内子项继续使用现有思考行和工具行；组默认展开时，子项仍遵守各自默认折叠状态。
- 组标题、状态和摘要文案进入 `ui-chat` 的本地化字典，不在组件内硬编码中文或英文。
- 复用的隐藏过程内容继续支持浏览器页内查找；命中隐藏内容时打开对应执行组。
- 视觉使用现有 `--dsw-*` 与 `--dsh-*` token；展开组正文上限为 `min(400px, 50vh)`，上下可滚动边缘显示渐隐。
- `Compact` 为默认模式；`Normal` 不显示组标题且不限制过程高度。

# 决策

- 使用 Assistant 已有的可见正文作为“小总结”，不额外生成文本。
- 分组边界是下一条可见 Assistant 正文或轮次边界；单条 Assistant Node 内以回复块是否存在拆分推理与正文。
- 运行中的组默认展开；标题显示“正在分析/读取/搜索/执行”等当前活动与该轮经过时间。
- 已完成的组默认收起；仅思考的组显示“分析请求”，含工具的组根据去重后的动作类型显示最多两类主要动作，不展示次数；存在失败时追加“部分操作失败”。
- 保留现有 `Compact / Normal` 偏好；`Compact` 应用执行组，`Normal` 平铺。
- 在当前 `ui-chat` 投影层实现，不引入 Session 事件，也不升级到上游完整的 work-details 模式架构。

# 待解决问题

无。

# 验证预期

- 为分组投影补充单元测试，覆盖正文边界、推理与正文拆分、动作类型排序、失败状态、运行与完成状态。
- 为 `ChatView` 补充组件测试，覆盖运行组展开、完成组收起、组内限高滚动、手动展开、页内查找、键盘操作和 `Normal` 平铺。
- 运行 `packages/client/ui-chat` 的聚焦测试、仓库类型检查和 lint；若改动影响 Web 快照或可访问性断言，同步更新对应 owner-local 期望。
- 手工预览 Web 会话，确认运行中与完成后两种状态均符合截图节奏，且没有整串执行日志铺满会话。
