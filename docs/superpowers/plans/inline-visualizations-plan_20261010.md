# Inline visualizations implementation plan

English | [中文](inline-visualizations-plan_20261010.zh.md)

> For agentic workers: use the subagent-driven-development skill to execute these tasks sequentially, with independent task reviews. The user approved implementation on 2026-10-10; routine implementation decisions do not require another approval.

**Goal:** Render assistant-authored HTML panels, ECharts charts, and Mermaid diagrams inline, with reusable styles, exports, and matching model instructions.

**Architecture:** Pure Markdown exposes fenced-code metadata to an assistant-owned chain slot. One optional visualization plugin owns the sandbox runtime, controls, assets, configuration, and skill provider; the Web bundle composes it. Existing recorded assistant text remains the persistence owner.

**Tech Stack:** TypeScript, React, Cordis slots, Bootstrap 5.3.8, ECharts 6.1.0, Mermaid 11.16.0, Vitest, and repository browser tests.

**Spec:** [Approved design](../specs/inline-visualizations-design_20261010.md).

## Global Constraints

- Only explicitly marked top-level assistant fences execute: `html preview runtime=dsh-v1` or `mermaid preview runtime=dsh-v1`; HTML additionally accepts `libs=echarts`.
- Explicit fence closure is required even at end-of-input. Preserve frame identity across appended prose and stream settlement.
- Use `sandbox="allow-scripts"` without same-origin or Host access. Validate cross-frame messages and export bytes; keep remote dependencies out of authored output.
- Defaults: 256 KiB source, 32 MiB export, four active frames, 180–640 CSS-pixel frame height, and 15-second readiness timeout. Expose deployment tunables as validated configuration.
- Source/Preview switching and enlargement preserve an active frame; eviction and reopening restore authored initial state.
- All product copy uses typed locale dictionaries. Documentation is bilingual. Export and task-artifact names use YYYYMMDD.
- Use focused TDD and real browser evidence; do not run full unit or coverage suites. No push, merge, or publication is included.

## Task 1: Markdown extension and assistant slot

**Files:** Update `packages/client/ui-primitives/src/markdown/{MarkdownText.tsx,render.tsx,incremental.ts}`, its public index and README pair; update `packages/client/ui-chat/src/client/{contract/slots.ts,index.ts,chat/AssistantNodeView.tsx,chat/AssistantMarkdown.tsx,chat/register-node-renderers.ts}`, its README pair and the slot/conversation references. Add focused tests under both packages.

**Interfaces:** Export the following pure data and renderer types from ui-primitives; declare `conversation.chat.codeBlock` as a session-scoped chain slot owned by the assistant-step renderer. Its owner contains a `block: MarkdownCodeBlock`. The ordinary CodeBlock is the chain fallback.

```typescript
interface MarkdownCodeBlock {
  readonly code: string
  readonly language: string | undefined
  readonly meta: string | undefined
  readonly closed: boolean
  readonly sourceOffset: number
  readonly streaming: boolean
}
type MarkdownCodeBlockRenderer = (block: MarkdownCodeBlock, fallback: ReactNode) => ReactNode
```

- [ ] Write failing tests in `tests/markdown-code-block.client.spec.tsx`: a closed marked fence reaches the callback with raw metadata; an unclosed fence has `closed:false`; nested/quoted/indented code never invokes it. Capture a child mount counter and verify one mount across open → closed → appended prose → settled. Include CRLF and longer tilde/backtick fences.
- [ ] Run the focused test through `pnpm run test` with its exact file filter and record the expected pre-implementation failure.
- [ ] Add `renderCodeBlock?: MarkdownCodeBlockRenderer` to MarkdownText. Carry parser-confirmed top-level source positions and closure without rescanning the complete growing document per token. Invoke the callback around the existing fallback; preserve normal code, math, source copy, and all current consumers.
- [ ] Use `PropsRenderSlots` and `renderSlotChain` inside the assistant node; pass the renderer only to text blocks in AssistantMarkdown. Do not inject ReactNode-producing callbacks across plugin boundaries. Add a slot lifecycle test proving no-provider fallback and provider disposal restore ordinary source.
- [ ] Run the new tests plus the existing Markdown and assistant-renderer tests, update paired contracts, record their pairing, and commit the task. Export actual interface names in the report for Task 2.

