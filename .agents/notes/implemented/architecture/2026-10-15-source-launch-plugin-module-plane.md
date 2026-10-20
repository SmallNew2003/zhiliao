# Agent Note: Source-launch plugin module plane

Status: implemented

English | [中文](2026-10-15-source-launch-plugin-module-plane.zh.md)

## Problem

Any headless run that calls a tool failed with `dsh: UNKNOWN: Cannot read properties of undefined (reading 'prepare')`, while a run that called no tool succeeded. During a source launch `@deepseek-ai/dsh-tools` loaded as two module instances: the `tools` plugin entry resolved to `packages/core/tools/lib/index.js`, and `packages/core/agent-loop/src/tool-calls.ts` imported the same package from `packages/core/tools/src/index.ts`. `TOOL_RUNTIME_SCHEDULER` is a `unique symbol`, so each instance generated its own identity. The artifact-plane instance constructed `ToolRuntime` and registered `ctx.tools` under its symbol; `tool-calls.ts` read the service with the source-plane instance's symbol, so `ctx.tools[TOOL_RUNTIME_SCHEDULER]` evaluated to `undefined`. The defect is source-launch-only: a packaged run has no tsx, so the plugin entry and the in-graph import both resolve through `exports` to `lib` and share one instance.

## Decision

A source launch — the case where [`boot()`](../../../../packages/boot/app-boot/src/index.ts) receives no `bareModuleBaseUrl` — loads workspace and vendored plugin entries through the ambient module pipeline, the same tsconfig-`paths` projection the rest of the graph already uses, instead of Node's internal ESM loader. [`source-plane.ts`](../../../../packages/boot/app-boot/src/source-plane.ts) installs a source-plane wrapper over `loader.internal`: a bare plugin specifier redirects to a plain dynamic `import()` only while the plugin entry's own location resolves that specifier outside `node_modules`. Specifiers the ambient pipeline cannot project, specifiers the entry's own location resolves under `node_modules`, and relative or builtin specifiers stay on the internal loader. Packaged runtimes pass a `bareModuleBaseUrl` and keep the internal loader for every bare specifier, so their resolution is unchanged. The predicate lives in its own module rather than beside `boot()` so the per-file coverage gate measures it directly, and it reads an injected resolver whose default is the ambient one, so the unit suite never depends on ambient resolution state.

The entry-location condition is what keeps the wrapper from taking over a resolution the configuration owns. tsx projects a bare specifier to the workspace `src` entry regardless of the importer, so the projection alone cannot tell a workspace package from a composition that shadows a harness package name with its own `node_modules` copy. Resolving the specifier from the profile base URL — the profile resolution router's own answer during a launch — separates them: a workspace package resolves into its checkout, while a shadow resolves into the composition's `node_modules` and keeps its own copy.

This extends the [source launch through the tsx ESM hook](2026-07-29-dsh-source-launch-tsx-esm.md) decision: that note routes the CLI graph through tsx `paths`, and this one routes the plugin entries the loader mounts through the same projection so one package cannot resolve to both planes in a single launch.

## Alternatives considered

**Resolve the whole source-launch graph to `lib` by dropping tsconfig `paths`.** Rejected: it erases the zero-build source loop the source launch exists for and breaks the "source plane vs artifact plane, never mixed" rule; a plugin's source edit would need a rebuild before it took effect.

**Point `exports["."]` at `src`, or add a `src` fallback, under a development condition.** Rejected: it rewrites the published resolution contract, and `src` is absent from every package's `files`, so installed consumers cannot resolve it.

**Edit the vendored loader's `tree.import` to prefer the ambient pipeline.** Rejected: source-versus-artifact is a dsh runtime concern, not a loader concern; keeping the change in `packages/boot/app-boot` avoids a vendored modification that every vendor sync would have to re-apply.

**Redirect on the ambient projection alone, without consulting the entry's own resolution.** Rejected: it loads the workspace package even when the configuration shadows that name with its own `node_modules` copy, so a composition loses the override it owns. The `app-boot` suite has a case that pins this, and it fails under the projection-only predicate.

## Consequences

Source launches load workspace and vendored plugins from `src`, so each package keeps exactly one module instance and `unique symbol` service keys resolve across the plugin boundary; an in-place source edit to a plugin now takes effect without a rebuild, matching the documented zero-build loop. A composition may still shadow a harness package name with its own `node_modules` copy, and out-of-tree plugins installed in a profile keep resolving there. Packaged and installed runtimes are unchanged, because the wrapper is inert wherever tsconfig `paths` does not project a specifier outside `node_modules`. The fix also reveals a pre-existing snapshot expectation drift the crash had hidden: the memory feature registers `hindsight_remember` and `hindsight_search` and injects a memory system prompt, but the recorded headless tool catalogs predate them because no refresh could finish while the run crashed. Those expectations belong to the memory change, not this one.

## Testing

`packages/boot/app-boot/tests/app-boot.spec.ts` covers both halves of the predicate: a source launch resolves a workspace plugin through one module instance, and a composition that shadows `@deepseek-ai/dsh-system-prompt` with its own `node_modules` copy keeps that copy. `packages/boot/app-boot/tests/source-plane.spec.ts` drives the decision through an injected resolver, because the ambient answer is process-global state a concurrent suite can change: asserting it directly passes alone and fails on the full-suite lane. Each branch takes its own fixed pair of resolutions: relative, absolute, import-map, and builtin specifiers, a specifier either plane cannot resolve, a workspace package both planes resolve into its checkout, and a composition copy under `node_modules`. The keyless recorded-session replay of `snapshots/session`, `snapshots/sdk`, and `snapshots/acp` exercises the real subprocess launch vector; reverting the wrapper returns the `prepare` crash there.
