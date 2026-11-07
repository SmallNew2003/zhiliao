# Agent Note: 知了自己的版本线与旁记的上游基线

Status: implemented

[English](2026-10-31-zhiliao-own-version-line.md) | 中文

## 问题

工作区版本号随每次上游同步一并到来：根与 released manifest 都写着 `0.2.2-alpha.2`，发布 tag 前缀是 `dsh-v`，`dsh` 序列向 npmjs.org 发布 `@deepseek-ai/dsh-*`。这条版本线没有任何一部分属于本产品。

有三个事实要求独立发布政策。上游用同一批包名发布，且已经发到 `0.2.2-alpha.2`；以这些包名发布本产品，会与独立发布的另一产品共用注册表版本和 dist-tag。`dsh-v*` tag 命名空间是上游的，从本仓库切出的 tag 与他们的无法区分。而版本号本身不说明这棵树包含哪个上游提交，对照上游核验缺陷报告的读者需要这个信息。

## 决策

### 版本线起点为 `0.1.0`

`release:dsh` 接受显式产品版本，并把它写进可发布族、`packages/*/*` 下每个私有包、各应用以及 workspace 根。`verify-version-sync` 要求每个 released manifest 等于根版本。首个预览使用 `0.1.0-alpha.1`；后续 bump 跟随本产品的发布决策。

取 `0.1.0` 而非 `1.0.0`，因为公共 API 尚处预稳定阶段、能力主题仍未裁决，`1.0.0` 会承诺这棵树并不具备的稳定性。取 `0.1.0` 而非 `0.0.2`——后者会续上本仓库 2026 年 8 月自己的 `0.0.x` 线——因为那条线描述的是初始 monorepo，而当前这棵树已是完整产品。取 `0.1.0` 而非高于上游的数字，因为那样产品的版本号就要跟着上游的发版节奏走，正是要解除的耦合。

首个发布带预发布段 `0.1.0-alpha.1`，在未裁决主题与上游吸收持续期间使用；`release:dsh` 接受它作为显式版本。`dsh` 序列没有 npm 发布步骤，因此 npm dist-tag 不决定其分发通道。

### 发布 tag 前缀为 `zhiliao-v`

`DshFamily.tagPrefix` 返回 `zhiliao-v`，取代 `dsh-v`。`bump.ts` 按前缀读取最新 tag 来推导下一个版本，因此新前缀让继承来的上游 tag 不可见，版本线从 manifest 版本起算。`verifyTag` 只在 `RELEASE_PUBLISH` 下运行，而拉取请求的 `release.yml` 不设置该变量，所以没有 PR 检查依赖此前缀。

### `dsh` 序列停止向 npm 发布

删除 `.github/workflows/release-publish.yml`。`release.yml` 保留无凭据的 `pack` 与依赖布局校验，它们在每个拉取请求和 master push 上运行，正是用来证明发布集仍能完整打出并能安装的部分；发布曾是该序列唯一带凭据的动作。`vendor` 与 `native` 保留各自的发布工作流，`release:publish` 也保留，因为 `vendor` 序列要调用它。

`@deepseek-ai/dsh-*` 从此不再收到来自本仓库的版本。注册表中已有版本保留为历史发布；本仓库既不删除它们，也不再移动其 npm dist-tag。

### 上游基线记录在版本号旁

版本号不再编码这棵树包含哪个上游提交，因此单独记录所吸收的上游基线：

| 字段 | 值 |
|---|---|
| 上游版本 | `0.2.2-alpha.2` |
| 上游源 | 2026-11-02 基线合并的第二父提交；上游截至 2026-10-30 |
| 基线发布 | 该父提交可达的最新上游 tag：`dsh-v0.2.2-alpha.2` |

桌面应用的关于对话框在上游基线旁同时显示产品版本号，读者无需查阅本记录即可判断某个构建包含哪份上游代码。对话框展示的取值是 `apps/desktop/src/upstream-base.ts` 中的 `UPSTREAM_BASE_VERSION`；吸收新的上游基线时同时更新该常量与上表。

### 吸收上游时保留产品版本

[产品线政策](../architecture/2026-11-03-zhiliao-product-line.zh.md)以选择性吸收取代整分支同步。吸收的改动必须让根与 released manifest 保持当前产品版本；既不重置为 `0.1.0`，也不采用上游版本。`verify-version-sync` 检查一致性，不判断版本是否属于产品线。

## 后果

读者无法把本产品的版本与上游的排序：`0.1.0` 低于 `0.2.2-alpha.2`，而这棵树正包含后者。该映射由关于对话框与本记录共同承载。

`npm install @deepseek-ai/dsh-session` 解析到的是上游的发布，不是本产品的构建。桌面应用、安装包与 Web 部署分发本产品；注册表包名不标识本产品的本地构建。

tag 保留一个版本并标识其提交。从本仓库切 `zhiliao-v*` tag 从此没有歧义，继承来的 `dsh-v*` tag 继续归属上游。

## 考虑过的替代方案

沿用上游版本线被否决：版本号随后按上游的节奏前进，tag 命名空间也仍然共用。

改编号到 `0.3.0` 以便继续在 `@deepseek-ai/dsh-*` 下发布被否决：这仍把产品版本绑在上游节奏上，并继续与一个独立发布的产品共用包名。

把包改名到 `@zhiliao/*` 作用域在本次改动中被否决：工作区 manifest、每条同级 `peerDependencies`、import、快照与文档都带着现名，而本产品分发并不需要注册表。

## 关联决策

[npm 发布序列](2026-08-10-npm-release-sequences.zh.md)仍负责各族独立版本、工作区依赖范围、打包及 vendor/native 发布保证；本决策仅取代其中的 `dsh` npm 发布和上游版本/tag 政策。[构建/检查拆分](2026-10-11-build-artifacts-check-split.zh.md)保留独立的编译器覆盖与调度理由。[产品线决策](../architecture/2026-11-03-zhiliao-product-line.zh.md)负责上游选择性吸收和主线政策。