## Task 2: Packaged sandbox runtime and preview UI

**Files:** Create `packages/client/ui-visualizations/` with package manifest, separate Host/Client compiler faces, tsdown configuration, `src/{config.ts,runtime-manifest.ts,index.ts,css-modules.d.ts}`, `src/client/{index.ts,protocol.ts,Preview.tsx,Preview.module.css,locales.ts,budget.ts,downloads.ts}`, and `src/client/runtime/{document.ts,bridge.ts,assets.ts,html-assets.ts,echarts-assets.ts,mermaid-assets.ts}`. Additional small files within this package may separate lifecycle responsibilities. Update aggregate compiler references and the lockfile. Add package README pair and owner-local tests.

**Interfaces:** Consume Task 1's chain slot. A pure `parsePreview(block)` returns `undefined` for ordinary blocks, or a discriminated valid/error preview value for explicitly marked HTML/Mermaid. The runtime manifest is shared with Task 3. A `loadRuntimeAssets(kind, libraries)` function resolves immutable packaged bytes lazily. The Host exports validated Config and injects its resolved values into the browser index; the Client reads that one resolved configuration.

```typescript
const runtimeManifest = {
  id: 'dsh-v1',
  libraries: { bootstrap: '5.3.8', echarts: '6.1.0', mermaid: '11.16.0' },
} as const
```

- [ ] Add failing protocol/config tests: required runtime, duplicate/unknown metadata, invalid library, oversized UTF-8 source, invalid limits, ordinary-code bypass, and unclosed-preview nonexecution. Add lifecycle tests for stale messages, explicit retry, cleanup, and bounded activity. Run these focused tests to establish RED.
- [ ] Implement the parser and validated limits from Global Constraints. Register the optional chain selector; invalid marked input selects a readable diagnostic, while ordinary code falls through. Match the existing webserver index-injection pattern for configuration.
- [ ] Bundle exact library versions into lazy source-string assets using the existing PDF raw-asset build pattern as a reference. Bootstrap includes bundled Popper/control code; Mermaid must be a self-contained browser build with strict rendering configuration. Keep dependency licenses in outputs; do not import Node APIs into Client runtime or libraries into chat startup.
- [ ] Construct an opaque allow-scripts frame with trusted bootstrap and CSP before authored HTML. Transfer a generation-bound MessagePort, validate protocol fields and payload sizes, and provide only ready/height/error/theme/export messages. Serialize source safely, including literal closing script tags and Unicode. Block ordinary remote assets and Host APIs. Document the approved self-navigation and busy-loop limitations.
- [ ] Implement Bootstrap theme mapping and `dsh.chart(element, option)`: merge visual defaults, return the native ECharts instance, resize and dispose with its owning document, and update theme without resetting authored input. Provide localized toolbar/status/error copy; preserve one iframe across Source/Preview and enlargement, including keyboard focus restoration.
- [ ] Implement same-runtime immutable asset reuse and the configured active-frame budget through a registration-owned store; viewport eviction resets state exactly as documented. Scope subscriptions to their owner and retire stale export/load responses.
- [ ] Implement self-contained HTML export with embedded declared assets, source download, strict Mermaid SVG export, and helper-owned ECharts PNG export with chart selection. Downloads require explicit user actions, enforce byte/MIME limits, and use local YYYYMMDD plus same-day sequence naming.
- [ ] Run package unit/component tests and both compiler faces, and build this package. Add built-output assertions for pinned manifests, licenses, lazy dependency separation and standalone resource completeness. Update paired README including the required invariant rationale, then commit.

