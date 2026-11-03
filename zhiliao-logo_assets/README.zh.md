# 知了（zhiliao）Logo 资产

[English](README.md) | 中文

主标志由 6 个 AI 概念图（`zhiliao-logo.miora` 看板）收敛重绘为单线矢量「了」字 + 橙点。三重含义：产品名「知了」（蝉）、口语「知道了」（听懂）、句读「了·」（任务完成）。右上橙点为蝉首，也是任务完成的句点。

## 文件清单（`svg/`）

| 文件 | 用途 |
| --- | --- |
| `mark.svg` | 主标志，浅色表面（透明底，深林绿笔画 + 橙点） |
| `mark-on-dark.svg` | 主标志，深色表面（米白笔画 + 橙点） |
| `mark-mono.svg` | 单色版（全 #111，用于盖章/水印/单色印刷） |
| `icon.svg` | 应用图标 1024×1024 squircle（夜林渐变底 + 米白标志） |
| `favicon.svg` | 站点 favicon（96 viewBox；`prefers-color-scheme: dark` 下自动反白） |
| `lockup-zh.svg` | 横排组合：标志 + 「知了」 |
| `lockup-en.svg` | 横排组合：标志 + `zhiliao` |
| `lockup-vertical.svg` | 竖排组合：标志 + 「知了」 + `ZHILIAO` |

lockup 中的中英文字体已全部完成「单线等宽同构体 (Monoline Minimalist)」纯矢量转曲（outline）固化，不再依赖系统字体，实现全平台 100% 像素级对齐与 0 依赖。

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

## 接入应用

- Web favicon：`apps/web/public/favicon.svg` 已是转曲后的标志，`prefers-color-scheme: dark` 下自动反白。
- 桌面端：`apps/desktop/resources/icon*.svg/png` 与托盘图标来自 G3 渐变应用图标设计，并非由本目录的 `icon.svg` 导出；各平台尺寸请以那一份为源。
