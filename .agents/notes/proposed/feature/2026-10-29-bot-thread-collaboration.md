# Agent Note: Multi-bot group collaboration over a thread bus

Status: proposed

English | [中文](2026-10-29-bot-thread-collaboration.zh.md)

## Problem

Three Zhiliao capabilities each stop at one Session, so no combination of them can host an overview bot plus one project-manager bot per project.

Projects (`ctx.workspaceRegistry`) keep named, ordered directories and group Sessions into them, but expose no tools, prompts, or events to a model. Tasks are Session-scoped: `todo_write` replaces the whole list of the Session that created it, `goal` holds one objective per Session, and plan mode belongs to one Session. Delegation (`ctx.subagents`) runs parent to child, so two sibling agents cannot address each other, and a child's state is only discoverable through its parent.

What the product needs is a set of independent, long-lived agent Sessions that talk to each other through a shared medium, plus a task record that outlives any single Session. People already understand a chat group as that medium, so the group should carry messages and notifications while a project-level task record stays authoritative. Treating the group transcript as state would make every conclusion a search problem and every restart a replay problem.

## Proposal

Add a `bot` package group and a `bot` profile bundle. A bot is an independent persistent Session bound to a role and an optional project. A thread, backed by one IM group or topic, is the message bus between bots and people. A project-level task domain is the authoritative state.

### Packages

| Package | Responsibility | ctx key |
|---|---|---|
| `bot/thread` | Threads, messages, per-bot read cursors, mention parsing, turn budget, and cooldown | `ctx.threads` |
| `bot/supervisor` | Bot registry, thread-to-project-to-participant bindings, wake-up decisions, bot Session creation and resumption, and turn queueing | `ctx.botSupervisor` |
| `bot/task` | Project-level task records over `storage-domain`, following the workspace registry pattern | `ctx.botTasks` |
| `bot/channel` | Channel seam: normalize inbound IM events and render outbound messages | `ctx.channels` |
| `bot/channel-lark` | Lark adapter that only depends on the seam | — |
| `bot/tool-thread` | Model tools `thread_read` and `thread_post` | registers on `ctx.tools` |
| `bot/tool-task` | Model tools `task_create`, `task_update`, and `task_list` | registers on `ctx.tools` |
| `bot/presets` | Main-bot and PM-bot personas and tool-set differences | — |
| `bundle/bot-app` | A `dsh.bundle.patch` that assembles the rows above into a `bot` profile | — |

### Thread model

`ThreadMessage` carries an id, a thread id, a per-thread monotonic `seq`, a sender (`{ kind: 'bot' | 'human', id }`), a mention list of bot ids, a kind (`request`, `status`, `result`, or `note`), text, optional task reference, and creation time. Each bot keeps a read cursor per thread, so a turn receives only messages after that cursor.

A mention is a directed handoff. Posting without a mention is a broadcast, and a broadcast from a bot never wakes anyone.

### Routing and wake-up

Each thread binds exactly one owner bot through `ownerBotId`. The supervisor applies one rule set:

- A message with mentions wakes each mentioned bot that is a thread participant; mentions of non-participants are dropped.
- A message without mentions wakes the owner bot only when the sender is a human.
- A bot-authored message never wakes anyone through the no-mention rule; a bot that wants to hand work over must mention its target.
- Every wake consumes a per-bot, per-thread turn budget and respects a cooldown between turns. Budget size and cooldown are `Config` fields.
- An exhausted budget records the message as deferred and posts nothing, so the group is not flooded.

The supervisor, not a prompt, decides who wakes; a prompt-level rule would be unenforceable and untestable.

### Bot sessions

The main bot spans every project, reads project summaries, and may post to any bound thread; it has no task-writing tool. A PM bot is bound to one project, owns task writes, and may spawn worker subagents. Workers are ordinary subagents, so only the PM-to-worker relation is parent to child.

Phase 1 binds one project to one thread, and the PM bot is also the thread owner. Multi-thread projects, human assignees, and scheduled inspection are deferred.

### Project task domain

`ProjectTask` carries an id, a project id, a title, a description, a status, an assignee, a thread reference, a creator, an optional result, and an update timestamp with a version. The status machine is `todo → doing → blocked → done | cancelled`. In phase 1 an assignee is always an agent bot.

Records live in `storage-domain` the way workspace records do, so they survive restarts and stay outside any Session log. A projection emits every status change as a `status` message on the referenced thread; the model is not relied on to announce it.

### Session log

