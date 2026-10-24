---
description: "Docker and Compose project service provider contribution with verified daemon identity and Compose grouping."
kind: "package-reference"
---

# @deepseek-ai/dsh-project-services-docker

English | [中文](README.zh.md)

## Summary

Use this package to contribute Docker and Compose container inspection, Compose service grouping, bounded log retrieval, and lifecycle management into the shared project services runtime. Containers associate with Git worktrees using verified Compose project working directories, configuration paths, or bind mount sources. It requires a local Docker CLI installation and connects to a fixed local Docker context.

## Table of Contents

- [Use this package](#use-this-package)
- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Load `project-services-docker` alongside `project-services` and `subprocess`. The provider registers as a Cordis effect in `[Service.init]()`. Dispose unregisters the contribution and clears polling timers, but preserves all running Docker containers and their volumes.

Configuration defaults are: context `""` (default context), command `"docker"`, termination grace 5,000 ms, scan interval 2,000 ms, freshness maximum 10,000 ms, scan deadline 10,000 ms, capture cap 10,485,760 bytes per stream, inspect batch 100 container ids, and log tail maximum 1,000 lines. All numeric values are positive integers. A termination grace beyond the scan deadline is rejected at load: `docker stop -t` spends its grace inside one CLI invocation and could never finish within a shorter deadline.

Inspection queries daemon identity and lists containers. If Docker is not installed or the daemon is unreachable, the provider returns an unavailable or stale status with the underlying error reason, never an empty success. Containers matching the project's checkouts or explicit associations appear in the service inventory; one-off containers and unrelated external containers are excluded. Compose replicas are grouped under their shared Compose service name.

Lifecycle operations support `start`, `stop`, and `restart` on existing containers and frozen Compose groups. Compose group operations freeze exact member container ids and verify that membership has not drifted before mutating any target. If an early member succeeds and a subsequent member fails, remaining members are reported as unattempted and replacement containers are not acted on.

<a id="implementation"></a>
## Implementation

<details>
<summary>Transport, membership and operations</summary>

The provider uses a structured `DockerTransport` that wraps CLI calls with fixed `--context` arguments and structured JSON output. The default subprocess executor runs every invocation from a fixed working directory, bounds each stream by the configured capture cap, and applies the scan deadline as a dispatch timeout alongside the caller's cancellation; a child killed by a signal or an overflowing stream fails the call instead of reporting a successful empty exit. Container ids reach `docker inspect` in bounded batches so a busy host cannot exhaust the argument limit.

Membership resolution maps containers to checkouts using `com.docker.compose.project.working_dir`, `com.docker.compose.project.config_files`, and bind mount sources, selecting the most specific matching checkout path. Port mapping extracts only published Host ports, excluding exposed-only container ports. A Compose group id carries the checkout id, the Compose project, and the service name, so two worktrees of one repository running the same Compose project and service produce distinct group ids and distinct control targets. Freshness caching is keyed by project: within the freshness window a project is served its own observation, never another project's container surface.

Operations check daemon identity at preparation, validation, and execution. If the daemon restarts or changes its identity, operations reject.

No runtime invariant companion is published: Docker container lifecycle is owned by Docker Engine, and this package does not duplicate or maintain a persistent replica of container state.

</details>

<a id="model-experience"></a>
## Model Experience

### Project service Docker provider

#### What the model sees

Nothing directly. The provider contributes no tools, prompts, or Session events; the tools and controllers consuming `ctx.projectServices` own model-visible output.

#### Token effect

Zero direct tokens.

#### KV Cache effect

No direct request-prefix changes or cache invalidations.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only connects to the configured local Docker context. Remote contexts, container build/rebuild, image pull, volume deletion, and network removal are intentionally omitted. External Docker operations performed outside the harness cannot be locked out.
- Container logs read `--since` the reader's cursor and drop lines at or before it, so a line sharing the cursor's exact timestamp is treated as already delivered. The two container streams are concatenated per stream rather than interleaved chronologically, and `--tail` capping can drop older lines without a detectable signal, so a page never reports a gap. A truncated page resumes from its last delivered line.
- The provider emits no `capturedCheckouts`: a saved association carries no checkout path, so a managed Docker item whose checkout directory vanished cannot be reconstructed into a checkout fact, and the runtime's missing-checkout admission stays with the native provider.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run the provider spec with `pnpm exec vitest run packages/workspace/project-services-docker`; it drives daemon identity, container discovery, Compose group operations, and the wire-validation schemas against a mock executor and needs no Docker daemon.

</details>
