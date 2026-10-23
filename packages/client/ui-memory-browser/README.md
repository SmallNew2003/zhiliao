---
description: "Long-term memory browser for the Web client: the sidebar Memory panel lists the deployment's memory banks, their statistics and fact-type composition, their knowledge pages, and searches the knowledge index."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-memory-browser

English | [中文](README.zh.md)

## Summary

Select **Memory** in the Web sidebar to see what a deployment's long-term memory holds. The panel lists every memory bank with its fact count and last write, and for the bank you select shows its node, link, and document totals, its fact-type and link-type composition as ranked bars, and its knowledge pages. A knowledge page opens over the bank with its rendered body, and a search box queries the bank's knowledge index so you can jump straight to a page that mentions a term. Nothing here writes: the panel is a read-only view over what the agent already remembered.

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

The panel appears in the sidebar whenever the Host mounts the `memoryController` Remote. It reads the Host the first time it renders, so opening it costs nothing until you ask for it, and re-reads on **Refresh** and on reconnect — a daemon that restarted under a running browser can answer differently.

### Reading the banks

The list shows each bank the daemon holds: its name, how many facts it has, and when it was last written, as a compact relative time (`3h`, `2d`) that shares its bucketing with the session lists, so two surfaces never disagree about when "5 minutes" ends. A bank nothing has written to says **No writes yet** rather than showing an empty time. Selecting a bank opens it; **Refresh** re-reads the list and the open bank together.

Banks are ordered most-recently-written first, so the bank a session has been filling is the one at the top. A bank the backend has never written to sinks to the bottom instead of disappearing, and among banks with the same instant the name decides — a list that reshuffles on every refresh is unreadable.

### Reading one bank's composition

The selected bank shows five totals — nodes, links, documents, pending operations, failed operations — and the two distributions the backend reports: node counts per **fact type** and link counts per **link type**. Each distribution is drawn as labelled bars scaled to its largest entry, largest first. A distribution the backend did not report says so in words rather than drawing a row of zero-width bars, which would read as "measured and empty" instead of "not reported".

A pending or failed operation count is what the backend reported, not this panel's judgment about it.

### Browsing and searching knowledge pages

Below the statistics, the panel lists the bank's knowledge pages with the prompt each was generated from, its last-refresh time, and a **Stale** tag where the backend marked it due for a refresh. Opening a page reads its body and shows it over the bank — the statistics and the page list stay mounted beneath it, because a page is a reading of the bank rather than a step away from it. The close control in the page's corner, or the crumb back to the bank list, closes it.

The search box queries the bank's **knowledge index**: the curated knowledge pages, matched on their content. Type a term and **Search** (or press Enter) runs it; the result line reports the backend's own total, which can exceed the number of hits shown. Opening a hit opens that page the same way the page list does. A blank box is not a search — it would ask the daemon to match everything and answer with its own idea of the best twenty pages — so **Search** stays disabled until there is a term.

This is deliberately *not* the memory seam's search. That one answers by running inference on the daemon and takes a minute or more, which would freeze the panel; the knowledge index is an index lookup.

### When memory is not available

A deployment that ships no memory provider has nothing to browse, and the panel says which condition it hit rather than showing an empty list or a blank column:

| What you see | What it means |
|---|---|
| No usable memory provider is registered | Memory is switched off for this deployment. |
| The memory provider is misconfigured | The Host pinned a provider id that is not registered, or several compete with none pinned. |
| The memory daemon did not answer within its budget | The daemon is up but slow, or unreachable. |
| The memory daemon returned an error | The request reached the daemon and it refused. |

A classified condition also shows the Host's own diagnostic beneath the sentence, which is usually what names the address or id to fix. A call that never produced an answer at all — a closed socket, a codec mismatch — shows the transport's words instead, once, with a **Retry** button: that failure is worth retrying, while a deployment with no provider is not. The banks already on screen stay put when the daemon goes away, so a blip does not erase what you were reading.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

The browser plugin registers the `memory` sidebar entry and its `main` panel through `ctx.slots.inject()`, so both follow late slot declaration, locale changes, and teardown. The panel is global rather than session-scoped: what a deployment remembers belongs to the installation, not to one conversation, and every session's sidebar offers the same view of it. It injects `remote.memoryController`, so a Host without the Remote leaves the panel unmounted rather than half-working.

### The store

`MemoryBrowserController` owns the banks, the selected bank, its statistics and pages, the open page's body, the search, and any failure. It owns no timer and no subscription: the only invalidation it follows is the browser's own reconnect, because the daemon can restart under a running page and nothing else signals that. Reads coalesce — a **Refresh** during a slow load marks one rerun rather than asking the daemon twice for the same answer — and a settlement arriving after disposal, or after the panel moved to another bank, is dropped rather than written into a view it no longer belongs to.

The bank list, its statistics, and its page tree are three separate Remote methods, so one failing leaves the others standing: a bank whose statistics the daemon cannot measure still lists its pages, and a failed read keeps whatever was already on screen rather than clearing a working view.

### Presentation

Only the write time and the four unavailability reasons go through presentation helpers; both take `t` rather than closing over a dictionary, so a locale change reaches them. The relative-time bucketing comes from the shared `relativeTime` helper precisely so this panel and the session lists agree; the words stay in this package's own dictionary. An instant this runtime cannot parse reads as *never written* rather than showing an unparsed backend string in the middle of a list.

### Styling

CSS Modules with `--dsw-*` semantic tokens only; no literal colors. The distribution bars are the one place a computed value reaches the DOM, and it is a width percentage derived from the counts rather than a color.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the panel's contract is not enough: the Host surface behind it, the capability it projects, and the seam that owns memory for the agent.

- [Memory controller](../../host/memory-controller/README.md) — the `memoryController` Remote this panel reads, and the endpoint mapping behind each method.
- [Memory capability seam](../../memory/memory/README.md) — the `ctx.memory` provider registry whose availability the panel reflects.
- [hindsight HTTP provider](../../memory/hindsight-http/README.md) — the provider that registers the daemon this panel browses.
- [Sidebar](../ui-sidebar/README.md) — the panel list the Memory entry registers into; [layout](../ui-layout/README.md) — the main slot the panel occupies.

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser-side read-only memory projection registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what this browse view can show. They are current package constraints, not a task backlog.

- **Search covers knowledge pages, not memories** — the query runs against the curated knowledge index because the memory seam's search answers by running inference on the daemon and takes over a minute; a fact-level search is therefore not available here.
- **Page bodies render as preformatted text** — the Markdown is shown as the backend wrote it rather than rendered, so structure is legible but not styled.
- **No raw memory units** — the daemon's memory rows carry provider-internal context the Remote does not project, so the panel shows banks, statistics, and knowledge pages rather than individual remembered facts.
- **One bank at a time** — statistics, pages, and search all address the selected bank; there is no cross-bank view or comparison.
- **No history and no writes** — the panel cannot retain, edit, consolidate, delete, or tell what changed since the last read, and it does not say which provider registered.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The `memory` panel id is chosen to be globally unique in the main-slot namespace and does not collide with the `memory` seam's Cordis key; the sidebar entry and the panel share it so the entry selects what it registered. The page's `now` is read once per render rather than per row so two banks' trailing labels cannot disagree within one paint.

Every Remote call is issued at most once per interaction, and each settlement is dropped if the panel moved on — a late answer for a bank that is no longer selected must not overwrite the one that is, because the numbers on screen would silently belong to a different bank.

</details>

**Runtime invariant:** No companion is published. This package owns a read-only sidebar panel over Host-owned memory facts.