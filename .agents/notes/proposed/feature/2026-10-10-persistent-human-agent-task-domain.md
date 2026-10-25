# Agent Note: Persistent human-and-agent task domain

Status: proposed

English | [中文](2026-10-10-persistent-human-agent-task-domain.zh.md)

## Problem

`tool-todo` already gives an agent a visible task list, but its design premise is "one agent session planning its own current work," not a transaction list a person manages over time: the list belongs to the single session that created it, every `todo_write` replaces the whole list, entries have no stable identity, and `TodoItem` carries only `content` plus three states. Wholesale replacement is the right trade for in-session planning — rewriting a plan costs fewer tokens and produces fewer mistakes than diffing it entry by entry — but it cannot answer "this item I raised last week, which the agent says is done, what actually came of it."

The product therefore lacks a task domain that spans sessions and projects and that a person and an agent hold together. What is missing is not another list tool but durable records, stable identity, partial updates, and a permission boundary.

Three real requirements exist at once, and they differ not in data shape but in **who is authoritative** and **who consumes**: a personal affairs list (the person records, the agent helps push), a project task board (person and agent maintain it together), and an agent dispatch board (the person assigns, the agent executes). Building three separate entities leaves three copies of data, three UIs, and three permission rules drifting apart; building only one of them leaves the other two homeless.

## Proposal

Add a durable task domain carried by [`storage-domain`](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md): each task is one KV record with a stable id, and the model and the UI read and write the same data. The task domain coexists with `tool-todo`, references neither, and serves its own scenario.

### Three requirements, two scopes, one attribute

A personal list and a project board differ by **ownership**; a dispatch board differs by **executor**. Ownership is a discriminated union, and the executor is a nullable attribute:

```text
TaskScope = { kind: 'inbox' }                      // personal affairs, no project
           | { kind: 'project', workspaceId }      // belongs to a workspace project

TaskAssignee = null                                 // unclaimed
             | { kind: 'session', sessionId }      // dispatched to a session's agent
```

The dispatch board falls out of this: scope is `inbox` or `project`, and assignee names a session. It needs no third scope, because its record shape is identical to the other two — the difference is only who reads the list and who may change it.

When a workspace project is removed, tasks attached to it are **not deleted**: scope degrades to `{ kind: 'inbox' }` and the former `workspaceId` is retained in `detachedFrom` for traceability. This matches workspace's own guarantee that removing a project never deletes its sessions or folder.

### Record shape

```ts
type TaskStatus = 'open' | 'doing' | 'blocked' | 'done' | 'dropped'

type TaskBlockReason = { code: string, message: string }   // lower-kebab-case routing code plus human-readable explanation
```

```text
TaskRecord = {
  id: TaskId                       // branded uuid, stable across restarts
  title: string                    // one imperative line, the primary UI label
  note?: string                    // longer description; where the agent records the outcome
  status: TaskStatus
  blockedReason?: TaskBlockReason // present exactly while status === 'blocked'
  scope: TaskScope
  assignee?: TaskAssignee
  due?: string                     // ISO-8601 absolute instant; reminders are schedule's job
  origin: 'human' | 'agent'        // who created it — the basis of every permission rule
  createdAt: string
  updatedAt: string
  updatedBy: 'human' | 'agent' | 'system'
  detachedFrom?: WorkspaceId       // former owner after project removal, trace only
}
```

