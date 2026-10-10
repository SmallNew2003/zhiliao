# Project service management design

English | [中文](project-service-management-design_20261010.zh.md)

## Summary

This proposed design gives users and agents one project service inventory across the main checkout and its Git worktrees. It combines discovery of existing development servers with explicit managed startup. The GUI follows live changes; agents request bounded snapshots, logs, and operations through tools. This document specifies work to implement, not capabilities already shipped.

## Table of Contents

- [Product behavior](#product-behavior)
- [Project membership](#project-membership)
- [State and operations](#state-and-operations)
- [Agent integration](#agent-integration)
- [Architecture and lifecycle](#architecture-and-lifecycle)
- [Verification and benefit assessment](#verification-and-benefit-assessment)
- [Dev Note](#dev-note)

<a id="product-behavior"></a>

## Product behavior

Each Workspace gains a Services action opening a project-scoped main panel. The panel groups services by checkout, with an All checkouts filter and individual checkout selection. Opening it requires no active agent. Web and Desktop share this panel through the existing main-panel extension.

Each row shows the service name, checkout and branch when available, observed process state, listening endpoints, startup command when known, source, observation time, and available actions. A detail view shows startup configuration and a bounded log tail. State, availability, and errors use localized text and accessible names. A missing observation is displayed as unknown or unavailable, never as stopped.

| Source | Discovery | Available actions |
|---|---|---|
| Project-managed service | Registered at startup, including services started by an agent tool | Start, stop, restart, inspect captured logs, and open a known HTTP(S) address |
| Existing agent job or application terminal service | Observed listeners associated with its process and checkout; linked owner information only when supplied by a supported adapter | Inspect; actions and logs only through an authorized owner or an external-process capability |
| External terminal service | Listening process with verifiable project directory membership | Inspect, open a known HTTP(S) address, and stop where the provider can safely address the observed process |

Managed services may be workers without listening ports. Automatic discovery initially covers TCP listeners; it does not classify every background process as a service. An unrecognized non-listening worker can be launched from an explicit managed definition. Multiple endpoints from the same process instance share one row. A known managed process range absorbs observations of its descendants instead of producing duplicate rows.

The initial end-to-end delivery targets local macOS, the current development environment. The provider interface reports individual capabilities; unsupported discovery or stopping on other platforms is explicit and does not masquerade as an empty inventory. Linux and Windows discovery adapters, remote execution providers, containers, CPU/memory monitoring, dependency graphs, automatic restarts, and automatic agent wakeups are outside this first delivery.

<a id="project-membership"></a>

## Project membership

For Git projects, project identity combines the execution provider identity and canonical Git common directory. The resolver enumerates Git's worktree records, including checkouts outside the selected Workspace directory. A separate clone with the same remote URL is a different project. Branch names are display metadata and do not establish identity. Non-Git projects use the canonical selected directory and its ordinary descendants, excluding independently rooted nested repositories.

The resolver leaves existing Workspace ids, Session membership, and sidebar grouping unchanged. Registered workspaces representing different checkouts of the same repository lead to the same service inventory. An unregistered worktree can appear in this inventory without creating a Workspace record or moving Sessions.

Managed launches carry explicit checkout identity. External discovery requires a readable canonical working directory and process identity; a port number, executable basename, or command-line substring alone is insufficient. A process belongs to the most specific matching checkout, and nested repositories do not inherit outer-project membership. Owner adapters may associate descendants with a managed range even if those descendants change directory. Unverifiable external processes remain outside the controllable inventory.

Worktree removal and directory disappearance invalidate new launches. A previously captured live managed range remains visible with its missing-checkout state and can still be stopped by an authorized caller. Failed discovery preserves the last observation as stale with an error. Host-side discovery always observes the configured execution environment, never the browser user's unrelated machine.

<a id="state-and-operations"></a>

## State and operations

The service model separates a durable launch definition from each transient runtime instance. Branded ids identify projects, checkouts, definitions, instances, and operations. A definition records its checkout, display name, and explicit startup command. Runtime instances additionally record an opaque provider identity, observation revision and time, source, optional owner link, endpoints, exit facts, and per-action capabilities with reasons when unavailable. Raw environment values and credentials are not persisted in definitions or returned in listings.

Managed lifecycle states are starting, running, stopping, stopped, and failed. Discovery freshness is a separate fact. Running means the process is alive; a listening port means a socket was observed. Neither implies application health. HTTP(S) opening requires a known scheme, and a remote endpoint is never rewritten to browser-local localhost without an actual forwarding capability.

Start resolves a complete launch specification before executing it, validates checkout membership, and admits at most one active instance per definition. Agent startup uses the caller's shell and sandbox policy; GUI startup uses the explicit human caller's execution permissions. These paths share service state but not implicit privilege. Definitions do not carry approval from the caller that originally created them.

Stop and restart use instance ids and observed revisions, never a caller-supplied PID or port. The provider revalidates membership and process creation identity immediately before acting. Where an OS provides identity-bound handles, the provider uses them; a provider unable to establish the target returns an unavailable operation. Managed stop waits for the owned process range to become quiescent. External stop affects only verified target processes and does not signal an entire unrelated terminal group. An external descendant that escapes observation cannot be reported as successfully stopped.

Restart is available only with a complete saved launch definition. It serializes stop and start, waits for successful termination, and leaves a visible failure if the new launch fails. Copying an observed external command into a new definition is an explicit user action; it does not capture the external shell's environment, stdin, working state, or historical output. Registering a definition does not terminate or adopt the old process automatically.

Operations serialize per definition or instance. A stale revision or changed target yields a refresh-required result. Request identities deduplicate repeated GUI/RPC submissions within one Host lifetime; another start of an already active definition returns the active instance. Cancellation before publication rolls back startup; disconnection after publication stops waiting without terminating a committed service. Failed or timed-out termination never becomes a successful restart.

Captured logs use independent bounded readers with offsets, a runtime-instance id, and truncation indicators. GUI readers and agent readers cannot consume one another's output. Existing jobs' consuming output cursor is not reused for a second reader. External logs are unavailable unless a verified adapter supplies a readable source; there is no attempt to reconstruct earlier terminal output or inspect process environments.

The local provider exposes validated configuration fields for discovery interval, maximum observation age, inventory size, log retention, per-read output limits, termination grace, and operation deadlines. Initial design defaults are a 2-second discovery interval while observed, a 10-second maximum fresh age, 200 returned services per page, 1 MiB retained output per managed instance, 16 KiB per agent log read, a 5-second termination grace, and a 30-second operation wait limit. These values resolve explicitly into the selected execution provider's request; an elapsed wait reports the still-tracked operation instead of claiming completion. On-demand agent queries coalesce with in-flight scans and refresh expired observations. Managed lifecycle events publish immediately; discovery starts on subscription or query and stops when no consumer requires it.

<a id="agent-integration"></a>

## Agent integration

Agents use the same service runtime as the GUI through three compact tools. The agent's Session directory establishes its project; tool arguments cannot select an arbitrary other project. Project discovery does not itself grant cross-checkout filesystem access or mutation authority. Tool responses expose capabilities after caller authorization, so a shared project inventory can offer different actions to the human and the agent.

| Tool | Request | Bounded result |
|---|---|---|
| `service_list` | Optional checkout, state filter, operation id, and pagination cursor | Instance and definition ids, source, state, endpoint facts, freshness, revision, operation progress/outcome, and authorized actions; no logs by default |
| `service_logs` | Instance id, optional offset, and requested limit | Output tail or increment, next offset, truncation, and unavailable reason |
| `service_control` | Discriminated start, stop, or restart request; start uses a saved definition or an explicit checkout/name/command definition | Settled outcome or tracked operation id, resulting instance, and bounded failure details |

A tool invocation rechecks the Session's current resolved policy and project membership. Mutations participate in the ordinary tool execution policy and approval pipeline, with the concrete command and checkout available to policy. A GUI-granted permission does not authorize an agent call. Access to another Session's job or terminal is not granted by calling its owner-scoped API with an omitted owner; adapters must supply an explicit authorized operation or report it unavailable. External stop requires the configured policy to authorize that target and action. A missing authorization provider fails closed for affected mutations.

Tool results state actionable distinctions: stale observation, unknown target, missing checkout, unavailable discovery, unsupported logs, policy rejection, termination failure, and startup failure. Permission failure is not a reason to suggest bypassing the tool with a shell command. Unsupported inspection may explain that the current provider lacks the capability, without inventing service state.

Only short usage guidance and tool schemas enter the normal prompt. The model queries current state when it needs it; frequent GUI updates do not inject context, start turns, or wake an idle agent. Model-visible results use the existing tool call/result logging path. GUI-only observation remains outside the transcript. Pure Host presenters and Client views use persisted result metadata for historical cards; replay never queries current service state. PTC receives canonical typed tool values through the existing tool pipeline.

The expected benefit is fewer model-issued shell calls and less platform-specific output parsing for repeated status, port, log, and restart tasks. The costs are three tool schemas, a local observation provider, and lifecycle maintenance. Benefits are greatest when several checkouts or services are active; no token, latency, or success-rate improvement is claimed without measurement. A separate agent daemon, periodic model polling, and continuous service-list prompt injection are excluded.

<a id="architecture-and-lifecycle"></a>

## Architecture and lifecycle

The implementation adds a capability through Cordis plugins and leaves the agent loop unchanged. Service Definition, local Service Provider, GUI API, and agent tools share typed definitions; consumers never inspect one another's private registries. Package names below are planned locations, not existing exports.

| Location | Responsibility |
|---|---|
| `packages/workspace/project-services/` | Service Definition, branded ids, caller and capability types, snapshots, log and operation requests |
| `packages/workspace/project-services-local/` | Canonical project/worktree resolution, local observation, launch-definition storage, runtime instances, concurrency, log retention and cleanup |
| `packages/workspace/tool-project-services/` | Three tools, policy-aware caller derivation, bounded values, model rendering and durable presentation metadata |
| `packages/api/project-services-controller/` | Authenticated human operations and reconnect-safe baseline/increment subscriptions |
| `packages/client/ui-project-services/` | Project panel, checkout groups, operation and log views, tool cards, and locale dictionaries |

Composition wires the provider into the local application and the tools into compatible agent compositions. A remote or sandbox composition without a matching execution/observation provider advertises that absence instead of querying local Host processes. Runtime observations include provider identity so ids cannot accidentally address another execution environment. The GUI feed follows the existing Workspace baseline/increment pattern, with generation and revision checks to recover after reconnect or dropped updates.

Persistent state uses a dedicated storage domain for launch definitions. Runtime instances, PIDs, and active-operation identities are process-local and are never revived from durable records as live handles. The provider owns managed services independently of the initiating Session: closing a panel, ending a turn, disposing the initiating agent, or archiving its Session does not stop a published project service. Existing jobs and terminals retain their existing lifetimes; observation does not transfer ownership.

Host/provider shutdown terminates managed process ranges and awaits quiescence. Discovery never makes the Host own external processes, so shutdown leaves them alone. A subsequent Host startup restores definitions as stopped and rediscovers external listeners; it does not auto-start definitions. Crash survivors are treated as externally observed until fresh ownership evidence exists. Removing a Workspace registration does not stop services or delete launch definitions. Deleting a launch definition requires its managed instance to be stopped first.

The existing [Workspace model](../../subsystems/workspace.md), [subprocess semantics](../../subsystems/subprocess.md), [tool integration guide](../../cookbook/adding-a-tool.md), and [testing policy](../../testing.md) define the reused behavior. Public service/config types, package READMEs, catalogs, composition manifests, and any required persistence acknowledgements accompany implementation. Current-state product documentation is updated only when the behavior exists.

<a id="verification-and-benefit-assessment"></a>

## Verification and benefit assessment

Acceptance covers both the human workflow and the agent workflow in the same project, including an external-directory worktree and a manually started external listener. A GUI action must appear in the next agent query, and an agent action must update the open panel without a manual reload. The macOS integration run launches isolated disposable services through the supported profile and terminates only its owned fixtures.

| Area | Required evidence |
|---|---|
| Membership | Main checkout, external worktree, non-Git directory, symlink aliases, nested repository, separate clone, missing directory, unreadable cwd, and cross-provider rejection |
| Process actions | Stale revision, changed creation identity/PID reuse, exit before action, descendant cleanup, simultaneous stop/restart, duplicate start, startup rollback, denied action, and failed termination |
| Freshness and delivery | Fake-clock tests for expiration, scan coalescing and subscription cleanup; reconnect baseline and increments; discovery error never reported as empty/stopped |
| Logs and lifecycle | Independent GUI/agent readers, output truncation, instance changes, unavailable external logs, Session disposal retaining services, and Host shutdown preserving external services |
| Agent behavior | Keyless recorded sessions for list, start, log read, restart, stop, stale state and rejection; ordinary tools and PTC; no passive context injection or unauthorized shell fallback |
| GUI | Localized panel and cards, checkout filters, unavailable actions, accessibility, real external-listener integration, browser expected output and a real-flow GIF for the feature PR |

Use repository test-support clocks and owned subprocess fixtures; do not rely on arbitrary sleeps, fixed ports, ambient user processes, or the development machine's current service inventory. Focused package tests and relevant source/build checks precede the recorded-session and browser scenarios. CI owns exhaustive platform validation; unsupported external discovery is tested explicitly on platforms without an adapter.

Compare the same tasks with and without service tools: identify a running frontend in another checkout, read recent logs, start a configured service, and restart it. Record model-visible shell-call count, tool-call count, returned bytes, end-to-end time, and incorrect or stale-target attempts; report medians across repeated runs and do not equate returned bytes with provider-billed tokens. A keyless replay verifies behavior, while a separate controlled real-model run measures agent choices. Correct membership and action authorization are acceptance requirements even if measured latency does not improve.

<a id="dev-note"></a>

## Dev Note

This is a design reference awaiting written-spec review. The first implementation plan must preserve the local macOS scope and the distinction between service discovery, action authority, and launch ownership. Extending platform support or adding unattended recovery requires a separate decision with matching lifecycle tests.
