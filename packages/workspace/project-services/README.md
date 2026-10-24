---
description: "Shared project service API for Host providers, tools, and graphical clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-project-services

English | [中文](README.zh.md)

## Summary

Use this package to give human and agent callers one project service API while retaining separate authority. Consumers can request inventories, independent log pages, control operations, and live snapshots. A runtime implementation and concrete providers are required; this package does not launch processes or containers.

## Table of Contents

- [Use this package](#use-this-package)
- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Implement `ProjectServiceRuntime` as the `projectServices` service, then register `ProjectServiceProvider` contributions through Cordis effects. Import JSON records from the `/types` entry when a client does not need the Host service class. The [local runtime](../project-services-local/README.md) supplies the local implementation.

A trusted caller authorizes the resolved project, checkout, exact target revisions, native command or Docker identities. The runtime revalidates policy and targets after approval; the originally requested revision remains binding even if preparation is asynchronous. Every returned project, checkout, service, definition, group, operation, and provider status passes read authorization.

Provider preparation has no lifecycle side effects and supplies a nonempty exact target set, including the reserved identity of a new launch. The runtime reserves those ids together with definition/group aliases before publication. `validate` checks the approved identities and revisions; `execute` receives a Host-owned signal. A trusted native adapter resolves a `ServiceNativeLaunch` before mutation and returns a `ServiceNativeProcess` bound to `ServiceNativeLifetime`; direct process outcome and managed-range quiescence remain separate facts. `nativeLaunch.targetId` identifies a reserved new range alongside every existing target, and both identities are reserved and checked for collisions. Provider-specific restart preflight belongs in preparation.

Native preparation receives `pendingDefinition` for a new definition so the provider can associate the launched instance with its durable id. Persistence occurs only after authorization. `ServiceItem.definitionId` links a managed instance to that definition. Definition ids, resource ids and operation ids are opaque branded strings. Provider snapshots may include project-bound `capturedCheckouts` for still-owned managed items; missing checkouts permit reads and stops, but never starts or restarts. Expired rows carry `stale` and cannot provide mutation evidence. An unreadable control status omits both `operation` and `pending`.

<a id="implementation"></a>
## Implementation

<details>
<summary>Host ownership and persistence</summary>

The [source declarations](src/types.ts) own requests, snapshots, provider observations and trusted callbacks. Wire records contain no executable authority. The abstract service documents the lifecycle and read requirements independently of GUI and tool consumers.

The API does not add Session events. Consumers that expose results to a model must log them through their existing tool execution path. Provider-qualified target ids distinguish native instances from container resources.

No runtime invariant companion is published: this Service Definition owns no independently mutable observations.

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

- This package supplies no providers, transport validation, UI, or model tools. Consumers must construct trusted authority and validate JSON requests. Providers must honor cancellation and await managed-range termination; a direct child exit does not establish range quiescence.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package ships definitions rather than providers: the shared service definitions, branded identifiers, request and view contracts, and the public projections its consumers share. Its contracts are exercised through the provider and consumer packages, for example `pnpm exec vitest run packages/workspace/project-services-local`.

</details>
