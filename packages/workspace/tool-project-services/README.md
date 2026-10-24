---
description: "Model-facing project service tools: service_list, service_logs, and service_control."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-project-services

English | [中文](README.zh.md)

## Summary

`dsh-tool-project-services` exposes three Agent tools (`service_list`, `service_logs`, and `service_control`) to discover and operate native background processes and Docker containers across Git worktrees within the current project. Log reads are capped at 16 KiB per call and report whether output was truncated or already discarded. Every `service_control` action mutates and is gated by a fail-closed authorization step whose only grant is an approval decision.

## Table of Contents

- [The three tools](#the-three-tools)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>

## The three tools

- `service_list(checkout_id?, kind?, state?, cursor?, limit?)` — Discover running and stopped services across project checkouts, with each target's state, ports, ownership, and `revision`.
- `service_logs(target_id, cursor?, max_bytes?)` — Read up to 16 KiB of retained output from one service target. `truncated` marks a call that stopped at the cap, `gap` marks output the runtime already discarded, and `unavailable` names a target that keeps no output.
- `service_control(action, target_id?, expected_revision?, definition?)` — Start, stop, or restart one service. Every action mutates. A target-bound call carries the `expected_revision` that `service_list` reported for it; a revision that no longer matches fails the call instead of acting on a service the caller no longer sees.

<a id="configuration"></a>
## Configuration

| Option | Default | Description |
|---|---|---|
| `defaultMaxLogBytes` | `16384` | Default byte limit when reading service logs |
| `maxLogBytesCap` | `16384` | Maximum byte cap for single service log reads |
| `defaultPageLimit` | `50` | Default page item limit for service listings |
| `maxPageLimit` | `200` | Maximum page item limit for service listings |
| `approvalPolicy` | `'ask'` | Stance on mutating operations: `'ask'` routes each one through the host approval service, which fails closed when no answerer is composed; `'never'` rejects every mutating operation without asking anyone |

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The plugin registers one fixed `tool:project-services` guidance section (order 1650) while it is active.

##### Project services guidance

```markdown
Use `service_list` to see the native processes and Docker containers this project and its Git worktrees run, with each target's state, ports, and `revision`. Use `service_logs` to read one target's retained output: at most 16 KiB per call, so follow `nextCursor` for more; `truncated` marks a call that stopped at the cap, `gap` marks output the runtime already discarded, and `unavailable` names a target that keeps no output. Use `service_control` to start, stop, or restart one service; every action mutates and is gated by one approval decision. Pass `expected_revision` from the `service_list` row you act on: a revision that no longer matches fails the call instead of touching a service you no longer see. Prefer these tools over shelling out to `ps`, `lsof`, or `docker ps`; do not use them for a one-off command or a process that is not a project service.
```

#### Token effect

One fixed section is present on each request while the plugin is active; no config field changes its text.

#### KV Cache effect

Prefix-stable while the plugin and the guidance text are unchanged. Plugin activation or disposal may invalidate reuse from this section.

### Tool schemas

#### What the model sees

The model sees the generated [`service_list`, `service_logs`, and `service_control` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-project-services). Listing filters and the caller's paging parameters stay in the schema, while the host-side page cap and the provider's cursor values are not expressible in it. `service_control` pins `action` to `start`, `stop`, or `restart`, and its result `state` to `running`, `succeeded`, `failed`, or `unknown`.

#### Token effect

Three fixed schemas are sent on each request while the tools are visible; agent-scoped restrictions can remove one.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged; a restriction or plugin disposal may invalidate reuse from the first changed definition.

### Tool results

#### What the model sees

Each call emits one formatted text block. A listing prints the project and its checkouts, then one line per service with its name, kind, state, ownership, ports, and revision, plus the conditional `(no matching services)`, `Provider warnings: <id>: <state> (<reason>)`, and `Next cursor: <cursor>` lines. A log read prints one line per chunk and reports `truncated`, `gap`, and `unavailable` flags. A control call prints `Service <action> (<operationId-or-requestId>): <target>: <state>…` per outcome, or `submitted, but the current read policy denies reading its operation status` when the runtime accepted the call without reporting status.

#### Token effect

Results are data-dependent and remain in logged tool history until compaction; a page carries at most `maxPageLimit` items and a log read at most `maxLogBytesCap` bytes.

#### KV Cache effect

Append-only result text follows the reusable request prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits state what the three tools cannot reach or decide. They are current package constraints, not a task backlog.

- **Filters run after the page fetch** — `service_list` reads one page (at most `maxPageLimit` items) and then filters by `checkout_id`, `kind`, and `state`, so a filtered call can return fewer matching items than `limit`; following `nextCursor` is the only way to reach matches on later pages.
- **Log reads are capped per call** — `maxLogBytesCap` (default 16 KiB) is a ceiling the caller cannot raise, so longer output needs cursor pagination, and output the runtime has already discarded stays unreachable.
- **A mutating call needs the host approval seam and a calling Agent** — under `approvalPolicy: 'ask'` a composition that mounts no approval service, or an execution without a calling Agent, rejects every mutating operation before any lifecycle side effect; only `'allowed-once'` grants. `approvalPolicy: 'never'` rejects all of them without asking.
- **Native launches need the native provider and a Host-realm shell** — `service_control` builds the native launch adapter from the optional native provider, so a composition without one leaves native start and restart to the runtime's explicit `Service provider unavailable` refusal while Docker control and every read keep working. A launched range is Host-owned and outlives the initiating session, so it carries the shell executor's deployment policy rather than a session-scoped sandbox escalation.
- **An unreachable provider degrades the listing, not the call** — when the Docker daemon is unreachable the container surface arrives as a non-`ready` provider with a reason, rendered as a `Provider warnings:` line, and container services carry the `[stale]` tag; native services stay visible and no call fails because of the provider.
- **One target per control call** — the tools mutate a single target or start one definition; a Docker/Compose group appears in the listing with its member ids, and stopping a group is one control call per member.
- **Read access is not narrowed** — `canRead` grants every observed resource to the Agent access, so read filtering is left to the runtime and its providers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run the tool spec with `pnpm exec vitest run packages/workspace/tool-project-services`; it drives all three tools through a mock `ProjectServiceRuntime` and loads the real native provider for the agent-execution cases, needing no key and no Docker daemon.

</details>

**Runtime invariant:** No runtime invariant companion is published. The tools read and mutate state the project-services runtime owns, and no relationship this package holds is independently observable.
