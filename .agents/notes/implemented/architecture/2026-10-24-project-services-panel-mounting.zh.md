# Agent Note: Project services panel mounting and the three-plane service view

Status: implemented

[English](2026-10-24-project-services-panel-mounting.md) | 中文

## Problem

项目服务分支交付了一个从未被挂载的浏览器面板（`packages/client/ui-project-services`）：`src/client/index.ts` 只注册了文案字典，控制器的四个 Remote 方法没有任何浏览器调用方。面板的数据路径是十六个 ad-hoc props，因此第一个调用方不得不从零重新推导 Remote 接线、流生命周期与控制动词。

两个问题此前的记录没有回答。第一，项目级面板该占哪个 seat：设计文档只要求「主界面」而未指名 slot，而每个已交付的按会话 seat 都会在会话切换时重挂面板。第二，现在看到同一批服务的三个平面——Host 控制器、浏览器面板与模型工具——如何相互关系，以及什么授权了一个模型工具的审批策略并不把关的浏览器控制。

## Decision

**面板是 root 作用域的全局页面。** 它注册进 layout 的键控 `main` seat，面板 id 为 `projectServices`；它的图标以同一 id 注册进侧栏的 `sidebar.panellist` 行。两者都经 `ctx.slots.inject()`，因此两个属主的激活顺序都无关紧要。项目服务属于一个 Git 项目及其工作树，不属于某个 Session；按会话的 seat 会在每次会话切换时丢弃选中的 checkout 与打开的日志查看器。

**面板读取 `projectServices` Remote 命名空间，不贡献任何 Host 行为。** `src/index.ts` 保持为空的 Host 入口。`src/client/panel-source.ts` 持有一份快照——清单、选中的 checkout、打开的日志查看器、在途动作标记、最后一次失败——经一个 `createSnapshotStore` 句柄发布。inject face 把该快照作为 `usePanel` 选择器钩子交给组件，外加七个动词：`selectCheckout`、`refresh`、`control`、`stopGroup`、`openLogs`、`closeLogs` 与 `dismissError`。

**follow 流的生命周期归 source 自己，以观察为键。** 第一个观察该快照的框架钩子打开 `ctx.remote.projectServices.follow`；最后一个离开的钩子中止它；`connection/reset` 重开它。每个在途读取都带上该 activation 的中止信号，因此卸载面板即取消它。每个动词用一个 epoch 守卫自己的发布，被更新的动词取代的读取什么都不发布；每个动词都落为一个绝不拒绝的 `Promise<void>`——Host 的拒绝变成快照的 `error`。这就是组件用 `void` 而不是 `.catch` 调用动词的原因。

**控制动词携带观察到的修订号。** Host 会拒绝目标修订号已发生移动的控制，因此面板传该项的 `revision`，而不是让控制器取默认值。分组停止按每个成员各自的修订号逐成员发一次控制，并在分组落定前把每个成员都标记为在途。

**三个平面共用一份授权、一份实例身份与一份日志。** Host 控制器每次调用构建一个人类 `ServiceAccess`；浏览器面板经 Remote 命名空间驱动同一个控制器，而浏览器控制不是 Agent 动作，因此工具审批策略不把关它。面板只渲染控制器为该访问发布的内容，自己不持有任何 authority。模型工具经同一运行时读取并操作同一批服务，因此 GUI 与模型看到的是同一张服务表，而不是两张。

## Verification

组件用例只经 props 驱动面板，并在 `ProjectServicesPanel.tsx` 上达到 per-file 100% 覆盖。source 用例脚本化 Remote 命名空间，钉住 follow 生命周期：流在第一个观察者处打开、在 `connection/reset` 时重开、随最后一个观察者中止、丢弃被更新的动词取代的读取。插件用例把 `apply` 装在 `SlotRegistry` 加 `TestRemote` 上启动，断言两份注册、它们的选项，以及它们随插件 fiber 一起释放。

## Alternatives considered

**注册进按会话的 seat**，例如 `conversation.input.dock` 或 `sidebar.right.pane.tab`。拒绝原因：两者都会在会话切换时重挂面板，从而丢弃选中的 checkout 与打开的日志查看器；面板的数据是项目级的，没有可作为键的会话依赖。

**给面板自己的 Host Service Definition 并直接读运行时。** 拒绝原因：这会把模型工具读取的服务表分叉出来——同一批进程上的两条观察路径会漂移，浏览器还需要自己的一套授权叙事。控制器的 Remote 命名空间是两个平面都已经跨越的那一道缝。

**把清单作为 owner props 由 shell 下发。** 拒绝原因：那样 shell 就拥有了面板的数据，而 `main` 的占户收到的 owner share 承载不了它；registrant-private 的 inject face 是单个条目活事实的既定路径。

**让组件在本地持有视图状态。** 拒绝原因：打开的日志查看器与选中的 checkout 会在每次重挂时重置，移动它们的动词也不得不搬进组件，那会让它发 Remote 调用并失去纯展示性质。

**注册时读一次清单，再用定时器刷新。** 拒绝原因：轮询不管有没有人看这个页面都在花 Host 的开销，而陈旧帧与活帧无法区分。以观察为键的订阅加上 Host 的 follow 流，在页面关闭时零成本。

## Consequences

- 新增一个面板事实意味着改 `ProjectServicesPanelSnapshot` 并在组件用例中覆盖它；组件永远不需要知道这个事实来自哪里。
- 动词绝不拒绝，因此写 `.catch` 的组件作者会引入 per-file 覆盖门禁拒绝的死代码。README 写明了这条义务。
- 每个控制动词在调用点都需要观察到的修订号，因此新卡片必须从携带 `revision` 的项渲染。
- 面板看到的是 Host 启动时所在的项目，因为它读 `list` 与 `follow` 时不带 `cwd`。一个同时服务多个项目的浏览器需要 Host 尚未暴露的项目选择器。
- 面板的控制不受工具审批策略把关。想要让一次人类点击与一次模型调用经受同样审查的部署，必须在控制器处加，而不是在这里。
