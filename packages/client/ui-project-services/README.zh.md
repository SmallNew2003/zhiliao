---
description: "Web GUI 的项目服务面板：一个全局页面，列出项目各 Git 工作树中的原生进程与 Docker 容器，并带留存的日志。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-project-services

[English](README.md) | 中文

## 概述

项目服务面板是一个由侧栏行打开的全局页面。它一次列出一个 Git checkout 的原生进程与 Docker / Compose 服务，带每项服务的状态、归属、端口与留存的日志尾部。浏览器半侧把页面注册进 layout 的 `main` seat、把行注册进 `sidebar.panellist`，经 `ctx.remote` 读取 `projectServices` Remote 命名空间，并把结果投影为一份 inject face 快照加上面板的控制动词。组件保持纯展示。全部文案来自本包自己的 `projectServices` 字典。

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

浏览器半侧注册两份贡献，不需要任何 Host 侧组装：

- `ProjectServicesPanel` 注册进 layout 的键控 `main` seat，面板 id 为 `projectServices`。
- `ProjectServicesPanelIcon` 注册进侧栏的 `sidebar.panellist` 行，使用同一 id 与本地化标签，该行因此打开这个页面。

两者都经 `ctx.slots.inject()`，因此两个属主的激活顺序都无关紧要。面板渲染的每个事实都来自 `projectServices` Remote 命名空间；面板不持有存储、自己不订阅任何东西、不发 Remote 调用。Host 应答之前，面板只显示标题、worktree 选择器与提供方行。

### worktree 选择器

选择器以 `<id> (<path>)` 列出清单上报的每个 checkout，并跟随 source 的 `selectedCheckoutId`，其初值为第一个 checkout。改变选择会调用 `selectCheckout`，它把整个面板指向新 checkout 并收回已打开的日志查看器。checkout 的可用性以标题旁的标签呈现；一个 checkout 都没有时，选择器只提供一个占位选项。

### 提供方状态

标题区为清单上报的每个提供方带一个标签，标明提供方种类与状态——就绪、陈旧或不可用。Docker 守护进程不可达因此读作「不可用的提供方」，而不是「已停止的服务」；这正是同一 checkout 的原生服务保持可见且可操作的原因。

### 服务卡片

服务分为原生分区与 Docker / Compose 分区。每张卡片带服务名、状态点、状态标签、原生服务的归属标签、陈旧标签、详情行，以及服务上报端口时的端口列表。卡片提供的按钮是清单 `actions` 列表为该项服务列出、且其状态允许的那些：停止时给启动，运行时给停止与重启。动作在途的卡片被禁用，键为 source 对该服务 id 的在途标记。

属于某个分组的 Docker 服务渲染在该分组的卡片内、分组名之下，任一成员运行且无成员在途时带一个全部停止按钮；其余渲染为未分组卡片。

每个控制动词都携带面板为该目标观察到的修订号：Host 会拒绝目标修订号已发生移动的控制，因此陈旧修订号会大声失败，而不是去动一个操作者已经看不到的服务。

### 日志

`openLogs` 接收服务 id；source 读取该目标留存的尾部（16 KiB），卡片于是在标题下方长出内联日志查看器。读取在途期间查看器显示加载中标签，没有分片的页面显示空标签，否则每个分片一行、stderr 着色。被截断的页面带截断标签，上报缺口的页面带缺口提示，上报日志不可用的页面带该原因。`closeLogs` 关闭查看器，切换 checkout 也会收回它。

