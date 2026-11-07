---
kind: upgrade-guide
description: "知了使用独立产品版本和产品 tag，不再沿用 DSH 发布标识。"
---

# 使用知了产品版本与发布 tag

[English](guide.md) | 中文

## 变更

知了的独立产品线从 `0.1.0` 开始，首个预览为 `0.1.0-alpha.1`。上游 `0.2.2-alpha.2` 标识代码基线，不是应用版本；关于面板分别显示这两个值。仓库停止 DSH 的 npm 发布 workflow；从 npm 安装同名包不会得到本产品构建。

新的产品 tag 使用 `zhiliao-v*`。Desktop 两种打包 preset 均拒绝继承的 `dsh-v*` 来源 tag。已有保留记录仍可读取，旧 test 产物仍可复核与发布；production 发布要求 `master` 或知了产品 tag。

## 迁移

1. 构建本 checkout 或安装其 Desktop 产物。Apple Silicon 本地构建使用 `pnpm run package:desktop:mac:arm64:unsigned --build-version 0.1.0-alpha.1`。替换应用时保留原用户数据；版本重新起算不改变 Session 格式。
2. 新发布 tag 与来源选择使用 `zhiliao-v<产品版本>`。旧 production 产物应从受支持来源重新构建，不再用继承的 DSH tag 重发。
3. 在关于面板确认产品版本为 `0.1.0-alpha.1`、上游基线为 `0.2.2-alpha.2`。版本归属与本地构建要求见[版本线决策](../../../../.agents/notes/implemented/process/2026-10-31-zhiliao-own-version-line.zh.md)和 [Desktop 打包指南](../../../../apps/desktop/packaging/README.zh.md)。
