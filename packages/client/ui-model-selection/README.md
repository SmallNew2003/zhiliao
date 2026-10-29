---
description: "Model selection for the Web GUI: the /model popup and the composer model seat over one per-session provider-grouped directory; for users and maintainers of model routing."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

English | [中文](README.zh.md)

## Summary

The Web GUI lets users switch the model and reasoning effort for an existing session through either the `/model` popup or the composer's model control. Both surfaces present the same provider-grouped choices, and the selected model determines the available effort names and default. A complete selection applies to the next request; a running step keeps the model and effort it started with. If no adapter can serve the session's route, the composer remains disabled until routing becomes available.

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

Mount this plugin alongside `ui-conversation` and the commands package; the composer then shows the model seat next to the pending indicator, and `/model` opens the same directory as a popup. Opening the composer menu shows provider-grouped models together with the current model’s reasoning efforts and context window, each a snapping slider. The two sliders sit in a block pinned under the model list, which is the part that scrolls, so a long catalog never pushes them away. `↑`/`↓` move across the model rows, Tab selects the focused row, and Escape or `Shift+Tab` closes directly back to the trigger; a focused slider keeps the arrow keys itself, and Tab leaves it to the browser. A slider step applies its selection in place and leaves the menu open, so the pointer can keep travelling the track: one write runs at a time, and a step reached while another is open replaces the step still waiting rather than stacking requests. Choosing a model row settles and closes, and drops any waiting step. Tab from the trigger focuses the selected model, or the first available model when none is selected. Both surfaces show the host-reported current selection when the exact provider/model pair remains in the advertised groups; a missing catalog row leaves the routable selection intact and the trigger displays its provider/model ids.

### Model and effort

Models stay grouped by provider. The composer menu shows model and effort names only. The `/model` popup shows provider names and catalog descriptions; it localizes the two built-in DeepSeek descriptions and leaves external provider descriptions verbatim. The popup applies the selected model's default effort; the composer then chooses any advertised effort on a snapping slider over the levels — with a provider-default step ahead of them when the adapter configures no model default. An adapter without reasoning metadata leaves the effort section absent; there is no arbitrary effort input.

### Context window

The same composer panel offers a snapping slider over the 320K, 640K, and 960K context budgets (320,000, 640,000, and 960,000 tokens). It displays the explicit session selection or the current model's catalog capacity as a numeric current value; an unavailable capacity displays Unknown. A non-preset inherited value stays on the track as its own step, so the thumb never claims a preset the session is not using. Choosing a window preserves the effort, and choosing an effort preserves the explicit window. Clicking the current model makes no change — the slider never re-emits the step in use — and choosing another model clears the old window override. The next request uses the selected budget for request metadata and pressure compaction, and resumed sessions restore it. Custom capacity stays in Settings.

A successful decrease shows a brief notice that context may be compacted before continuing. Running requests retain their admitted budget; subsequent requests validate the selected budget before dispatch.

### Unroutable sessions

When the Host reports that no adapter serves the session's route, this plugin raises a composer block and the input goes inert with its own copy; recovering clears it without a reload. A `null` before the first load or after one failed never blocks, and catalog membership never blocks either — a route serving a model it does not advertise is missing from the groups yet usable.

### Selection failures

When another writer owns the Session, model-selection failures tell the user to quit other running DSH instances and retry.

-----


<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`ModelDirectoryResolver` (`ctx.modelDirectories`) owns one shared Host-generation catalog and a lazy directory per session binding. The `/model` popup and composer seat combine that catalog with the durable `modelSelection` projection and submit complete selections through `session.selectModel`. A connection reset invalidates in-flight selection responses while retaining the durable current value as the catalog reloads. Forwarded adapter, settings, and credential-reference changes refresh the shared catalog. Session-scope disposal removes its directory; addressed subagent sessions expose neither entry.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the model surface is not enough. They move from the browser surfaces to the command popup shell and the selection contract.

- [ui-commands](../ui-commands/README.md) — the popupSelect shell the `/model` contribution registers into.
- [ui-conversation](../ui-conversation/README.md) — declares the composer's `conversation.input.model` seat and the composer block.
- [dsh-agent-default-model](../../core/agent-default-model/README.md) — the default-model service for sessions that never choose.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `session.selectModel` selection both entries submit: the Host snapshots the complete `ModelSelection` at the next prompt-assembly boundary and owns the model-visible effect, while a running step keeps its assembled selection.

#### KV Cache effect

Switching the route can reduce or invalidate provider-side cache reuse for subsequent requests; the prompt prefix itself is untouched.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current model surface. They are current package constraints, not a general model-router comparison or a task backlog.

- **No create-time or addressed-subagent selection** — both entries require an existing ordinary session's Agent; there is no draft-phase model choice to fold into session creation, and subagent continuation deliberately exposes no independent model-selection contract.
- **Directory names are presentation-only** — selection and persistence use provider/model/effort ids and numeric budgets; a provider whose catalog or exact-model metadata lookup fails lists as an unselectable failure row until reload.
- **No arbitrary effort input** — the composer offers only the exact model's adapter-advertised levels; an adapter without reasoning metadata leaves the effort section absent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The plugin registers a single command contribution, and the HMR-safety spec proves that the registration is disposed correctly. The plugin emits no Cordis events and owns no cross-plugin mutable state.