`status` carries five states rather than three, and the two additions each earn their place: `blocked` means "stopped on a problem" and reuses the routing-code convention of [goal's `blocked`](../../implemented/feature/2026-07-19-persisted-same-session-goal-domain.md); `dropped` is the single disposal channel, which makes "deletion" permanently reversible.

`origin` and `updatedBy` are not audit decoration — they are the only input to permission decisions. Remove them and the permission rules degrade into "the model may change whatever it likes."

### Permission boundary

What an agent may write is decided by two dimensions: who created the record, and which direction the status moves.

| Operation | `origin: 'human'` record | `origin: 'agent'` record |
|---|---|---|
| create | allowed | allowed |
| change `title` / `note` / `due` | allowed | allowed |
| `open` → `doing` / `doing` → `done` | allowed | allowed |
| set `blocked` (with code and explanation) | allowed | allowed |
| `done` → `open` (revert) | **refused** | allowed |
| `dropped` | **refused** | allowed |
| physical deletion | never | never |

Three negative guarantees deserve their own statement.

**An agent cannot move a task back to unfinished.** By the time a model judges work incomplete, the task has already consumed a person's attention; reverting it makes the same entry occupy the list over and over, and it gives the model an incentive to classify anything uncertain as a state other than done. To undo a completed task, an agent must create a new one whose `note` states what it is undoing and why, leaving the merge to the person.

**An agent cannot drop a person's task.** `dropped` is terminal but retains the record, and the person can restore it from the UI.

**There is no physical deletion.** Every removal is a `dropped`, leaving the record and its `updatedBy` in storage.

**An agent completing a task must write a `note`.** `task_complete` requires a non-empty explanation. It is a completion check for the agent itself — being unable to say what was done usually means it was not — and it is the only part of the record still worth anything three months later. This is tool-layer admission, not a prompt suggestion.

### Tool surface

The model-facing tools are op-shaped, the counterpart to `todo_write`'s whole-list replacement:

- `task_create(title, scope?, due?, note?)` → returns `TaskId`
- `task_update(id, { status?, note?, title?, due? })` → subject to the permission table above
- `task_complete(id, note)` → `note` non-empty
- `task_block(id, code, message)` / `task_unblock(id)`
- `task_list(filter?)` → filter by scope, assignee, status
- `task_drop(id, reason)`

No wholesale replacement and no "delete." Filtering happens in the storage layer and returns only ids and title summaries; full records are read one at a time on demand, so the whole list never lands in context.

### Context cost

A durable list can grow without bound, so injection is **zero by default**. Starting a session puts nothing from the task domain into the prompt, with two exceptions: the titles of tasks whose assignee is the current session and whose status is neither `done` nor `dropped`, and tasks whose `due` falls in a near-term window. Everything else is pulled explicitly by the model through `task_list`.

The rule is deliberate: the list is unbounded and context is not. Injecting "all outstanding work" as routine adds a growing bill to the start of every session.

### Division of labor with `tool-todo`

The two coexist, reference neither, and keep separate data and lifecycles:

| | `tool-todo` | task domain |
|---|---|---|
| ownership | one agent session, exclusive | cross-session, shared with a person |
| update | wholesale replacement, last-write-wins | single-record ops, stable id |
| identity | none, entries recognized by `content` | `TaskId`, stable across restarts |
| lifecycle | follows the session log, ends with the session | long-lived |
| purpose | how this session's work is progressing | the state of the thing itself |

There is no automatic synchronization. Steps a model plans in a session do not enter the task domain on their own; promoting a planning entry into a durable task is an explicit `task_create` call that requires judging whether it deserves to outlive the session. The reverse is equally absent: task-domain entries are never pushed into an agent's in-session planning list.

### It does not drive the agent loop

The task domain **triggers no automatic execution**. `task_complete` does not start a turn, and an assignee naming a session does not wake that session. The task domain is a record that gets read and written, not a scheduler.

Dispatch-means-execute — waking a closed session whose assignee names it — requires cross-session scheduling, exclusive write ownership, and failure-retry semantics, which is the same class of problem as [goal's round driver](../../implemented/feature/2026-07-19-persisted-same-session-goal-domain.md). This proposal deliberately does not touch it. A dispatch board here means "the person assigns ownership, and the agent sees the task when it is next invoked," not "dispatch triggers execution."

### UI

A new `ui-task` sidebar panel following the established `ui-goal` / `ui-schedule` pattern: static registration, grouping by project directory, status filtering. `storage-domain` emits `domain/changed` after every write has reached durable storage, so ticking an item from inside a session updates the panel without polling.

The panel must expose `origin` and `updatedBy` — a user needs to see which items the agent added and which it touched.

## Alternatives considered

**Extend `tool-todo` instead of adding a domain.** Not adopted. Its three properties — single-session exclusivity, wholesale replacement, identity-free entries — are correct for in-session planning, not technical debt awaiting cleanup. Folding durable tasks into that package means overturning all three contracts while making two incompatible semantics (scratchpad and long-lived list) compete for the model's attention inside one tool description. The cost is redoing the existing snapshots and invariant companion plugins; the benefit is saving one package name.

**Build a standalone application and connect it to the agent over MCP.** Not adopted. That yields two UIs, two copies of data, two processes, and one seam that must synchronize in both directions: when the user ticks an item in the standalone app the agent side must notice, and when the agent writes an item the app must see it live. Meanwhile the host already has everything required — `storage-domain` for cross-restart durability and change events, `workspace` for project scope and lifecycle guarantees, `ui-schedule` / `ui-goal` for the sidebar panel pattern. A standalone app discards every one of those blocks and reimplements it.

**Persist tasks through session event sourcing, the way `goal` does.** Not adopted. `goal`'s persistence rests on the goal belonging to one session, so `goal/change` entering the session log is natural. Tasks exist across sessions — a personal affair belongs to no particular session — so putting them in a session log makes a task's identity depend on whichever session created it first, and fork and replay would duplicate it into unrelated copies. `storage-domain`'s per-id reads and writes plus change events are exactly what this shape needs.

**One big JSON array of tasks rather than a record per task.** Not adopted. A big array can only be read and written whole, which carries `todo_write`'s last-write-wins straight into a durable domain: when a person and an agent each change one entry, the later write erases the earlier one, and nothing can address an entry by id or update a single row in the UI. `storage-domain`'s kv facet persists per record precisely for this shape.

**Carry the three requirements as three separate entities.** Not adopted. Three schemas drift independently, a fourth requirement has nowhere to land, and the result is three permission rule sets, three UIs, and a user hunting for the same item in three places. Scope plus assignee lets all three share one record, at the price of `assignee` usually being empty in the personal case — a plainly smaller price.

## Acceptance criteria

- A task remains readable by `TaskId` after a host restart, with `createdAt` / `updatedAt` / `origin` unchanged.
- A person and an agent alternate writes on the same record, each affecting only fields they are authorized for; an agent's `done` → `open` and `dropped` calls against an `origin: 'human'` record fail with a specific reason and leave the task unchanged.
- `task_complete` fails when `note` is missing or empty, writing no status change.
- No path physically deletes a task record; a `dropped` record retains every field and its `updatedBy` and is restorable from the UI.
- At session start the prompt contains only the titles of incomplete tasks assigned to the current session plus near-term `due` tasks; task records outside an explicit `task_list` never reach context.
- `tool-todo`'s existing snapshots and behavior are unchanged; task-domain records never appear in a `todo_write` list, and `todo_write` entries never appear in the task domain.
- After a workspace project is removed, its attached tasks stay readable, scope degrades to `inbox`, and `detachedFrom` retains the former `workspaceId`.
- Writes to the task domain produce no session events, start no turn, and wake no session — including when assignee names a closed session.
- `domain/changed` keeps the UI panel current after an agent-side write, with no refresh or polling.
- Prefix snapshots show that the task tool definitions the model sees stay stable as task count and status vary; only call arguments change.

## Risks

**Context budget is where this design is most likely to go wrong.** The near-term `due` window and the assignee injection are hardcoded heuristics. Once the list reaches a few thousand entries they become a fixed per-turn cost. The mitigation is making both injections optional, and accepting that with them off an agent must call `task_list` explicitly to see its own work.

**The model holds the judgment on `blocked` and `done`.** The permission table constrains direction, not judgment quality. A model may mark large numbers of tasks `blocked` to avoid pushing forward. Requiring a code and explanation on `blocked` makes such misuse visible in the data, but visible is not the same as handled.

**The task domain invites scope creep.** A list that carries `due`, grouping, and an origin marker is one request away from subtasks, dependencies, tags, comments, and priorities. Each turns a record from "the state of one thing" into a project-management system. The first version refuses those fields outright; the moment they start appearing, it is time to reconsider whether this is becoming an issue tracker.

**Coexisting with `tool-todo` confuses users.** Two lists, one vanishing with the session and one that persists, can leave traces of the same item in both. Naming and visibility are the mitigation: the sidebar panel shows only the task domain, while `todo_write` stays visible only inside a session. If that proves unworkable, this proposal should be rejected rather than evolved further.

**Concurrency relies on the write chain, not a revision number.** `storage-domain` serializes writes per domain and never interleaves the transform inside `update`, so optimistic locking is unnecessary. But a check of the form "allow this only when the current status is X" can only read the state and refuse inside the transform of a single `update`; conditional updates spanning two calls ("read status → decide → write") are not supported. Every current permission rule is decidable within one call; a future need for cross-call conditions requires adding a revision to the domain first.