```tsx ignore-check
// The registration, from the browser face's apply():
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main',
  key: PANEL_ID,
  locale: NS,
  inject: () => source.inject(),
}, ProjectServicesPanel))
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`src/client/panel-source.ts` 拥有每个活的事实。它持有一份快照——清单、选中的 checkout、打开的日志查看器、在途动作标记与最后一次失败——并通过一个 `createSnapshotStore` 句柄发布它。inject face 把该句柄的快照作为 `usePanel` 选择器钩子交给组件，外加七个动词：`selectCheckout`、`refresh`、`control`、`stopGroup`、`openLogs`、`closeLogs` 与 `dismissError`。

follow 流的生命周期归 source 自己。第一个观察该快照的框架钩子打开 `ctx.remote.projectServices.follow`，最后一个离开的钩子中止它；`connection/reset` 会重开它。每个在途读取都带上该 activation 的中止信号，因此卸载面板即取消它。每个动词用一个 epoch 守卫自己的发布，被更新的动词取代的读取什么都不发布；每个动词都落为一个绝不拒绝的普通 `Promise<void>`——Host 的拒绝变成快照的 `error`，由面板渲染。这就是组件用 `void` 而不是 `.catch` 调用动词的原因。

`src/index.ts` 是 Host 入口且保持为空，因为面板没有 Host 侧行为；浏览器半侧是 `src/client/index.ts`，它以 `projectServices` 命名空间注册字典，并注册那两份 slot 贡献。

`src/client/index.ts` 中的 `LocaleNamespaceMap` 声明让 `t('section.native')` 及其同侪能对字典做类型检查，因此加进 `src/client/locales.ts` 的键会让任何缺少它的字典变成编译错误。`dsh.client.inject` 指名 Remote 组装包、locale 插件与两个 slot 属主；面板的 `Button`、`StateDot` 与 `Tag` 来自 `ui-primitives`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖面板背后的数据，以及同一批服务上面的模型可见界面。

- [dsh-project-services](../../workspace/project-services/README.zh.md)——面板渲染的清单与日志视图所属的共享运行时。
- [dsh-api-project-services-controller](../../api/project-services-controller/README.zh.md)——把运行时映射为 `ApiServiceInventoryView` 与 `ApiServiceLogsView` 的 Remote 界面。
- [dsh-tool-project-services](../../workspace/tool-project-services/README.zh.md)——读取并操作同一批服务的模型可见工具。
- [dsh-client-ui-plugin-manager](../ui-plugin-manager/README.zh.md)——另一个全局 `main` 面板，本包的注册写法照它来做。
- [dsh-client-ui-primitives](../ui-primitives/README.zh.md)——卡片渲染所用的 `Button`、`StateDot` 与 `Tag` 原子组件。
- [客户端包映射](../README.zh.md)——本面板所在的浏览器半侧包图。

-----

<a id="model-experience"></a>
## 模型体验

### 项目服务面板

#### 模型可见内容

没有直接可见内容。面板只渲染 `projectServices` Remote 命名空间发布的清单，不注册工具、提示词或 Session 事件，因此它展示的字符串都不进入模型请求。inject face 是它的唯一输入，它打印的标签来自 `projectServices` 字典，该字典仅由浏览器半侧注册。

#### Token 影响

直接 Token 成本为零。面板不贡献请求内容，也不追加历史条目；没有任何模型请求会为它的显示付出 Token。

#### KV Cache 影响

不直接修改请求前缀，也不使缓存失效。面板不组装 provider 请求、不追加会话内容，已可复用的前缀保持可复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定当前面板的触及范围。它们是当前包约束，不是与模型可见工具的对比。

- **以 Host 工作目录为界**——面板读取 `list` 与 `follow` 时不带 `cwd`，因此 Host 用它自己的工作目录解析项目。一个同时服务多个项目的浏览器，只看到启动时那一个。
- **日志不分页、不流式**——查看器只渲染送来的一页，长时间运行的服务因此只显示留存的尾部；`ApiServiceLogsView.nextCursor` 不在此处消费。
- **提供方与清单不分页**——`ApiServiceInventoryView.nextCursor` 不在此处消费，因此大于一页的清单被静默截断到那一页。
- **不渲染分组陈旧**——`ApiServiceGroupView.stale` 不被读取；分组陈旧只通过其成员的陈旧标签与其提供方的状态浮现。
- **只能按 checkout 过滤**——面板不提供名称或状态过滤器，因此服务众多的项目会列出所选 checkout 的全部服务。
- **不支持按定义启动**——面板只驱动清单 `actions` 列表列出的动词，不提供启动新的原生命令。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

用 `pnpm exec vitest run packages/client/ui-project-services --coverage` 跑本包的客户端用例；组件用例只经 props 驱动面板，source 用例经脚本化的命名空间替身驱动 Remote 接线，插件用例把 `apply` 装在 `SlotRegistry` 加 `TestRemote` 上启动。都不需要 key，除 jsdom 外也都不需要浏览器。

</details>

**运行时不变式：** 不发布伴生入口。面板不拥有任何可被独立观察拆分的所属关系，其资源释放即导入它的那个界面的卸载。