## Task 3: Model instructions and shipped composition

**Files:** Extend `packages/client/ui-visualizations/src/index.ts`; add its prompt/skill provider and three `assets/visualize-*/SKILL.md` files; update `packages/core/system-prompt` section placement declarations as required, `packages/bundle/web-app/{package.json,cordis.patch.yml}`, the lockfile, owner READMEs, and generated catalogs.

**Interfaces:** Consume Task 2's single runtime manifest and the existing SystemPrompt/SkillProvider APIs. Register the short `ui:visualizations` section and skill names `visualize-html`, `visualize-charts`, and `visualize-diagrams`. Skill bodies derive runtime and dependency identifiers from the same manifest used in assets.

- [ ] Write and run failing provider tests for discovery, exact runtime/library identifiers, full-body loading, missing dependencies, feature disposal, and absent capability when the Web plugin is omitted. Assert that ordinary system guidance contains no full API manual.
- [ ] Register section and skill provider through effect lifetimes, requiring the services needed to make both visible. Teach when to visualize, exact fences, explicit closure, available classes/libraries, inline data, export limitations, transient inputs, and no Host/network assumptions. Include a short Bootstrap panel, a `dsh.chart` bar chart, and a Mermaid example in the respective skill.
- [ ] Mount the plugin in the shipped Web bundle with complete resolver dependencies and assets included in package files. Keep headless/default non-Web compositions free of the feature. Verify disposal retracts skill candidates and prompt contribution.
- [ ] Update paired package Model Experience documentation, regenerate owning configuration and module catalogs using their generators, and run focused provider/composition tests plus constraints and relevant documentation checks. Commit only this task's changes.

## Task 4: End-to-end acceptance and delivery evidence

**Files:** Add `apps/web/tests/inline-visualizations.e2e.ts` with owner-local expected outputs where needed; add a recorded Session owner under `snapshots/session/inline-visualizations/` using the existing snapshot harness. Update affected generated documentation and validation notes only. Store demonstration artifacts under ignored `.playwright-mcp/inline-visualizations-20261010/`.

**Interfaces:** Exercise the actual shipped `dsh web` profile with `apps/web/tests/pin-browse-picker.overlay.yml`, public browser/SDK interfaces, and the new prompt/runtime. Do not introduce an application launcher or inject synthetic events into a real-model demonstration.

- [x] Add browser regression cases for all design acceptance rows: real iframe rendering, dark/light and narrow/wide layout, source/preview and enlargement identity, blocked parent/remote access, stale frames, interrupted fences, malformed inputs, export contents/names, offline HTML, and active budget. Tests own their server/fixture state and teardown.
- [x] Run focused browser tests through the repository launcher, diagnose failures at their cause, and repair implementation without weakening assertions. Preserve actual asynchronous teardown and avoid fixed sleeps for readiness.
- [ ] Record a real model Session that loads visualization skills and emits all three kinds using benign fixed sample data. Obtain credentials only via the application's normal configured credential store. Normalize and commit the scenario using the existing snapshot workflow; replay keylessly and inspect all generated differences.
- [ ] Run relevant build/hygiene, typecheck, lint, documentation, and recorded-session checks once for the completed diff. Existing unrelated Comet document failures are reported separately; do not alter those records as part of this feature.
- [ ] Commit the verified implementation, build the exact commit, then record one real-model Web demonstration and GIF through the browser skill. Verify the encoded artifact and include a Chinese report with tested behavior, limitations, commit and local file links. If real credentials are unavailable, complete all keyless checks and report the specific missing real-model evidence truthfully.

## Review and completion

Each task receives a spec-compliance and quality review before its dependents begin. A whole-branch review follows integration. User approval to begin implementation already exists; continue through reversible implementation and fixes. Retain the worktree and feature branch for review without merging or publishing.
