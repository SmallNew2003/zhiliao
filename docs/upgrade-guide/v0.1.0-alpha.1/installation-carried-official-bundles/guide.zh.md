---
kind: upgrade-guide
description: "Official 按需 bundle 改用安装介质携带的本地链接，取代精确注册表版本。"
---

# Official 按需 bundle 使用当前运行的安装

[English](guide.md) | 中文

## 变更

从 Official 目录安装 Codex、Claude Code 和 CUA 时，现在使用当前应用安装携带的包。profile 记录本地 `link:` 依赖，不再向 npm 请求产品版本。既有注册表依赖或指向其他安装的链接，即使版本相同，也可能需要显式替换。第三方注册表安装和提供方认证保留既有行为。

Desktop 将完整运行时放在与 `app.asar` 并列的物理 `resources/dsh`（macOS 上为 `Contents/Resources/dsh`）。原生模块与 Office 依赖共用 `resources/dsh/node_modules`；链接不指向 ASAR 内部。在同一安装路径覆盖应用会保留这些稳定目标。用户数据和 profile 文件仍位于应用之外。

不完整的打包安装会报错，不再回退到 npm。源码安装要求完整且已构建的 checkout。移除 Official 按需 bundle 会移除 profile 依赖；安装介质提供的文件仍可使用。

## 迁移

1. 安装完整的更新后应用。源码 Web 或开发 Desktop 需要在运行中 CLI 的 checkout 执行 `pnpm install` 和 `pnpm run build`；选择其他工作目录不会切换提供方来源。
2. 打开插件页，检查 Official 条目提供的安装目标。未安装的 bundle 使用安装操作；既有注册表依赖或其他安装的链接，通过显式更新操作替换。若既有链接指向 `app.asar/dsh` 内部，或应用移至不同路径，也通过同一操作替换链接。收到提示时重启。替换失败可能让 bundle 处于未安装状态；修复报告的错误后重新安装。
3. 确认 profile 的 `package.json` 将该 bundle 记录为指向当前安装或 checkout 的 `link:` 依赖，且选中的 bundle 启动时没有加载错误。打包提供方文件缺失时，应重新安装应用，而非手动选择 npm 版本。外部认证与提供方访问仍需单独配置。仍须完成完整打包与已安装更新验收；仅有源码测试不能验证已安装应用。

[插件管理器](../../../../packages/boot/plugin-manager/README.zh.md#use-this-package)说明选择与移除操作；[交付决策](../../../../.agents/notes/implemented/architecture/2026-11-07-installation-carried-official-bundles.zh.md)记录安装归属。
