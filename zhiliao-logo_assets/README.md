# 知了（zhiliao）Logo 资产

主标志由 6 个 AI 概念图（`zhiliao-logo.miora` 看板）收敛重绘为单线矢量「了」字 + 橙点。三重含义：产品名「知了」（蝉）、口语「知道了」（听懂）、句读「了·」（任务完成）。右上橙点为蝉首 / 任务完成句点。

## 文件清单（`svg/`）

| 文件 | 用途 |
| --- | --- |
| `mark.svg` | 主标志，浅色表面（透明底，深林绿笔画 + 橙点） |
| `mark-on-dark.svg` | 主标志，深色表面（米白笔画 + 橙点） |
| `mark-mono.svg` | 单色版（全 #111，用于盖章/水印/单色印刷） |
| `icon.svg` | 应用图标 1024×1024 squircle（夜林渐变底 + 米白标志） |
| `favicon.svg` | 站点 favicon（96 viewBox；含 `prefers-color-scheme: dark` 自动反白） |
| `lockup-zh.svg` | 横排组合：标志 + 「知了」 |
| `lockup-en.svg` | 横排组合：标志 + `zhiliao` |
| `lockup-vertical.svg` | 竖排组合：标志 + 「知了」 + `ZHILIAO` |

lockup 中的文字依赖系统字体（PingFang SC / Avenir Next 等），正式发布前应转曲（outline）固化。

## 色板

| 名称 | 色值 | 用途 |
| --- | --- | --- |
| 深林绿 Deep Forest | `#1F4A3D` | 笔画主墨 |
| 夜林渐变 Night Forest | `#265543 → #1B4334` | 图标底 |
| 薄荷青 Mint | `#3FBE9E` | 辅助点缀（次级强调） |
| 知了橙 Cicada | `#F28A2E` | 点睛（圆点专用，勿大面积使用） |
| 米白 Eggshell | `#F5F2EC` / 笔画反白 `#F2EFE8` | 浅底 / 深底上的笔画色 |

## 使用规则

- 标志最小尺寸：favicon 16px、图标 24px；再小请只用绿色笔画去掉橙点。
- 橙点位置与大小是标志的一部分，不得单独移动、放大或改色。
- 深色表面上用 `mark-on-dark.svg`；笔画色 `#F2EFE8`，不要用纯白。
- 单色场景统一使用 `mark-mono.svg`（橙点同为单色），不保留双色。
- 标志周围留白不小于标志宽度的 25%。

## 接入应用（后续 PR，尚未执行）

- Web favicon：替换 `apps/web/public/favicon.svg`（注意同步 `apps/web/dist/` 与相关 expected 快照）。
- 桌面端：`apps/desktop/resources/icon*.svg/png` 需从 `icon.svg` 导出各平台尺寸（macOS 圆角遮罩沿用现有 icon-macos 结构）。
