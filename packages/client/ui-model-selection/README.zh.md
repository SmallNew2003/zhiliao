---
description: "Web GUI 的模型选择：/model 弹窗与 composer 模型位共用一份按提供方分组的会话级目录；供模型路由的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

[English](README.md) | 中文

## 概述

Web GUI 允许用户通过 `/model` 弹窗或 composer 模型控件切换既有会话使用的模型与推理（reasoning）强度。两个界面呈现同一组按提供方分组的选择；所选模型决定可用的推理强度名称与默认值。完整选择从下一次请求开始生效；运行中的步骤保留其启动时的模型与推理强度。如果没有适配器可以服务会话路由，composer 会保持停用，直至路由恢复可用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 `ui-conversation` 及命令包一起挂载本插件；composer 随即在待处理指示器旁显示模型位，`/model` 则以弹窗打开同一份目录。模型位菜单打开期间，`↑`／`↓` 在所显示面板的行间移动焦点，`Tab` 选定聚焦行，Escape 与 `Shift+Tab` 先退出已下钻的面板，否则关闭并回到触发器。下钻落在正在使用的那一行，返回则落在打开该面板的格子上。当确切提供方／模型对仍在已公布分组中时，两个界面都显示 Host 报告的当前选择；目录行缺席时，可路由的选择保持不变，触发器提示 `Select model`。

### 模型与推理强度

模型按提供方分组。composer 菜单只显示模型与推理强度名称。`/model` 弹窗显示提供方名称与目录说明；其中两个内置 DeepSeek 模型的说明使用当前语言，外部提供方说明保持原文。弹窗应用所选模型的默认推理强度；composer 随后可以选择任一已公布的推理强度。适配器没有推理元数据时不显示 Effort 行；不存在任意推理强度输入。

### 上下文窗口

composer 菜单在「模型」与「推理等级」旁新增「上下文窗口」行；会话存在当前选择时该行常显。行内摘要显示有效容量：优先取会话的显式选择，否则取当前模型的目录容量——预设值简写为 `320K`，其他数值显示精确 token 数，两者都不可用时显示「未知」。下钻后提供 320K、640K、960K 三档预设（320,000、640,000、960,000 token），有效值所在行处于选中态；非预设容量不选中任何行，也不丢弃该值。选择窗口保留推理强度，选择推理等级保留显式窗口。点击正在使用的档位行或当前模型不做更改；选择其他模型会清除旧窗口覆盖值。下一次请求使用所选预算生成请求元数据并触发压力压缩，恢复的会话会还原该值。自定义容量保留在设置页。

成功调小窗口后会短暂提示继续对话前可能压缩上下文。正在运行的请求保留已接纳的预算，后续请求在发送前校验所选预算。

### 不可路由的会话

当 Host 报告没有适配器服务该会话的路由时，本插件注册一个 composer 阻塞块，输入框随之停用并显示本插件自己的文案；恢复后无需重新加载即清除。首次加载之前或加载失败之后的 `null` 绝不阻断；目录成员关系同样不阻断——一条仍在服务、只是不公布该模型的路由不在分组里，却可用。

### 选择失败

当会话被其他写句柄占用时，模型选择失败提示用户退出其他正在运行的 DSH 后重试。

-----


<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`ModelDirectoryResolver`（`ctx.modelDirectories`）持有一份 Host 代次级共享目录，并为每个会话绑定惰性创建选择目录。`/model` 弹窗与 composer 模型位将该目录和持久化 `modelSelection` 投影组合，经 `session.selectModel` 提交完整选择。连接重置使进行中的选择响应失效，在重新加载目录期间保留持久化当前值。转发的适配器、设置与凭据引用变更刷新共享目录。会话作用域释放时移除其选择目录；已寻址 subagent 会话不公开任何入口。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当仅了解模型界面还不够时，请阅读以下页面。这些页面从浏览器界面逐步深入到命令弹窗外壳与选择约定。

- [ui-commands](../ui-commands/README.zh.md)——`/model` 贡献项注册进的 popupSelect 外壳。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 composer 的 `conversation.input.model` 位与 composer 阻塞块。
- [dsh-agent-default-model](../../core/agent-default-model/README.zh.md)——为从未选择的会话提供默认模型的默认模型服务。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

两个入口提交的 `session.selectModel` 选择会间接影响模型：Host 会在下一次提示词组装边界为完整的 `ModelSelection` 创建快照，并负责使其对模型生效；运行中的步骤则保留已组装的选择。

#### KV Cache 影响

切换路由可能减少提供方侧后续请求的缓存复用，或使其失效；提示词前缀本身不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前模型选择界面。它们是当前包约束，不是通用模型路由器对比或任务积压。

- **无创建期或已寻址 subagent 选择**——两个入口都要求既有普通会话的 agent（智能体）；没有可纳入会话创建的草稿阶段模型选择，subagent 继续执行也有意不公开独立的模型选择约定。
- **目录名仅供呈现**——选择与持久化使用提供方／模型／推理强度 id 与数值预算；目录查询或确切模型元数据查询失败的提供方以不可选失败行列出，重新加载前保持原样。
- **不能任意输入推理强度**——composer 仅提供确切模型由适配器公布的推理强度；适配器没有推理元数据时不显示 Effort 行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件只注册一个 command contribution，HMR（热模块替换）安全性测试证明该注册的 dispose 能正确完成；它不发出 Cordis 事件，也不持有跨插件可变状态。
