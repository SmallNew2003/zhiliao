---
description: "Local project service inventory, durable launch definitions, target authorization, and independent log readers."
kind: "package-reference"
---

# @deepseek-ai/dsh-project-services-local

English | [中文](README.zh.md)

## Summary

Use this package to group local Git worktrees, save service launch definitions, and inspect or control services through one read-authorized inventory. Linked worktrees share their Git common directory; independent clones and nested repositories remain separate projects. Providers supply actual native or container operations. It requires local filesystem access, Git, subprocess execution, and a storage domain.

## Table of Contents

- [Use this package](#use-this-package)
- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Load `project-services-local` with `subprocess` and `storageDomain`. Each provider registers through a Cordis effect. Supply trusted `ServiceAccess` callbacks from the Host; JSON requests never supply actor authority. Definitions survive Host restarts without starting automatically.

Configuration defaults are: discovery interval 2,000 ms, freshness maximum 10,000 ms, page maximum 200 items, retained output 1,048,576 bytes, log response maximum 16,384 bytes, termination grace 5,000 ms, operation wait 30,000 ms, scan deadline 10,000 ms, scan output maximum 1,048,576 bytes, and 200 retained operation/request records. Every value is a positive integer Config field. Providers use their own validated configuration for the resources they retain or terminate.

Control requests with the same actor, project, and request id share one operation. Reusing that key for different input rejects. Completed keys remain idempotent only while retained; oldest settled records can be evicted at capacity. Existing-target operations keep the requested revision binding across asynchronous preparation and approval. Reservations cover the resolved instance ids, requested definition or group aliases, and new-definition names before publication. Overlapping target sets serialize, but external actors remain outside these locks.

Log readers own their cursors. `RetainedServiceLog` keeps a UTF-8 tail, reports lost bytes, and counts JSON metadata in its requested byte limit. Tiny limits that cannot hold metadata and one character reject. Expired or failed provider scans retain the latest observed rows with `stale: true` and no actions. Every retained row still passes current read policy, and stale observations cannot authorize mutations.

Load the optional `@deepseek-ai/dsh-project-services-local/native` provider on macOS to observe TCP listeners and run managed commands. External rows associate by canonical working directory and have no lifecycle actions or captured output. TCP ports do not establish an HTTP or HTTPS URL. Structured `lsof` fields and bounded `ps` creation observations exclude processes that change during a scan; failed scans retain explicitly stale inventory through the runtime. Concurrent readers share only the current Host-owned raw scan, each with independent cancellation. The completed observation is not cached; checkout attribution, managed state and read authority are composed per reader.

Native provider configuration uses an explicit `shellPath` (`/bin/bash`), `retainedOutputBytes` (1,048,576), `terminationGraceMs` (5,000), `scanTimeoutMs` (10,000), `scanMaxBytes` (1,048,576), `processInspectionMax` (200), `captureIntervalMs` (25), and `historyMaxInstances` (200). Numeric values are positive integers. The history cap evicts the oldest stopped instances and their logs while preserving every active range; old identities never address a replacement. Evicted instance reads fail as unavailable.

Human launch preparation resolves the configured local shell and command executable. Agent callers use `createShellServiceExecution(initiatingContext, ctx.nativeProjectServices.lifetime, request)` from the native entry, supplying the current sandbox policy and transient environment. The factory requires declared POSIX command syntax, captures the actual shell's prepared confinement, and requests range-lived output; provider checks require the same subprocess realm and exact Host lifetime signal, so a Session-owned adapter rejects. Restart approval names both the existing instance and the reserved replacement identity. Both launch and termination are preflighted before stopping; every launch creates its own id and independent retained output. Initiator cancellation after publication and initiating-scope disposal leave the range alive; provider/Host disposal aborts pending launches, rolls back late handles, terminates managed ranges and awaits quiescence.

Native lifecycle state follows the owned range rather than the direct shell outcome. Direct exit code/signal facts remain visible independently. Optional provider membership observations suppress duplicate managed listener rows only with current positive ownership evidence; unsupported observation preserves the external row. macOS membership and process creation labels are observational, with the subprocess provider's documented process-group limits; they never authorize signalling an external numeric PID.

<a id="implementation"></a>
## Implementation

<details>
<summary>Host ownership and persistence</summary>

The resolver canonicalizes existing directories through the Workspace path helper and executes bounded Git requests. Project identity combines execution identity with the canonical Git common directory, or the canonical cwd for non-Git directories. For Git projects the project path names the common directory; checkout paths name working directories. The live Git resolver excludes missing registered worktrees. A provider can supply `capturedCheckouts` alongside matching managed items it still owns; the runtime marks those checkouts `availability: missing`, keeps read/log/stop available, and rejects start/restart. Other checkouts are explicitly `availability: present`. Captured facts must retain the original project and checkout identities; they never authorize a new launch. The `project_services` storage domain uses version 1 and validates definitions and associations at persistence.

Published operations use one controller owned by the Host. Host disposal aborts pending work, awaits operations, and closes storage; providers own service-range cleanup and must preserve Docker resources. Feed cancellation removes both abort listeners and provider subscriptions even while a reader is paused. Reconnection starts a fresh baseline. Revisions hash the project, actor and read-authorized content, so another project or reader cannot expire an unchanged page cursor. The runtime freezes candidate facts before refreshing authority and applying the final read filters; a hidden control operation exposes neither its record nor `pending` status.

No runtime invariant companion is published: definitions and associations are read directly from their storage tables without a second cache, and operation outcomes describe requests rather than independently mirroring live provider state.

</details>

<a id="model-experience"></a>
## Model Experience

### Project service API

#### What the model sees

Nothing directly. `ctx.projectServices` contributes no tools, prompts, or Session events; consumers own model-visible results.

#### Token effect

Zero direct tokens. A tool consumer pays only for the result it exposes.

#### KV Cache effect

No direct request-prefix changes or cache invalidations.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The runtime resolves only local paths and requires Git to distinguish repositories. Concrete native and Docker providers are separate contributions. Inventory pages bound service items; definitions, groups and retained operations remain separate collections. Host-local locking cannot prevent external process or Docker changes. Full Loader, tool snapshot and product acceptance belong to the provider and consumer compositions.
