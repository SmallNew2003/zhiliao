# Zhiliao Logo Assets

English | [中文](README.zh.md)

The primary mark was redrawn from six AI concept images (the `zhiliao-logo.miora` board) into a single-line vector 「了」 plus an orange dot. It carries three meanings: the product name 「知了」 (cicada), the colloquial 「知道了」 (understood), and the punctuation 「了·」 (task complete). The orange dot at the upper right is the cicada's head and the full stop of a completed task.

## File inventory (`svg/`)

| File | Purpose |
| --- | --- |
| `mark.svg` | Primary mark for light surfaces (transparent background, deep forest green strokes + orange dot) |
| `mark-on-dark.svg` | Primary mark for dark surfaces (eggshell strokes + orange dot) |
| `mark-mono.svg` | Monochrome version (all #111, for stamps / watermarks / single-color printing) |
| `icon.svg` | App icon 1024×1024 squircle (night forest gradient background + eggshell mark) |
| `favicon.svg` | Site favicon (96 viewBox; inverts automatically under `prefers-color-scheme: dark`) |
| `lockup-zh.svg` | Horizontal lockup: mark + 「知了」 |
| `lockup-en.svg` | Horizontal lockup: mark + `zhiliao` |
| `lockup-vertical.svg` | Vertical lockup: mark + 「知了」 + `ZHILIAO` |

The Chinese and English lettering in the lockups is fully outlined as pure vector paths in the Monoline Minimalist style, so the artwork no longer depends on system fonts and aligns pixel-for-pixel on every platform with zero dependencies.

## Palette

| Name | Value | Use |
| --- | --- | --- |
| Deep Forest | `#1F4A3D` | Primary stroke ink |
| Night Forest | `#265543 → #1B4334` | Icon background |
| Mint | `#3FBE9E` | Secondary accent |
| Cicada | `#F28A2E` | Dot accent only; never fill a large area with it |
| Eggshell | `#F5F2EC` / inverted strokes `#F2EFE8` | Stroke color on light / dark surfaces |

## Usage rules

- Minimum mark size: 16px for the favicon and 24px for the icon; below that, keep the green strokes and drop the orange dot.
- The dot's position and size are part of the mark: never move, scale, or recolor it on its own.
- Use `mark-on-dark.svg` on dark surfaces; the stroke color is `#F2EFE8`, not pure white.
- Use `mark-mono.svg` in monochrome scenarios (the dot turns monochrome too); the two-color form is not retained.
- Keep clear space of at least 25% of the mark's width on all sides.

## Application integration

- Web favicon: `apps/web/public/favicon.svg` already carries the outlined mark, including automatic inversion under `prefers-color-scheme: dark`.
- Desktop: `apps/desktop/resources/icon*.svg/png` and the tray icon come from the G3 gradient app-icon design, not from `icon.svg` in this directory; export platform sizes from that source.