Two `SessionEventMap` members are added: `thread/message` for the inbound range delivered to a bot, and `thread/post` for an outbound post. Both are required, because group content reaches the model and the Session log must reconstruct it. Adding these members updates the TypeScript and Python SDK expected outputs and needs a persistence-type change acknowledgement.

### Channel seam

`ctx.channels` normalizes inbound IM events into `ThreadMessage` values and renders outbound posts. `channel-lark` is the only phase-1 adapter. One IM application account presents multiple bot identities, so a new bot costs a binding row rather than a new IM application. Inbound events dedupe on the IM message id, and outbound retries carry an idempotency key.

### Multi-tenancy and authorization

A bot's visibility is structurally bounded, not prompt-bounded. Each bot can read and post only to threads listed in its supervisor binding; `thread_read` and `thread_post` reject any thread outside that set before the model is involved. Bot A therefore cannot read bot B's thread by construction, because `ctx.threads` queries are scoped to the caller bot and its bound threads.

The tenant boundary is the IM application account (or its platform tenant id). Threads, tasks, and bot Sessions from different tenants are stored under separate storage-domain namespaces and are never joined in a query. A cross-tenant reference is a data error, not a permission check.

IM application credentials (app id, app secret, webhook signing secret, access token) live in the credentials service's encrypted store. A channel adapter never holds the master secret; it requests a short-lived, scoped lease from the credentials service and uses that lease for the current send window. Credential rotation is owned by the credentials service; the adapter re-reads the current lease on each turn.

Inbound sender identity is taken from the platform-verified IM identity after the channel adapter verifies the webhook signature; it cannot be set by the model or a client. Outbound posts use the bot's bound IM identity, fixed at supervisor registration.

### Streaming back-projection

The channel seam's outbound renderer subscribes to the bot Session's event stream and maps assistant-message deltas and tool-result deltas onto the target IM platform's send primitive.

On platforms that support message editing (Lark, Slack, Discord), one assistant turn accumulates into one IM message, updated at a throttled interval and finalized when the turn ends. On platforms that do not support editing (QQ, WeChat, older Telegram bot APIs), the turn degrades into multiple shard messages. The shard policy is a `Config` field set: maximum shard size, minimum send interval, and whether consecutive plain-text shards merge.

All outbound actions share one throttle per bot per thread, independent of the turn budget. Throttle parameters are `Config` fields.

Retry and idempotency reuse the channel seam's existing outbound retry with idempotency keys; there is no second retry semantics. A streaming shard's idempotency key is the bot turn id plus the shard seq; the final message's key is the bot turn id. A failed retry replays only the failed shard, not the whole turn.

Whether intermediate tool-call and tool-result states are projected to IM is a `Config` choice; by default only the final assistant text and explicit `thread_post` calls are projected.

## Reference implementation comparison

The following judgments are distilled from a measured Grok Bot 0.78.1 architecture on this machine. Each entry states what Grok Bot does only to derive what it means for this proposal; Grok Bot is not a dependency.

**Control plane and data plane separation.** Grok Bot's control plane only exchanges credentials (leases); all business traffic goes through a single data-plane gateway, and credentials are not presented again on each business request. For this proposal, obtaining IM application credentials (exchanging a token) and using them (sending a message) are separate steps inside the channel seam. An adapter never holds business-side permission; it holds only a short-lived token obtained from the lease.

**Leased authorization.** Grok Bot exchanges one set of scoped, port-bound tokens (gateway, exec, vnc) instead of a single global administrator credential. For this proposal, when `ctx.botSupervisor` dispatches a turn it issues a scoped, time-bound grant covering the thread set the turn may read or write and the tool subset it may call. A bot Session never holds full channel credentials; the grant expires at turn end and is reissued on the next turn.

**Durable execution decoupled from liveness.** Grok Bot's coordinator, daemon, and signer are separate processes; a UI crash does not stop execution, and the daemon carries a supervisor plus a lease durability file that survives restarts. For this proposal, a bot Session's liveness is not bound to any client connection. An inbound message is persisted to thread storage before the wake-up decision; a failed wake-up can be replayed from the persisted message. The supervisor's binding table and read cursors are durable and resume on restart.

**Long-lived connection parameters are deployment configuration.** Grok Bot treats connection timeout, stall detection, backoff multiplier, and health-probe interval as first-class parameters. For this proposal, the channel adapter's connection timeout, stall detection, backoff multiplier, health-probe interval, outbound throttle interval, and shard size are all `Config` fields, never `DEFAULT_*` constants.

