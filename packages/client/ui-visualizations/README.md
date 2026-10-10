---
description: "Inline HTML, ECharts and Mermaid previews with isolated execution, source viewing, date-stamped downloads and deployment limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-visualizations

English | [中文](README.zh.md)

## Summary

View explicitly marked HTML panels, ECharts charts and Mermaid diagrams inside assistant replies. Switch between Preview and Source, enlarge the active frame, and download original source or supported exports. Interactions stay local to the preview; reopening an evicted document restores authored initial values. Ordinary code remains source.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package with the Web Host, assistant Chat renderer, locale and theme providers. The Host injects validated limits into the browser index; the Client requires that injection before registering its assistant-only chain selector.

Only top-level closed assistant fences execute: `html preview runtime=dsh-v1`, `html preview runtime=dsh-v1 libs=echarts`, or `mermaid preview runtime=dsh-v1`. Unknown or duplicate metadata produces a local diagnostic with readable source. Open fences show generation status and never load runtime assets.

| Config field | Default | Meaning |
|---|---|---|
| `maxSourceBytes` | `262144` | UTF-8 source bytes per block |
| `maxExportBytes` | `33554432` | Complete decoded download bytes |
| `maxActiveFrames` | `4` | Active documents across this Client registration |
| `minHeight` / `maxHeight` | `180` / `640` | CSS pixel height range; larger content scrolls inside |
| `readinessTimeoutMs` | `15000` | Readiness and export-response deadline |

Limits are positive integers; `minHeight` must not exceed `maxHeight`. Reload the browser page to adopt changed Host limits. Viewport eviction and explicit activation enforce the global budget. Source/Preview switching and enlargement retain the active iframe and its input values.

HTML downloads embed Bootstrap and every declared library and restore initial source. Mermaid exports SVG; charts created through `dsh.chart(element, option)` export PNG with a chooser for multiple charts. Exports require user actions and use sanitized titles, local `YYYYMMDD` dates and `_02` sequences for repeated names. Source remains downloadable when execution is unavailable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [manifest](src/runtime-manifest.ts) fixes Bootstrap 5.3.8, ECharts 6.1.0 and Mermaid 11.16.0 for `dsh-v1`. Kind-specific source chunks load lazily; only immutable library bytes are shared. Build output retains library licenses, ECharts notices and its d3 license, and Popper/zrender licenses. The browser entry contains no library implementation.

The [document builder](src/client/runtime/document.ts) places a restrictive CSP before trusted bootstrap code. The opaque `allow-scripts` frame creates its own packaged script Blob URLs, installs a private generation-bound port, then runs authored content. The [bridge](src/client/runtime/bridge.ts) accepts bounded readiness, height and error messages, plus a frame-local Escape notification that only dismisses enlargement and only requested MIME-checked exports; it provides no Host dispatcher. Disposal retires ports, deadlines, observers and pending readers.

The [preview](src/client/Preview.tsx) consumes framework-bound theme and budget snapshots. Bootstrap receives public colors and typography; `dsh.chart` applies visual defaults, returns the native ECharts instance and owns resize/disposal. Theme updates preserve authored HTML and chart interactions. Mermaid renders with strict security inside the frame; its SVG never enters the application DOM.

No runtime invariant companion is published because frame state and budget identity have one Client registration owner; there is no independent Host observation to compare. Focused lifecycle tests cover registration disposal, retired generations and bounded activity; built-runtime e2e checks verify the manifest, lazy chunks, licenses and standalone classic scripts.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Chat](../ui-chat/README.md) — assistant fence ownership.
- [Slots](../../../docs/subsystems/slots.md) — derived props and effect lifetimes.
- [Testing](../../../docs/testing.md) — source and artifact checks.

-----

<a id="model-experience"></a>
## Model Experience

### Assistant source

#### What the model sees

The viewer adds no prompt, tool schema or Session event. The existing assistant message contains complete source, inline data, runtime identifier `dsh-v1` and declared libraries; rendering reads that text.

#### Token effect

Preview controls and interaction state consume no model tokens. Authored source remains part of the ordinary assistant reply.

#### KV Cache effect

Rendering and downloads do not alter recorded messages or model requests. Existing assistant text retains its ordinary history and cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Browser isolation has these limits.

- Script-driven self-navigation can leave the controlled document; the next load retires its channel and exposes Reload and Source. CSP is not a universal navigation firewall.
- A main-thread busy loop can block the browser and its readiness timer. Stronger CPU confinement requires another runtime.
- Input values, filters and DOM state are transient. Eviction, retry and conversation reopening restore initial source. Arbitrary HTML has no image export; only helper-owned ECharts charts support PNG.
- Remote resources, fetches, workers, nested frames, Host access, package installation and JSX compilation are unavailable. Downloaded HTML executes in the user’s browser outside the application iframe.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
