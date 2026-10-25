# Project service management design

English | [中文](project-service-management-design_20261010_02.zh.md)

## Summary

This proposed design gives users and agents one project service inventory across the main checkout and its Git worktrees. It combines discovery of existing development servers, Docker containers and Compose services with explicit managed process startup. The GUI follows live changes; agents request bounded snapshots, logs, and operations through tools. This document specifies work to implement, not capabilities already shipped.

## Table of Contents

- [Product behavior](#product-behavior)
- [Project membership](#project-membership)
- [State and operations](#state-and-operations)
- [Docker and Compose](#docker-and-compose)
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
| Docker container or Compose service | Verified association with a project/checkout in the configured local Docker environment, including stopped containers | Inspect state, health and port mappings; read available logs; start, stop or restart existing containers individually or as a verified Compose group |

Managed processes and Docker containers may be workers without listening ports. Automatic discovery of external native processes initially covers TCP listeners; it does not classify every background process as a service. An unrecognized native worker can be launched from an explicit managed definition. Multiple endpoints from the same runtime instance share one row. A known managed process range absorbs observations of its descendants; a verified Docker published-port observation belongs to the container instead of a duplicate host-proxy row.

The initial end-to-end delivery targets local macOS, including a configured local Docker environment such as Docker Desktop. The provider interface reports individual capabilities; unsupported discovery or stopping on other platforms is explicit and does not masquerade as an empty inventory. Linux and Windows native-process adapters, remote execution or Docker endpoints, container creation/recreation, image builds, volume/network management, CPU/memory monitoring, dependency graphs, automatic recovery, and automatic agent wakeups are outside this first delivery. Docker's own restart policy remains observable and is not changed.

<a id="project-membership"></a>

## Project membership

For Git projects, project identity combines the execution provider identity and canonical Git common directory. The resolver enumerates Git's worktree records, including checkouts outside the selected Workspace directory. A separate clone with the same remote URL is a different project. Branch names are display metadata and do not establish identity. Non-Git projects use the canonical selected directory and its ordinary descendants, excluding independently rooted nested repositories.

The resolver leaves existing Workspace ids, Session membership, and sidebar grouping unchanged. Registered workspaces representing different checkouts of the same repository lead to the same service inventory. An unregistered worktree can appear in this inventory without creating a Workspace record or moving Sessions.

Managed launches carry explicit checkout identity. External discovery requires a readable canonical working directory and process identity; a port number, executable basename, or command-line substring alone is insufficient. A process belongs to the most specific matching checkout, and nested repositories do not inherit outer-project membership. Owner adapters may associate descendants with a managed range even if those descendants change directory. Unverifiable external processes remain outside the controllable inventory.

Worktree removal and directory disappearance invalidate new launches. A previously captured live managed range remains visible with its missing-checkout state and can still be stopped by an authorized caller. Failed discovery preserves the last observation as stale with an error. Host-side discovery always observes the configured execution environment, never the browser user's unrelated machine.

<a id="state-and-operations"></a>

## State and operations

The service model separates a durable native-process launch definition from each runtime instance. Branded ids identify projects, checkouts, definitions, instances, and operations. A process definition records its checkout, display name, and explicit startup command. Runtime instances have a discriminated native-process or Docker-container kind, an opaque provider identity, observation revision and time, source, optional owner link, endpoints, exit facts, and per-action capabilities with reasons when unavailable. A Compose service groups container instances rather than pretending its replicas are one process. Raw environment values and credentials are not persisted in definitions or returned in listings.

Managed native-process lifecycle states are starting, running, stopping, stopped, and failed. Docker lifecycle and health remain separate provider facts, including paused, restarting, exited and dead states; a group may have mixed member states. Discovery freshness is a separate fact. Running means a process is alive, not that its application is healthy. No Docker healthcheck means health is unknown, not healthy. HTTP(S) opening requires a known scheme, and a remote endpoint is never rewritten to browser-local localhost without an actual forwarding capability.

Native-process start resolves a complete launch specification before executing it, validates checkout membership, and admits at most one active instance per definition. Agent process startup uses the caller's shell and sandbox policy; GUI process startup uses the explicit human caller's execution permissions. Docker start targets an existing verified container under Docker-specific authorization. These paths share service state but not implicit privilege. Definitions do not carry approval from the caller that originally created them.

Stop and restart use instance ids and observed revisions, never a caller-supplied PID or port. The native provider revalidates membership and process creation identity immediately before acting; Docker identity is specified below. Where an OS provides identity-bound handles, the native provider uses them; a provider unable to establish the target returns an unavailable operation. Managed process stop waits for the owned process range to become quiescent. External native-process stop affects only verified target processes and does not signal an entire unrelated terminal group. An external descendant that escapes observation cannot be reported as successfully stopped.

Native-process restart is available only with a complete saved launch definition. Under the instance/definition lock, it resolves the launch specification and validates both stop and start before requesting authorization for both phases. After any approval wait it revalidates the target revisions, checkout and current caller policy before stopping. A failed startup preflight leaves the current instance running. Restart waits for successful termination and leaves a visible failure if the subsequent launch fails. Docker can restart an existing container using the configuration retained by its daemon, without reconstructing a shell command. Copying an observed external process command into a new definition is an explicit user action; it does not capture the external shell's environment, stdin, working state, or historical output. Registering a definition does not terminate or adopt the old process automatically.

Operations serialize per definition or instance. A stale revision or changed target yields a refresh-required result. Request identities deduplicate repeated GUI/RPC submissions within one Host lifetime; another start of an already active native definition returns the active instance. Native startup cancellation before publication rolls back startup; disconnection after publication stops waiting without terminating a committed service. Cancelling a Docker request after submission stops waiting, then reconciles the actual daemon outcome; it does not claim rollback or automatically stop a container. Failed or timed-out termination never becomes a successful restart.

Captured native-process logs use independent bounded readers with offsets, a runtime-instance id, and truncation indicators. GUI readers and agent readers cannot consume one another's output. Existing jobs' consuming output cursor is not reused for a second reader. External native-process logs are unavailable unless a verified adapter supplies a readable source; there is no attempt to reconstruct earlier terminal output or inspect process environments. Docker readers use provider cursors and report retention or reconnection gaps instead of presenting timestamps as exact byte offsets.

The local provider exposes validated configuration fields for discovery interval, maximum observation age, inventory size, log retention, per-read output limits, termination grace, and operation deadlines. Initial design defaults are a 2-second discovery interval while observed, a 10-second maximum fresh age, 200 returned services per page, 1 MiB retained output per managed instance, 16 KiB per agent log read, a 5-second termination grace, and a 30-second operation wait limit. These values resolve explicitly into the selected execution provider's request; an elapsed wait reports the still-tracked operation instead of claiming completion. On-demand agent queries coalesce with in-flight scans and refresh expired observations. Managed lifecycle events publish immediately; discovery starts on subscription or query and stops when no consumer requires it.

<a id="docker-and-compose"></a>

## Docker and Compose

The optional Docker adapter contributes observations and operations to the same project runtime. It pins a configured local Docker context/endpoint and verifies daemon identity; it never follows a changed ambient default context during an operation. Docker CLI absence, an unreachable daemon, access denial, and an unsupported remote endpoint are distinct capability states. Native service management remains available when Docker is unavailable, and last-known container rows become stale rather than disappearing as if stopped.

Automatic membership uses verifiable Compose working-directory/config-file metadata or an unambiguous bind-mount source inside a known checkout. The Compose project name, image name, container name, published port, named volume, and container-internal working directory alone cannot establish membership. Labels are association hints, not authorization. Missing or conflicting evidence requires a user-created association stored against the daemon and full container id. Shared containers appear once under Project shared, with explicit links to participating checkouts; a service in another registered project is not silently imported through a shared mount.

Container identity includes the configured daemon and full container id. A same-named replacement is a different instance and invalidates old operation/log cursors. Compose grouping also includes verified project-directory/config identity and service name; a project-name label alone cannot merge different worktrees. Multiple replicas remain individually inspectable, and one-off Compose run containers are not silently included in service-group operations. A removed worktree prevents new associations but does not prevent authorized inspection or stopping of an already associated container.

The first delivery operates existing containers: start a stopped container, stop a running container with its configured grace, restart that same container, and perform the same action on a frozen set of verified Compose service/project members. Group actions disclose the exact full-container-id set and authorize every target before mutation. They lock local member operations in stable order and reconcile membership immediately before the first mutation; a changed preflight set rejects without mutation. During execution they never expand the set or substitute a same-named replacement. Drift or disappearance after an earlier member succeeds yields per-member partial outcomes and unattempted members. Local locks do not exclude external Docker actors; the operation claims neither transactional rollback nor dependency orchestration. Paused/removing/dead containers expose only supported actions with a reason for each unavailable action. Creating missing containers, applying changed Compose configuration, pulling/building images, recreating services, running commands inside containers, and removing containers/volumes/networks are not available in these tools.

Container log reads return bounded daemon-retained stdout/stderr with container identity, timestamps, a provider cursor and gap indicators. A logging driver without readable retained output reports logs unavailable. TTY and multiplexed output are decoded by the adapter, not the model; merged group logs retain the originating replica. The adapter limits acquired bytes/time as well as returned bytes and never requests environment or credential fields merely to populate a row. Only published host bindings become host access endpoints; exposed-only ports and container-private addresses are not presented as host URLs.

Docker lifecycle events trigger refreshed snapshots, with bounded periodic reconciliation for event loss and reconnect. Subscriptions establish an event observation before publishing a reconciled baseline; reconnect invalidates freshness until reconciliation finishes. Engine-reported health and restart policy are shown separately from process state, and neither health changes nor Docker-driven restarts wake an agent automatically. Container recreation, daemon replacement and context reconfiguration invalidate affected observations before new ids are published.

Agent Docker operations require explicit policy support for the daemon, target containers and action. Authorization for a sandboxed shell command does not imply access to the host Docker socket or permission to start a container with broader mounts or privileges. Policy evaluates a minimized target description including relevant mount/privilege facts without exposing environment values to the model; inability to enforce this policy makes the action unavailable. The adapter uses structured Docker responses and explicit arguments or an Engine client, never model-supplied Docker command fragments. Transport/dependency selection belongs to the implementation plan and must avoid a handwritten Docker protocol where a maintained client removes that work.

Docker owns container lifetime. Closing the application, disposing a Session, or removing a Workspace association does not stop or remove containers, including containers an agent started through these tools. Host restart restores associations as unverified until a fresh daemon query, then reports actual state; it never marks a container stopped merely because the application restarted. Stopping or restarting an existing container does not delete its volumes, and the tools do not expose destructive cleanup actions.

<a id="agent-integration"></a>

## Agent integration

Agents use the same service runtime as the GUI through three compact tools. The agent's Session directory establishes its project; tool arguments cannot select an arbitrary other project. Project discovery does not itself grant cross-checkout filesystem access or mutation authority. Tool responses expose capabilities after caller authorization, so a shared project inventory can offer different actions to the human and the agent.

| Tool | Request | Bounded result |
|---|---|---|
| `service_list` | Optional checkout, provider kind, state filter, operation id, and pagination cursor | Instance/group and definition ids, provider kind, source, lifecycle/health, endpoints, freshness, revision, operation progress/outcome, and authorized actions; no logs by default |
| `service_logs` | Instance or verified group id, optional provider cursor, and requested limit | Output tail or increment with source identity, next cursor, truncation/gaps, and unavailable reason |
| `service_control` | Discriminated start, stop, or restart request; a native start uses a saved or explicit definition, while Docker targets existing instances or a verified group | Settled outcome or tracked operation id, resulting instances, per-member outcomes for groups, and bounded failure details |

A tool invocation rechecks the Session's current resolved policy and project membership. Mutations participate in the ordinary tool execution policy and approval pipeline, with the concrete command and checkout available to policy. A GUI-granted permission does not authorize an agent call. Access to another Session's job or terminal is not granted by calling its owner-scoped API with an omitted owner; adapters must supply an explicit authorized operation or report it unavailable. External stop requires the configured policy to authorize that target and action. A missing authorization provider fails closed for affected mutations.

Resolved-target authorization is a required same-process `ServiceAccess.authorize` callback supplied by the trusted consumer, never accepted in Remote or model JSON. The runtime creates an immutable `ResolvedServiceOperation`, covering the command, checkout, exact target/member ids and revisions, both restart phases, and minimized Docker privilege/mount facts, then calls this callback before mutation. The authenticated controller supplies human authority; `tool-project-services` supplies agent authority through the existing `ctx.approval.request`, with current Session policy and a one-shot grant bound to that description. Missing or rejected approval fails closed. Ordinary tool admission remains an additional check, not a grant for resolved targets. Logs outside the agent's current allowed filesystem scope and Docker logs also require resolved-target authorization; discovery metadata never grants permission to read arbitrary files or other Session output.

List, logs, operation results and subscriptions apply caller read authorization before returning data. The operation description in the approval audit names every target; an oversized group requires a smaller selection instead of truncating authorized targets. After approval the runtime rechecks cancellation, target revisions, effective sandbox policy and effective approval policy. Agent-created native services must use a Host-lived process provider. On macOS, external native-process stopping is unavailable unless an identity-bound target can be established; a separate PID check followed by signaling does not satisfy that requirement.

Tool results state actionable distinctions: stale observation, unknown target, missing checkout, unavailable discovery, unsupported logs, policy rejection, termination failure, and startup failure. Permission failure is not a reason to suggest bypassing the tool with a shell command. Unsupported inspection may explain that the current provider lacks the capability, without inventing service state.

Only short usage guidance and tool schemas enter the normal prompt. The model queries current state when it needs it; frequent GUI updates do not inject context, start turns, or wake an idle agent. Model-visible results use the existing tool call/result logging path. GUI-only observation remains outside the transcript. Pure Host presenters and Client views use persisted result metadata for historical cards; replay never queries current service state. PTC receives canonical typed tool values through the existing tool pipeline.

The expected benefit is fewer model-issued shell calls and less platform-specific output parsing for repeated status, port, log, and restart tasks. The costs are three tool schemas, a local observation provider, and lifecycle maintenance. Benefits are greatest when several checkouts or services are active; no token, latency, or success-rate improvement is claimed without measurement. A separate agent daemon, periodic model polling, and continuous service-list prompt injection are excluded.

<a id="architecture-and-lifecycle"></a>

## Architecture and lifecycle

The implementation adds a capability through Cordis plugins and leaves the agent loop unchanged. Service Definition, local Service Provider, GUI API, and agent tools share typed definitions; consumers never inspect one another's private registries. Package names below are planned locations, not existing exports.

| Location | Responsibility |
|---|---|
| `packages/workspace/project-services/` | Service Definition, provider-contribution API, branded ids, caller and capability types, native/container snapshots, groups, log and operation requests |
| `packages/workspace/project-services-local/` | Canonical project/worktree resolution, native observation/execution, definition and association storage, merged inventory, concurrency, log retention and native cleanup |
| `packages/workspace/project-services-docker/` | Optional local Docker provider contribution: daemon identity, container/Compose membership, state/events, bounded logs and authorized existing-container operations |
| `packages/workspace/tool-project-services/` | Three tools, policy-aware caller derivation, bounded values, model rendering and durable presentation metadata |
| `packages/api/project-services-controller/` | Authenticated human operations and reconnect-safe baseline/increment subscriptions |
| `packages/client/ui-project-services/` | Project panel, checkout groups, operation and log views, tool cards, and locale dictionaries |

Composition wires the local runtime into the application, registers the optional Docker adapter through an effect-owned contribution API, and mounts the tools in compatible agent compositions. Native and Docker contributions coexist in one inventory rather than competing for the same Cordis service key. A remote or sandbox composition without a matching authorized execution/observation provider advertises that absence instead of querying local Host resources. Runtime observations include provider identity so ids cannot accidentally address another execution environment. The GUI feed follows the existing Workspace baseline/increment pattern, with generation and revision checks to recover after reconnect or dropped updates.

Persistent state uses a dedicated storage domain for native launch definitions and explicit Docker associations. Runtime observations, PIDs, and active-operation identities are process-local and are never revived from durable records as live handles. The local runtime owns managed native processes independently of the initiating Session: closing a panel, ending a turn, disposing the initiating agent, or archiving its Session does not stop a published project service. Docker retains ownership of its containers. Existing jobs and terminals retain their existing lifetimes; observation does not transfer ownership.

Host/provider shutdown terminates managed native-process ranges and awaits quiescence. Discovery never makes the Host own external processes or Docker containers, so shutdown leaves them alone. A subsequent Host startup restores native definitions as stopped and rediscovers external listeners and Docker state; it does not auto-start definitions. Native crash survivors are treated as externally observed until fresh ownership evidence exists. Removing a Workspace registration does not stop services or delete launch definitions. Deleting a native launch definition requires its managed instance to be stopped first; unlinking a Docker association never deletes the container.

The existing [Workspace model](../../subsystems/workspace.md), [subprocess semantics](../../subsystems/subprocess.md), [tool integration guide](../../cookbook/adding-a-tool.md), and [testing policy](../../testing.md) define the reused behavior. Public service/config types, package READMEs, catalogs, composition manifests, and any required persistence acknowledgements accompany implementation. Current-state product documentation is updated only when the behavior exists.

<a id="verification-and-benefit-assessment"></a>

## Verification and benefit assessment

Acceptance covers both the human workflow and the agent workflow in the same project, including an external-directory worktree, a manually started external listener, a standalone container and a Compose service with multiple replicas. A GUI action must appear in the next agent query, and an agent action must update the open panel without a manual reload. The macOS integration run launches isolated disposable services through the supported profile and terminates only its owned fixtures.

| Area | Required evidence |
|---|---|
| Membership | Main checkout, external worktree, non-Git directory, symlink aliases, nested repository, separate clone, missing directory, unreadable cwd, and cross-provider rejection |
| Process actions | Stale revision, changed creation identity/PID reuse, exit before action, descendant cleanup, simultaneous stop/restart, duplicate start, startup rollback, denied action, and failed termination |
| Freshness and delivery | Fake-clock tests for expiration, scan coalescing and subscription cleanup; reconnect baseline and increments; discovery error never reported as empty/stopped |
| Logs and lifecycle | Independent GUI/agent readers, output truncation, instance changes, unavailable external logs, Session disposal retaining services, and Host shutdown preserving external services |
| Docker | Context/daemon changes, same-name replacements, ambiguous/shared mount attribution, Compose name collisions across worktrees, replicas and one-off exclusion, partial group failure, policy rejection, unreadable logs, published versus exposed ports, event gaps, daemon offline/reconnect, and Host shutdown preserving containers and volumes |
| Agent behavior | Keyless recorded sessions for list, start, log read, restart, stop, stale state and rejection; ordinary tools and PTC; no passive context injection or unauthorized shell fallback |
| GUI | Localized panel and cards, checkout filters, unavailable actions, accessibility, real external-listener integration, browser expected output and a real-flow GIF for the feature PR |

Use repository test-support clocks and owned subprocess fixtures; do not rely on arbitrary sleeps, fixed ports, ambient user processes, or the development machine's current service inventory. Docker integration uses uniquely labeled disposable containers/Compose groups, dynamic published ports, a pinned test image and cleanup restricted to ids created by that test; unit fixtures cover unavailable Docker without a daemon. Real Docker evidence is required before claiming the adapter works, and a Docker-unavailable skip is reported as unverified integration. Focused package tests and relevant source/build checks precede the recorded-session and browser scenarios. CI owns exhaustive platform validation; unsupported external discovery is tested explicitly on platforms without an adapter.

Compare the same tasks with and without service tools: identify a running frontend in another checkout, read recent logs, start a configured service, and restart it. Record model-visible shell-call count, tool-call count, returned bytes, end-to-end time, and incorrect or stale-target attempts; report medians across repeated runs and do not equate returned bytes with provider-billed tokens. A keyless replay verifies behavior, while a separate controlled real-model run measures agent choices. Correct membership and action authorization are acceptance requirements even if measured latency does not improve.

<a id="dev-note"></a>

## Dev Note

The user authorized implementation after independent design review. The implementation plan preserves local macOS native-service and Docker/Compose coverage and the distinction between discovery, action authority, and lifetime ownership. Extending platform support, creating/recreating containers, or adding unattended recovery requires a separate decision with matching lifecycle tests.