**Risk control attributed explicitly, not bypassed.** When Grok Bot hits platform risk control, it settles into a structured error type and reports with backoff instead of matching feature strings and attempting evasion. For this proposal, when a channel is rate-limited or banned by the platform, the adapter emits a structured error state carrying the platform error code, the attribution, and a suggested backoff. The error is handed back to a human or the supervisor cooldown; it is not retried until banned. The error is recorded on the thread, not fed into the model prompt.

**Event bus dispatched by domain.** Grok Bot uses one SSE endpoint that dispatches multiple event classes by channel instead of one connection per event class. For this proposal, the dispatch relationship between thread events (message, post, status) and Session events (assistant delta, tool) is stated once: the channel seam's outbound side subscribes to the bot's Session event stream and routes by event type to renderers, while the inbound side normalizes IM events into `ThreadMessage` and delivers them to `ctx.threads`; the two buses meet at the bot turn boundary.

## Alternatives considered

**Delegate everything through subagents.** A PM bot could treat each task as a child and expose nothing else. This loses because children are visible only to their parent, so the main bot cannot summarize project work without walking every tree, and a task's state disappears with its parent Session.

**Keep tasks in an external system.** Lark tasks or GitHub Issues would make work visible to people outside the group. This loses for phase 1 because the model surface then depends on external permissions, latency, and an MCP server before the collaboration model exists at all. The channel seam leaves this open as a later mirror.

**One shared Session per group with a model-chosen speaker.** This is the AutoGen `GroupChatManager` design and it works for free-form collaboration. It loses here because every bot would share one context and one Session log, so a PM bot's project memory would be diluted by unrelated threads, and the authority for "who speaks next" would sit in a prompt instead of an enforceable policy.

**A dedicated owner bot per thread.** Separating reception and routing from project work would keep delegation clean. It loses for phase 1 because it doubles the bot count and the bindings; the PM bot already owns the project context the owner role needs.

**Treat the group transcript as the task state.** This would avoid the storage domain entirely. It loses because status then has to be inferred from prose, restarts replay an unbounded transcript, and two bots can hold conflicting readings of the same thread.

## Acceptance criteria

- A human posts in a bound thread without a mention, and only the PM bot runs a turn whose Session log records that message.
- A human mentions the main bot in a project thread, and only the main bot runs.
- A bot posts without a mention, and no Session runs a turn.
- Exhausting a bot's turn budget leaves the message in the thread, records it as deferred, and starts no turn.
- `task_create` followed by `task_update` produces a `status` post on the thread without the model asking to announce it.
- Restarting the `bot` profile resumes each bot Session and each read cursor, so no message is delivered twice and none is skipped.
- Unit tests cover wake-up decisions, budget exhaustion, cooldown, and cursor advancement.
- A real-composition test boots a test-only `cordis.yml` with a fake channel adapter and asserts that the thread, the task records, and the Session log agree.
- Snapshots pin the PM bot's request-to-task-to-reply transcript and the main bot's project summary.

## Risks

- **Loop pressure.** Two bots can keep answering each other. The no-mention rule for bot messages, the turn budget, and the cooldown are the only barriers in phase 1; if they prove insufficient, phase 2 needs an explicit handoff consent step.
- **IM as a single point of failure.** A channel outage delays every bot. Phase 1 fails loudly and retries outbound posts with idempotency keys instead of hiding the outage.
- **Session growth.** One persistent Session per bot grows without bound. Compaction is available but unproven for long-running bot Sessions, and the main bot's summary path may need its own projection later.
- **Name collision.** "Task" here means a project work item; it is unrelated to the structured-UI `show_task_surface` tool in the task-surface proposal. The packages and tools keep the `task` names, and the docs must state the distinction.
- **Deliberately deferred.** Multi-thread projects, human assignees, automatic inspection, and multi-worker concurrency are out of scope, so a project with two parallel work streams has no representation yet.

## Related

- [Workspace subsystem](../../../../docs/subsystems/workspace.md) — the durable project registry and the `storage-domain` pattern reused by `bot/task`.
- [Subagent subsystem](../../../../docs/subsystems/subagent.md) — the parent-to-child delegation contract that worker sessions use.
- [Task Surface proposal](2026-08-04-task-surface.md) — the unrelated structured-UI meaning of "task" in this repository.

## Revision note

This revision adds three sections — "Multi-tenancy and authorization", "Streaming back-projection", and "Reference implementation comparison" — and folds the reference-implementation judgments into the channel-seam design. The comparison source is a measured Grok Bot 0.78.1 architecture on this machine. No existing acceptance criterion or risk was retracted.
