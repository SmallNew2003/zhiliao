# Agent Note: 源码启动的插件模块平面

Status: implemented

[English](2026-10-15-source-launch-plugin-module-plane.md) | 中文

## 问题

任何会调用工具的 headless 运行都会失败，报 `dsh: UNKNOWN: Cannot read properties of undefined (reading 'prepare')`；不调用工具的运行则正常。在源码启动中，`@deepseek-ai/dsh-tools` 被加载成两个模块实例：`tools` 插件入口解析到 `packages/core/tools/lib/index.js`，而 `packages/core/agent-loop/src/tool-calls.ts` 从 `packages/core/tools/src/index.ts` 导入同一个包。`TOOL_RUNTIME_SCHEDULER` 是 `unique symbol`，两个实例各自生成自己的标识。产物平面实例构造了 `ToolRuntime` 并用自己的符号注册 `ctx.tools`；`tool-calls.ts` 用源码平面实例的符号读取该服务，于是 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 求值为 `undefined`。该缺陷仅出现在源码启动：打包运行没有 tsx，插件入口与图内导入都经 `exports` 解析到 `lib`，共享同一实例。

## 决策

源码启动——即 [`boot()`](../../../../packages/boot/app-boot/src/index.ts) 未收到 `bareModuleBaseUrl` 的情况——让工作区与 vendored 插件入口改走环境模块管道，也就是图内其余部分已在使用的 tsconfig `paths` 投影，而不再用 Node 的内部 ESM 加载器。[`source-plane.ts`](../../../../packages/boot/app-boot/src/source-plane.ts) 在 `loader.internal` 上安装了一个源码平面包装器：只有当插件入口自己的位置把该裸标识符解析到 `node_modules` 之外时，它才改走普通动态 `import()`。环境管道无法投影的标识符、被入口自己的位置解析进 `node_modules` 的标识符，以及相对或内建标识符，仍走内部加载器。打包运行会传入 `bareModuleBaseUrl`，对所有裸标识符继续使用内部加载器，其解析不变。判据单独成模块而不是挨着 `boot()`，是为了让逐文件覆盖率门禁能直接度量它；判据读取一个可注入的解析器，默认实现才是环境解析，单测因此不依赖环境解析状态。

「入口自己的位置」这个条件是包装器不接管配置自有解析的关键。tsx 会把裸标识符无条件投影到工作区的 `src` 入口，与导入方无关，因此单看投影无法区分「工作区包」和「组合用自己 `node_modules` 里的副本遮蔽了 harness 包名」这两种情况。从 profile 基准 URL 解析该标识符——启动时即 profile 解析路由器给出的答案——才能分开它们：工作区包解析进检出目录，而遮蔽包解析进组合自己的 `node_modules`，于是保留组合自己的副本。

这扩展了[通过 tsx ESM hook 的源码启动](2026-07-29-dsh-source-launch-tsx-esm.zh.md)决策：那份笔记让 CLI 图走 tsx `paths`，这一份让加载器挂载的插件入口也走同一投影，使同一个包不会在一次启动里同时解析到两个平面。

## 考虑过的替代方案

**去掉 tsconfig `paths`，把整个源码启动图都解析到 `lib`。** 否决：这会抹掉源码启动所依赖的零构建开发回路，并违反「源码平面 vs 产物平面，绝不混用」规矩；插件源码的改动必须重新构建才能生效。

**在开发条件下把 `exports["."]` 指向 `src`，或增加 `src` 回退。** 否决：这会改写发布产物的解析契约，而 `src` 不在任何包的 `files` 中，已安装的消费者无法解析它。

**修改 vendored 加载器的 `tree.import`，让其优先走环境管道。** 否决：源码与产物之分是 dsh 运行时关注点，不是加载器的关注点；把改动留在 `packages/boot/app-boot` 可避免每次 vendor 同步都要重新应用的 vendored 修改。

**只看环境投影就重定向，不参考入口自己的位置。** 否决：即使组合用自己 `node_modules` 里的副本遮蔽了该包名，也会加载工作区包，使组合丢掉自己拥有的覆盖。`app-boot` 套件有用例钉住这一点，在该判据下会失败。

## 影响

源码启动从 `src` 加载工作区与 vendored 插件，每个包只保留一个模块实例，`unique symbol` 服务键可跨插件边界解析；就地修改插件源码无需重新构建即可生效，与既定的零构建回路一致。组合仍可用自己 `node_modules` 里的副本遮蔽 harness 包名，安装在 profile 里的树外插件也继续从那里解析。打包与已安装运行不受影响，因为在 tsconfig `paths` 不会把标识符投影到 `node_modules` 之外的地方，该包装器不起作用。此修复还暴露出一处被崩溃掩盖的既有快照期望值漂移：memory 特性注册了 `hindsight_remember` 与 `hindsight_search` 并注入 memory 系统提示，但记录的 headless 工具目录早于它们，因为在运行崩溃时无法完成刷新。这些期望值属于 memory 改动，不属于本次改动。

## 测试

`packages/boot/app-boot/tests/app-boot.spec.ts` 覆盖了判据的两半：源码启动下工作区插件经由同一模块实例解析；组合用自己 `node_modules` 里的副本遮蔽 `@deepseek-ai/dsh-system-prompt` 时保留该副本。`packages/boot/app-boot/tests/source-plane.spec.ts` 通过注入的解析器驱动判据，因为环境答案是进程级状态、并发套件能改变它：直接断言环境答案会单独跑通过、在全量车道上失败。每个分支各有一对固定解析结果：相对、绝对、import-map 与内建标识符，两个平面都无法解析的标识符，两个平面都解析进检出的工作区包，以及 `node_modules` 下组合自有的副本。`snapshots/session`、`snapshots/sdk`、`snapshots/acp` 的无密钥录制会话复放跑的是真实子进程启动向量；拆掉包装器会在那里重新出现 `prepare` 崩溃。
