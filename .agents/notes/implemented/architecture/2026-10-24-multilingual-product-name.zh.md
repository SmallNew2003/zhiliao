# Agent Note: Multilingual product name

Status: implemented

[English](2026-10-24-multilingual-product-name.md) | 中文

## Problem

本仓库以自己的名称发布，但所有用户可见面仍带着上游产品名「DeepSeek Harness」：桌面端关于面板与更新对话框、Windows 安装器字符串、浏览器标题、PWA 安装名、CLI 帮助文本、插件安全与文档预览提示、设置页欢迎语，以及整棵文档树。上游品牌规范要求第三方项目不要在产品名中使用完整的「DeepSeek Harness」商标，因此这既是一处一致性问题，也是商标风险。

## Decision

**产品名中文为「知了」，英文为 Zhiliao。** 中文正文写「知了」，英文正文写 Zhiliao。对中英文共用同一个字符串的面——打包后的应用名、产物文件名、官方客户端构建标题、PWA 清单名——统一用 Zhiliao：这一拉丁形式在文件系统、安装器和代码签名下都安全。

**浅层覆盖用户会读到的名称。** 包括 locale 字典、桌面端外壳与 Windows 安装器、浏览器与 PWA 标题、CLI 帮助文本、skill 描述、各包 README，以及文档树。`dsh`、`DSH_*`、`@deepseek-ai/dsh-*`、`~/.dsh` 与 `~/.deepseek-harness` 保留原标识符：它们命名的是命令、环境变量、包和数据根目录，不是产品。正文中「其他正在运行的 DSH」仍写 DSH，因为它指的是正在运行的运行时实例。

**逐字镜像源码的块跟随源码用词。** `ts type-equiv` 块与生成的目录块引用的是源码 JSDoc，因此本层在这些源码注释移动前不改写它们；只改文档会让配对门禁和类型等价门禁失败。

**术语表承载这一映射。** `docs/i18n/terminology.md` 记录 知了/Zhiliao，后续翻译与编辑不必重新推导。

## Alternatives considered

**把产品名统一改成 `dsh`。** 未采纳：该缩写已经命名 CLI 命令和运行中的运行时，同一个 `dsh` 会让「其他正在运行的 DSH」和「产品本身」在同一句话里无法区分。

**在同一轮里改掉 npm scope、CLI 和环境变量。** 本层未采纳：294 个包名、约 13,700 处源码引用、所有消费方的 lockfile 和录制会话夹具需要一起移动，那是另一项有独立验证成本的改动。

**给打包应用名做本地化。** 暂缓：electron-builder 只接受一个 `productName`，按语言区分的 bundle 显示名需要 macOS 上按语言的 `InfoPlist.strings` 和 Windows 上本地化的安装器名。

## Consequences

中英文用户现在读到同一个产品名，本 fork 也不再把上游商标当作自己的产品名呈现。代价是过渡期的混合存量：源码 JSDoc、系统提示词中的身份句、SDK 类名 `DeepSeekHarness` 与 `HarnessClient`、SDK 运行时错误串、侧边栏字标 artwork，以及录制会话夹具仍写 DeepSeek Harness；它们各自跟随自己的门禁移动——系统提示词随快照重录，SDK 类名随 API 评审，artwork 随设计改动。
