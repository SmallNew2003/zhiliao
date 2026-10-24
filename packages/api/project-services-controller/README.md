---
description: "Host Remote controller for project services: inventory, retained logs, lifecycle control, and the live update stream for Web and desktop clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-project-services-controller

English | [中文](README.zh.md)

## Summary

`dsh-api-project-services-controller` serves the project services panel of Web and desktop clients: it exposes the trusted host runtime's service inventory, retained logs, lifecycle control, and live updates through the `projectServices` Remote namespace. Each endpoint maps domain records into plain JSON views, so no branded identifier crosses the wire. Reads run under one shared reader identity; every mutating call must name its caller and carries the revision the panel observed. The controller adds no tool, prompt section, or Session event; mount it beside `dsh-project-services` and the Typert Gateway when a client needs project service data.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host controller owns `ctx.projectServicesController` and the generated `ctx.remote.projectServices` namespace; the Web application bundle mounts it beside the Typert Gateway and the project services runtime. Every operation is scoped by the working directory the request carries, defaulting to the Host process's current directory.

- `list` — returns the active services, Git checkout availability, Docker/Compose groups, and provider states for one page.
- `logs` — reads the runtime's retained output for one service target, bounded by the caller's `maxBytes`.
- `control` — starts a service from a launch definition, or stops or restarts an existing target by id. Every mutation names its `caller` and the `expectedRevision` the caller observed; a missing caller, a missing revision, or a revision that no longer matches fails the call.
- `follow` — streams one inventory baseline, then ordered update frames, until the client cancels.

The package declares no configuration fields.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`ProjectServicesController` extends `TypertRemoteService` with namespace `projectServices`. Each endpoint builds a human-authority `ServiceAccess` for the requesting client and forwards the call to `ctx.projectServices`; `mapInventoryView` and `mapLogsView` then flatten branded identifiers, optional fields, and nested records into the `Api*View` types in `src/types.ts`. `list`, `logs`, and `follow` run under the shared `remote:reader` identity, while `control` runs under `remote:<caller>` from the request. `control` mints the request id when the client omits one and refuses a launch definition paired with any action but `start`. `follow` relays the runtime stream frame by frame and re-maps every snapshot, so the wire contract stays the JSON view set.

</details>

<a id="model-experience"></a>
## Model Experience

### GUI data supply

#### What the model sees

Nothing. The controller answers browser and desktop clients over the Remote transport and registers no tool, system-prompt section, or Session event, so no string it returns enters a model request. The model-facing surface over the same services is [`dsh-tool-project-services`](../../workspace/tool-project-services/README.md).

#### Token effect

Zero direct tokens. The controller contributes no request content and appends no conversation history, so no model call spends tokens on its output.

#### KV Cache effect

No request-prefix change and no cache invalidation. The controller assembles no provider request, so an already-reusable prefix stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits state what the Remote surface does not check or recover. They are current package constraints, not a task backlog.

- **Reads are not narrowed** — every endpoint's `canRead` grants every observed resource, so read filtering is left to the runtime and its providers; the controller adds no narrowing of its own.
- **Mutating calls run under human authority, not the Agent approval seam** — a browser or desktop client's `control` call resolves through the controller's own `authorize`, which never asks a human answerer. Access policy for that path belongs to the composition that mounts the package. The Agent tools' approval-gated path is `dsh-tool-project-services`.
- **Every call carries one read identity** — reads run under the fixed `remote:reader` label, so a read cannot be attributed to a specific connected client. Mutating calls must name their `caller` instead.
- **`follow` has no catch-up cursor** — each stream generation opens with a fresh baseline from the runtime, so a reconnect receives another baseline instead of the increments missed while disconnected.
- **Log reads stop at the runtime's retention** — the controller forwards the caller's `maxBytes` without a cap of its own, so output the runtime has already discarded is unreachable through this surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run the controller spec with `pnpm exec vitest run packages/api/project-services-controller`; it drives all four endpoints against a mock `ProjectServiceRuntime` through a stub Typert Gateway, needs no key, and needs no host process.

</details>

**Runtime invariant:** No runtime invariant companion is published. The controller projects facts the runtime holds and keeps no state an independent observation could diverge from.
