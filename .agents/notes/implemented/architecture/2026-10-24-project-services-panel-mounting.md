# Agent Note: Project services panel mounting and the three-plane service view

Status: implemented

English | [中文](2026-10-24-project-services-panel-mounting.zh.md)

## Problem

The project-services branch shipped a browser panel (`packages/client/ui-project-services`) that no composition ever mounted: `src/client/index.ts` registered a copy dictionary and nothing else, and the controller's four Remote methods had no browser caller. The panel's data path was sixteen ad-hoc props, so the first caller would have had to re-derive the Remote wiring, the stream lifetime, and the control verbs from scratch.

Two questions had no recorded answer. First, which seat a project-level panel belongs in: the design document asks for "主界面" without naming a slot, and every shipped per-session seat would remount the panel on a session switch. Second, how the three planes that now see the same services relate — the Host controller, the browser panel, and the model tools — and what authorizes a browser control that a model tool's approval policy does not gate.

## Decision

**The panel is a root-scoped global page.** It registers into the layout's keyed `main` seat under the panel id `projectServices`, and its icon registers into the sidebar's `sidebar.panellist` row with the same id. Both ride `ctx.slots.inject()`, so neither owner's activation order matters. Project services belong to a Git project and its worktrees, not to one Session; a session-scoped seat would discard the selected checkout and the open log viewer on every session switch.

**The panel reads the `projectServices` Remote namespace and contributes no Host behavior.** `src/index.ts` stays an empty Host entry. `src/client/panel-source.ts` holds one snapshot — inventory, selected checkout, open log viewer, pending-action markers, last failure — published through a `createSnapshotStore` handle. The inject face hands the component that snapshot as the `usePanel` selector hook plus seven verbs: `selectCheckout`, `refresh`, `control`, `stopGroup`, `openLogs`, `closeLogs`, and `dismissError`.

**The follow stream's lifetime is the source's own, keyed to observation.** The first framework hook that observes the snapshot opens `ctx.remote.projectServices.follow`; the last one that leaves aborts it; `connection/reset` reopens it. Every in-flight read carries the activation's abort signal, so unmounting the panel cancels it. Each verb guards its publication with an epoch, so a read a newer verb superseded publishes nothing, and each verb settles to a `Promise<void>` that never rejects — a Host refusal becomes the snapshot's `error`. That is why the component calls the verbs with `void` rather than `.catch`.

**Control verbs carry the observed revision.** The Host rejects a control whose target revision has moved, so the panel passes the item's `revision` instead of letting the controller default it. A group stop issues one control per member at that member's own revision, and marks every member pending until the group settles.

**The three planes share one authorization, one instance identity, and one log.** The Host controller builds a human `ServiceAccess` per call; the browser panel drives that same controller through the Remote namespace, and a browser control is not an Agent action, so the tool approval policy does not gate it. The panel renders what the controller publishes for that access and holds no authority of its own. The model tools read and act on the same services through the same runtime, so the GUI and the model see one service table rather than two.

## Verification

The component spec drives the panel through props alone and reaches per-file 100% coverage on `ProjectServicesPanel.tsx`. The source spec scripts the Remote namespace and pins the follow lifecycle: the stream opens on the first observer, reopens on `connection/reset`, aborts with the last observer, and drops a read a newer verb superseded. The plugin spec boots `apply` against a `SlotRegistry` plus a `TestRemote` and asserts both registrations, their options, and their disposal with the plugin fiber.

## Alternatives considered

**Register into a session-scoped seat** such as `conversation.input.dock` or `sidebar.right.pane.tab`. Rejected because both remount the panel on a session switch, which discards the selected checkout and the open log viewer; the panel's data is project-scoped and has no session dependency to key on.

**Give the panel its own Host Service Definition and read the runtime directly.** Rejected because it would fork the service table the model tools read: two observation paths over the same processes drift, and the browser would need its own authorization story. The controller's Remote namespace is the one seam both planes already cross.

**Pass the inventory down as owner props from the shell.** Rejected because the shell would then own the panel's data, and a `main` occupant receives no owner share that could carry it; the registrant-private inject face is the documented route for one entry's live facts.

**Let the component hold the view state locally.** Rejected because the open log viewer and the selected checkout would reset on every remount, and the verbs that move them would have to live in the component, which would make it issue Remote calls and lose its pure-presentation property.

**Read the inventory once at registration and refresh it on a timer.** Rejected because a poll spends Host work whether or not anybody looks at the page, and a stale frame is indistinguishable from a live one. Observation-keyed subscription plus the Host's follow stream costs nothing while the page is closed.

## Consequences

- Adding a panel fact means adding it to `ProjectServicesPanelSnapshot` and covering it in the component spec; the component never learns where the fact came from.
- The verbs never reject, so a component author who writes `.catch` adds dead code that the per-file coverage gate rejects. The README states this obligation.
- Every control verb needs the observed revision at its call site, so a new card must render from an item that carries `revision`.
- The panel sees the project the Host was launched from, because it reads `list` and `follow` without a `cwd`. A browser serving several projects needs a project selector the Host does not yet expose.
- The panel's controls are not gated by the tool approval policy. A deployment that wants the same review for a human click as for a model call has to add it at the controller, not here.
