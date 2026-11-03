# Agent Note: 知了产品线

Status: implemented

[English](2026-11-03-zhiliao-product-line.md) | 中文

## 问题

本仓库以「跟随 `upstream/master`」的方式维护：每一轮把整个上游分支合并或 rebase 到本地品牌与交互改动之上。上游的 CI 拓扑（原生 Windows 车道、master 专属 Wine 门禁、Windows 打包链）在这里没有可验证的运行环境，门禁长期为红且要持续适配；整支同步也让每次评审变成数千提交，冲突只能靠重录 golden 收敛。产品需要一条能自己排期、自己定版本的主线。

## 决策

`upstream` 远端只作参考：`git fetch upstream` 用于读取上游提交；产品线的已发布历史不再 rebashe 到上游、不做整支同步、也不保留长期存在的 `chore/upstream-sync-*` 分支。`master` 是唯一主线，用产品 tag 标注版本（首个基线为 `zhiliao-v0.1.0-alpha.1`，与知了独立版本线的 tag 前缀一致），上游版本号只作为该基线的来源记录。

仍会选择性吸收三类上游改动：

- **安全与正确性修复**：凭据处理、沙箱逃逸、路径穿越、注入、崩溃与数据损坏。
- **provider 协议与模型目录**：新模型 id、请求/响应字段、流式事件变化。
- **格式与持久化迁移**：`SESSION_FORMAT_VERSION` 演进、SQLite schema、对已发布 session 的兼容读取。

吸收判定：能单独 pick、不触碰品牌资产与 client 文案、不改变 CI 与发布拓扑、不引入 Windows 环境假设 → 吸收；否则拒绝，或先改写再吸收。吸收流程：拉取上游 → 把该提交 pick 到短期分支 → 跑受影响包的最小验证面（对应 vitest、`build:check`、`doc-sync`）→ 单独开 PR 进 `master`。

上游的 Windows 结构已撤回：删除 `ci-windows.yml`、`windows-package.yml`、`scripts/wine-windows-gates.sh`、`scripts/windows-package-workflow.spec.ts` 与三个 `check:ci:windows-*` 入口加 `check:windows-wine`，并移除 `ci-master.yml` 的 windows 作业与 Wine 门禁调用、`ci.yml` 中提及 Windows 判定名的注释；`ci-python.yml` 只保留 `node24-linux-x64` 目标，桌面发布只保留 `mac-arm64` 与 `mac-x64`。该撤回取代 [跨平台 CI 参考](../process/2026-07-21-serial-cross-platform-ci-reference.zh.md)、[原生 Windows PR CI](../process/2026-08-08-native-windows-pull-request-ci.zh.md)、[托管 Windows Python 运行时](../process/2026-09-06-python-runtime-windows-hosted.zh.md) 与 [Blacksmith 故障切换支路](../process/2026-09-09-blacksmith-failover-leg.zh.md) 中与 Windows 有关的段落；它们其余内容——master 平台分工、Linux 故障切换、发布链——仍然生效。Windows 运行时源码与签名文档不在撤回范围内，`apps/desktop` 的打包与签名 README 仍描述 Windows 流程，清理留待单独 change。

## 考虑过的替代方案

**继续整支同步上游分支。** 差异最小，上游修复免费获得；但每轮都要对数千提交重跑整套门禁，而 Windows 一类改动会持续给本仓库带来无法验证的红项。

**保留 Windows 作业但设为不阻塞。** 信号还在、冲突面小；但作业仍要运行并消耗额度，其失败又永远无人处理，只会积累噪声。

**镜像上游、产品改动以 overlay 形式发布。** fork 与上游完全一致；但品牌、交互与发布链改动会落在构建与测试之外，测试也就不再覆盖真实产品行为。

## 影响

主线不再携带上游后续提交；任何吸收都变成一次带验证的显式挑选，每轮同步多一次人工判定。换来的是：门禁只覆盖产品真正运行的平台，上游重构不再反复触发 golden 重录，发布节奏归产品自己掌握。上游仍然可读，`upstream/master` 保留为只读参考。

## 相关

- 基线合并：`master` 以一个合并提交纳入上游 `master` 的 HEAD，该 HEAD 处可达的上游最新发布 tag 为 `dsh-v0.2.2-alpha.2`（基线之后上游还发布了 `dsh-v0.2.2-alpha.3`，不在本基线内），该合并提交的第二父即此上游 HEAD；基线 tag 为 `zhiliao-v0.1.0-alpha.1`。同步分支对应的 PR #45 至今未合并。
- 撤回记录：Windows 移除随 `chore(ci): 移除 Windows 门禁与打包工作流` 落地。
- 遗留项：`apps/desktop/README.md` 仍有 49 处 Windows 提及未清理；`apps/desktop/packaging/README.md` 随本次撤回从 37 处降到 21 处（删除的段落链向已移除的 `windows-package.yml`）；`apps/desktop/publishing/ci/README.md` 从 12 处降到 11 处（删掉的是 `Windows uses target win-x64` 一句），余下部分留待单独 change。
- 不写升级指南：本产品线在 `origin` 上无已发布 tag，且 `windows-package.yml` 是手动触发、走自托管 `dsh-win-package-trial` label 的工作流，没有已发布表面被破坏。
