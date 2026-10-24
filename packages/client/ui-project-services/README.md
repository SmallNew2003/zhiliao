---
description: "Project services panel for the Web GUI: a global page listing native processes and Docker containers across a project's Git worktrees, with retained logs."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-project-services

English | [中文](README.zh.md)

## Summary

The project services panel is a global page the sidebar row opens. It lists the native processes and the Docker / Compose services of one Git checkout at a time, with each service's state, ownership, ports, and retained log tail. The browser face registers the page into the layout's `main` seat and its row into `sidebar.panellist`, reads the `projectServices` Remote namespace through `ctx.remote`, and projects the results into one inject-face snapshot plus the panel's control verbs. The component stays pure presentation. All copy comes from the package's own `projectServices` dictionary.

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

The browser face registers two contributions and needs no Host-side assembly:

- `ProjectServicesPanel` into the layout's keyed `main` seat, under the panel id `projectServices`.
- `ProjectServicesPanelIcon` into the sidebar's `sidebar.panellist` row, with the same id and a localized label, so the row opens the page.

Both ride `ctx.slots.inject()`, so neither owner's activation order matters. Every fact the panel renders arrives from the `projectServices` Remote namespace; the panel holds no store, subscribes to nothing itself, and issues no Remote call. Before the Host answers, the panel shows the title, the worktree selector, and the provider row only.

### The worktree selector

The selector lists every checkout the inventory reports as `<id> (<path>)` and follows the source's `selectedCheckoutId`, which starts at the first checkout. Changing the selection calls `selectCheckout`, which re-points the whole panel and withdraws an open log viewer. A checkout's availability renders as a tag beside the title; with no checkout at all the selector offers a single placeholder option.

### Provider status

The header carries one tag per provider the inventory reports, naming the provider's kind and its state — ready, stale, or unavailable. An unreachable Docker daemon therefore reads as an unavailable provider rather than as a stopped service, which is what keeps the native services of the same checkout visible and operable.

### Service cards

Services split into a native section and a Docker / Compose section. Each card carries the service name, a state dot, a status label, the ownership tag of a native service, a stale tag, the detail line, and the port list when the service reports one. The buttons a card offers are those the inventory's `actions` list names for that service and its state allows: start while stopped, stop and restart while running. A card with an action in flight is disabled, keyed by the source's pending marker for that service id.

Docker services that belong to a group render inside that group's card under the group name, with a stop-all button while any member runs and none is in flight; the rest render as ungrouped cards.

Every control verb carries the revision the panel observed for its target: the Host rejects a control whose target revision has since moved, so a stale revision fails loud instead of acting on a service the operator no longer sees.

### Logs

`openLogs` receives a service id; the source reads that target's retained tail (16 KiB) and the card grows an inline log viewer under its header. The viewer shows the loading label while the read is in flight, the empty label for a page without chunks, and otherwise one line per chunk with stderr tinted. A truncated page carries the truncation label, a page that reports a gap carries the gap notice, and a page that reports the logs unavailable carries that reason. `closeLogs` dismisses the viewer, and switching checkouts withdraws it.

```tsx ignore-check
// The registration, from the browser face's apply():
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main',
  key: PANEL_ID,
  locale: NS,
  inject: () => source.inject(),
}, ProjectServicesPanel))
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/client/panel-source.ts` owns every live fact. It holds one snapshot — the inventory, the selected checkout, the open log viewer, the pending-action markers, and the last failure — and publishes it through a `createSnapshotStore` handle. The inject face hands the component that handle's snapshot as the `usePanel` selector hook plus seven verbs: `selectCheckout`, `refresh`, `control`, `stopGroup`, `openLogs`, `closeLogs`, and `dismissError`.

The follow stream's lifecycle is the source's own. The first framework hook that observes the snapshot opens `ctx.remote.projectServices.follow`, and the last one that leaves aborts it; `connection/reset` reopens it. Every in-flight read carries the activation's abort signal, so unmounting the panel cancels it. Each verb guards its publication with an epoch, so a read a newer verb superseded publishes nothing, and each verb settles to a plain `Promise<void>` that never rejects — a Host refusal becomes the snapshot's `error`, which the panel renders. That is why the component calls the verbs with `void` rather than `.catch`.

`src/index.ts` is the Host entry and stays empty because the panel has no Host-side behavior; the browser face is `src/client/index.ts`, which registers the dictionaries under the `projectServices` namespace and the two slot contributions.

The `LocaleNamespaceMap` declaration in `src/client/index.ts` is what makes `t('section.native')` and its siblings type-check against the dictionary, so a key added to `src/client/locales.ts` becomes a compile error in any dictionary that lacks it. `dsh.client.inject` names the Remote assembly, the locale plugin, and the two slot owners; the panel's `Button`, `StateDot`, and `Tag` come from `ui-primitives`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the data behind the panel and the model-facing surface over the same services.

- [dsh-project-services](../../workspace/project-services/README.md) — the shared runtime whose inventory and log views the panel renders.
- [dsh-api-project-services-controller](../../api/project-services-controller/README.md) — the Remote surface that maps the runtime into `ApiServiceInventoryView` and `ApiServiceLogsView`.
- [dsh-tool-project-services](../../workspace/tool-project-services/README.md) — the model-facing tools that read and act on the same services.
- [dsh-client-ui-plugin-manager](../ui-plugin-manager/README.md) — the other global `main` panel, whose registration this package follows.
- [dsh-client-ui-primitives](../ui-primitives/README.md) — the `Button`, `StateDot`, and `Tag` atoms the cards render with.
- [Client package map](../README.md) — the browser-half packages this panel sits among.

-----

<a id="model-experience"></a>
## Model Experience

### Project services panel

#### What the model sees

Nothing. The panel renders the inventory the `projectServices` Remote namespace publishes and registers no tool, prompt, or Session event, so no string it displays enters a model request. The inject face is its only input, and the labels it prints come from the `projectServices` dictionary, which the browser face alone registers.

#### Token effect

Zero direct tokens. The panel contributes no request content and no history entry, so no model call spends tokens on its output.

#### KV Cache effect

No request-prefix change and no cache invalidation. The panel assembles no provider request and appends no conversation content, so an already-reusable prefix stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the reach of the panel. They are current package constraints, not a comparison with the model-facing tools.

- **Host-cwd scope** — the panel reads `list` and `follow` without a `cwd`, so the Host resolves the project from its own working directory. A browser serving several projects sees the one it was launched from.
- **No log paging or streaming** — the viewer renders one supplied page, so a long-running service shows only the retained tail; `ApiServiceLogsView.nextCursor` is not consumed here.
- **No provider or inventory paging** — `ApiServiceInventoryView.nextCursor` is not consumed, so an inventory larger than one page is silently truncated to that page.
- **Group staleness is not rendered** — `ApiServiceGroupView.stale` is not read; a stale group surfaces only through its members' stale tags and its provider's state.
- **Service filtering is by checkout only** — the panel offers no name or state filter, so a project with many services shows all of them for the selected checkout.
- **No start-from-definition** — the panel only drives the verbs the inventory's `actions` list names; launching a new native command is not offered.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run the package's client specs with `pnpm exec vitest run packages/client/ui-project-services --coverage`; the component spec drives the panel through props alone, the source spec drives the Remote wiring through scripted namespace doubles, and the plugin spec boots `apply` against a `SlotRegistry` plus a `TestRemote`. None needs a key, and none needs a browser beyond jsdom.

</details>

**Runtime invariant:** No companion is published. The panel owns no relationship an independent observation could diverge from, and its disposal is the unmount of the surface that imported it.
