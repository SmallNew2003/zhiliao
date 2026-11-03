# Zhiliao logo assets

English | [中文](README.zh.md)

The primary mark condenses six AI concept images (the `zhiliao-logo.miora` board) into a single-line vector `了` glyph plus an orange dot. It carries three meanings: the product name Zhiliao (cicada), the spoken "got it", and the punctuation that ends a finished task. The orange dot in the upper right is the cicada's head and the period that closes a task.

## File inventory (`svg/`)

| File | Purpose |
| --- | --- |
| `mark.svg` | Primary mark for light surfaces (transparent background, deep forest green strokes plus orange dot) |
| `mark-on-dark.svg` | Primary mark for dark surfaces (eggshell strokes plus orange dot) |
| `mark-mono.svg` | Monochrome version (all `#111`, for stamps, watermarks, and monochrome print) |
| `icon.svg` | App icon, 1024×1024 squircle (night forest gradient background plus eggshell mark) |
| `favicon.svg` | Site favicon (96 viewBox; includes `prefers-color-scheme: dark` auto-inversion) |
| `lockup-zh.svg` | Horizontal lockup: mark plus the Chinese wordmark |
| `lockup-en.svg` | Horizontal lockup: mark plus `zhiliao` |
| `lockup-vertical.svg` | Vertical lockup: mark plus the Chinese wordmark plus `ZHILIAO` |

The Chinese and English lockup text is fully converted to the Monoline Minimalist outline format, so it no longer depends on system fonts and renders pixel-identically on every platform.

## Palette

| Name | Value | Use |
| --- | --- | --- |
| Deep Forest | `#1F4A3D` | Primary stroke ink |
| Night Forest | `#265543 → #1B4334` | Icon background |
| Mint | `#3FBE9E` | Secondary accent |
| Cicada Orange | `#F28A2E` | Finishing dot (the circle only; never large areas) |
| Eggshell | `#F5F2EC` / inverted strokes `#F2EFE8` | Light backgrounds / stroke color on dark backgrounds |

## Usage rules

- Minimum mark sizes: 16px for the favicon and 24px for the icon; below that, use only the green strokes without the orange dot.
- The orange dot's position and size are part of the mark; never move, scale, or recolor it on its own.
- On dark surfaces use `mark-on-dark.svg`; the stroke color is `#F2EFE8`, not pure white.
- Monochrome contexts use `mark-mono.svg` (the orange dot becomes monochrome too); the two-color version does not survive.
- Keep clear space around the mark of at least 25% of the mark's width.

## Application integration (follow-up PRs, not yet executed)

- Web favicon: replace `apps/web/public/favicon.svg` (also sync `apps/web/dist/` and the related expected snapshots).
- Desktop: export the platform sizes under `apps/desktop/resources/icon*.svg/png` from `icon.svg` (the macOS rounded-corner mask keeps the existing icon-macos structure).
