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

Control requests with the same actor, project, and request id share one operation. Reusing that key for different input rejects. Completed keys remain idempotent only while retained; oldest settled records can be evicted at capacity. Existing-target operations require the observed revision. Overlapping target sets serialize, but external actors remain outside these locks.

Log readers own their cursors. `RetainedServiceLog` keeps a UTF-8 tail, reports lost bytes, and counts JSON metadata in its requested byte limit. Tiny limits that cannot hold metadata and one character reject. A failed provider scan reports stale status and supplies no cached actionable targets.

<a id="implementation"></a>
## Implementation

<details>
<summary>Host ownership and persistence</summary>

The resolver canonicalizes existing directories through the Workspace path helper and executes bounded Git requests. Project identity combines execution identity with the canonical Git common directory, or the canonical cwd for non-Git directories. For Git projects the project path names the common directory; checkout paths name working directories. Missing registered worktrees are excluded. The `project_services` storage domain uses version 1 and validates definitions and associations at persistence.

Published operations use one controller owned by the Host. Host disposal aborts pending work, awaits operations, and closes storage; providers own service-range cleanup and must preserve Docker resources. Feed cancellation detaches subscriptions even while a reader is paused. Reconnection starts a fresh baseline, and changed snapshots invalidate page cursors.

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
