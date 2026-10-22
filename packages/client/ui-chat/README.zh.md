---
description: "渲染会话对话节点、历史图片、操作、本地化和滚动状态的浏览器 Chat target。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

[English](README.md) | 中文

## 概述

使用本包可在浏览器中渲染已记录的 Session 对话，包括历史图片、本地化操作和滚动位置恢复。紧凑显示会把可见 Assistant 正文之间连续的过程行聚合为执行组，运行中的工作保持展开，完成后的组收起为摘要；已打包的历史 Assistant 连续消息保持收起。本地 transcript（文本记录）与 steering（中途引导）提交会立即显示，在权威会话记录到达时原子地消失，而排队中的提交始终不进入 Chat。本包不组装或修改模型请求。

文件提及提供方同时接收当前查看的会话 ID 与收尾轮次的属主信息，因此继承历史中的链接可以指向 fork 自身。

## 目录

- [引用预览](#reference-previews)
- [系统提示词行](#system-prompt-row)
- [轮次 token 用量](#turn-token-usage)
- [已完成轮次的页脚](#completed-turn-footer)
- [执行组](#turn-process-folding)
- [滚动归属](#scroll-ownership)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="reference-previews"></a>
## 引用预览

Chat 在节点列表外通过一个 `MarkdownDelegateProvider` 提供文件及 HTTP(S) 导航。Assistant Markdown 文件链接在消息落定后可于右侧栏打开，包括未修改文件的引用。相对路径基于当前查看的 Session 工作区解析；绝对路径仍使用同一 Session 的文件系统访问。`#L24` 和 `#L24-L30` 定位到指定起始行，并复用现有文件标签。文件缺失时显示预览错误状态。

Assistant Markdown 中的 HTTP(S) 链接在普通点击时会在该类型已注册时打开新的右侧 Sidebar Browser tab，否则改用系统浏览器；带修饰键的点击保留原生外部链接行为。已发送的文件引用及消息日志确认调用的 skill 也可在右侧栏打开预览。文件路径使用当前查看的 Session；skill 名称由该 Session 当前的输入触发源解析。两者悬停或聚焦时均使用正文文件链接的虚线下划线。会话、目录和命令标签仍只作为引用展示。

<a id="system-prompt-row"></a>
## 系统提示词行

每个非空追加的 `system/message` 都拥有一行折叠提示词，包括无 header 窗口起点的完整提示词；同一步骤的 header 不会重复它。Chat 也会为非空的初始请求、显式消息序列起点、文本发生变化的 `system/message` surface 节点替换（文本读取自 `request/header` 处 surface 顺序中最后一个非空存活系统节点），或前序 header 尚未进入已加载历史窗口的非初始请求显示一行默认折叠的 `系统提示词`。即使系统文本未变，恢复也会重复该行，包括分页补齐前序 header 和系统节点后；同一序列内仅配置或仅工具变化、工具步骤与重试不会重复，且 `system/message` 事件绝不会渲染为对话消息。该行位于请求的用户消息之前，与提供方 envelope 顺序一致；展开后显示模型所见的确切文本，并保留其原始换行。系统节点为空或位于已加载窗口之外的请求不创建该行，直到包含该节点的分页到达。

-----

<a id="turn-token-usage"></a>
## 轮次 token 用量

只有当已加载窗口包含 `turn/start`，且每次已启动的模型尝试都报告安全、精确的用量时，已完成轮次才显示可展开的用量行。该行会省略不可用的可选用量桶。记账不完整或相互矛盾时，整个详情都不显示，避免把部分总量冒充完整结果。

Assistant 回复结算后，已完成轮次的计时对话框不显示 TTFT 和解码速度，实时回复完成后和重新打开历史后都如此。轮次总耗时仍可用。Session Stats 药丸从其持久化投影独立读取计时。

<a id="completed-turn-footer"></a>
## 已完成轮次的页脚

已完成轮次的操作页脚位于前方正文或扩展内容下方 20px。

-----

<a id="turn-process-folding"></a>
## 执行组

「设置 → 通用设置」提供持久化到 `ui-chat` 命名空间的「标准」/「紧凑」对话显示偏好，默认使用「紧凑」。紧凑模式把可见 Assistant 正文之间连续的上下文注入、推理、工具行与重试行聚合为执行组；可见 Assistant 正文或 `turn/end` 关闭当前组。系统提示词、用户消息、steering、错误、最大 token 与 turn-tail 行保持独立。标准模式按原顺序平铺过程行，不显示组标题。

运行中的组默认展开，标题显示当前活动与该轮已经过的时间。已完成的组默认收起；标题根据实际动作概括最多两类主要操作且不显示次数，例如「读取文件、运行命令」；仅含推理的组显示「分析请求」，存在失败时追加「部分操作失败」。展开组后，组正文最大高度为 `min(400px, 50vh)`，内部独立滚动，并在仍有可滚动方向的一侧渐隐。组内推理行和工具行继续保留各自的折叠。收起的正文使用 `hidden="until-found"`，浏览器页内查找命中时会打开对应组。会话作用域存储记录用户显式选择的展开状态，因此手动选择可在流式输出、历史分页与 Chat 视图重新挂载后保留。组 key 与成员 seat 在运行转结算、运行转完成时保持稳定，不重新挂载工具 renderer。切换「紧凑」与「标准」只改变展示，不新增 Session 事件或模型输入。

-----

<a id="scroll-ownership"></a>
## 滚动归属

Chat 会在历史前插与 renderer 重新挂载时恢复语义锚点。没有读者移动的贴底滚动事件会立即更新跟随归属，避免后续布局变化使其底部位置失效。读者移动即使位于跟随阈值内，也保持待处理直到采样周期或 `scrollend`，防止布局增长抵消小幅滚动操作。读者跟随底部时，`ResizeObserver` 追随新的底部，并且无需读取行几何就选中最后一个已加载轮次；读者离开底部后，高度变化会保持顶部位置，再由阅读线几何选择活跃轮次。轮次导航预览位于 Markdown 代码块粘性头栏上方，而导航外框始终处于 composer 上方的 transcript 区域内。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包在浏览器中渲染已记录的对话状态，不注册任何面向模型的内容。

#### KV Cache 影响

无；Chat 呈现不会组装或修改提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **transcript 只反映已加载的 Session 窗口**——只有会话控制器加载前一页事件后，更早的 transcript node 才会出现。轮次导航比窗口更宽：轨道把已加载的轮次与宿主 `turnOutline` 投影合并，每个已开始的轮次都有固定间距刻度（相隔 10px；阶梯高于外框时在框内滚动并以渐变淡出标示可滚方向），激活未加载刻度会先把历史分页拉到该轮次的 `turn/start` seq 再落到它的行上。没有该投影时（未挂载 `dsh-session-turn-outline` 的装配），轨道回退到仅显示已加载轮次。
- **导航预览按卡片尺寸截断**——提示词一行（50 字符）、回复至多三行（120 字符），已加载与未加载 Turn 一致；未加载 Turn 的回复要等该轮落定后才随大纲到达，进行中的轮次在此之前只预览提示词（或仅轮次号）。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Conversation 与 slot 注册已经强制 Chat target 一致。
