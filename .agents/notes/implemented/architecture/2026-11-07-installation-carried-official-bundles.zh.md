# Agent Note: 安装介质携带 Official 按需 bundle

Status: implemented

[English](2026-11-07-installation-carried-official-bundles.md) | 中文

## 问题

知了使用独立版本线，不向 npm 发布 DSH 家族。因此，把 Official bundle 作为精确注册表依赖提供，会请求注册表并不存在的产品版本。仅有离线发现不能让该 bundle 可安装。源码和打包安装还需要区分自己的提供方代码与同版本的其他安装。

## 决策

CLI 安装将所有 `ON_DEMAND_BUNDLES` 成员作为运行时依赖携带，包括 Codex、Claude Code 和 CUA。没有随附 profile 默认选择这些 bundle。无需导入提供方模块即可发现其元信息；安装时创建普通的 profile 自有依赖，复用既有选择与移除生命周期。

`officialBundleInstallTarget` 从当前运行的安装解析本地 `link:` 目标。打包安装必须声明该 bundle，并在自身逻辑 `node_modules` 树内解析。保存的链接保留逻辑安装路径，因此替换该路径背后的运行时不会让 profile 绑定到已退役的物理目录。源码安装从 CLI 的完整 checkout 解析指定工作区包。当前工作目录和版本后缀都不决定来源。

Desktop 通过 electron-builder 的 `extraResources` 将完整封装的 dsh 树复制到 `process.resourcesPath/dsh`（macOS 上为 `Contents/Resources/dsh`）。JavaScript、原生模块和 Office 依赖共用其中的物理 `node_modules` 树。`app.asar/dsh` 对 Electron 是虚拟目录，不能作为 `pnpm link` 来源：独立包管理器会报告 `ENOTDIR`。因此，原生文件也不使用单独的 `app.asar.unpacked/dsh` 树。外壳保留在 `app.asar` 中；包链接指向物理应用资源。在相同路径覆盖应用会保留这些稳定链接目标，用户数据和 profile 文件仍位于应用之外。移动应用或切换安装需要显式替换链接。

两条路径均在不导入提供方的前提下校验包身份、精确的运行中产品版本、公开 bundle 元数据、已构建入口和 bundle patch。缺失或不一致的文件会明确报错，要求修复 checkout 或重新安装应用；两条路径都不回退到 npm。移除 profile 依赖后，安装副本仍可供后续再次安装。

实验隔离仅豁免 CLI 安装指向获准按需 bundle 的已声明 `dependencies` 边。运行时导入、其他依赖段或消费方以及默认 profile 组合仍受隔离检查约束。携带 CUA 不会在默认产品中选择或加载其实验运行时。

[按需目录决策](2026-10-05-official-on-demand-bundles.zh.md)保留离线发现、元信息归属、显式替换和 profile 生命周期。本决策取代其中的注册表交付与安装依赖排除政策。[随附可选 bundle 决策](../process/2026-09-15-shipped-optional-bundles.zh.md)保留不同的政策：`OPTIONAL_BUNDLES` 由安装拥有，不能从 profile 移除；按需 bundle 则具有可移除的 profile 依赖。

## 考虑过的替代方案

**保留精确版本注册表交付。** 它要求发布产品的包版本，与[独立版本线政策](../process/2026-10-31-zhiliao-own-version-line.zh.md)冲突，也无法提供当前尚未发布的产品构建。

**产品版本不存在时使用其他发布的包。** 包名相同不代表提供方 API 或 bundle patch 兼容。使用安装自身已验证的文件可避免这一错配。

**把 dsh 树保留在 ASAR 中。** Electron 可以读取归档模块，但独立包管理器无法将虚拟目录用作链接来源。仅解包原生文件仍会让 JavaScript bundle 安装遇到相同错误。

**把携带的 bundle 当作不可移除的 optional bundle。** 分发文件和拥有 profile 选择是独立决策。保留普通 profile 依赖，才能维持显式安装、替换和移除。

## 后果

即使用户从不选择某个集成，安装仍携带其依赖。作为交换，选择 Official bundle 不再要求向 npm 发布产品版本。本地包操作仍可能失败，提供方认证和外部服务也保留各自要求；本地交付不保证提供方能够离线运行。源码安装需要准备依赖和最新构建输出。切换安装时，既有 profile 链接需要替换。

`official-install-target.spec.ts` 覆盖源码和打包目标、逻辑路径、不完整安装及真实离线 pnpm profile 操作。Official 目录生成器要求每个宣传的成员都是 CLI 直接依赖，并拒绝默认运行时导入按需提供方。已安装产品隔离测试拒绝声明的安装例外之外的实验运行时依赖边。Desktop 打包针对物理资源验证复制的描述符、文件清单、原生文件和 Host smoke；仅有源码级测试不代表已组装应用或已安装更新验收通过。Plugin Manager 的包 README 负责操作行为；[升级指南](../../../../docs/upgrade-guide/v0.1.0-alpha.1/installation-carried-official-bundles/guide.zh.md)负责用户迁移。
