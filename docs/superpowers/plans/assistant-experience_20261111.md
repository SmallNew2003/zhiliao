# Personal assistant follow-through implementation plan

English | [中文](assistant-experience_20261111.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Turn the existing assistant into a usable place to ask for work, follow progress, and receive results, while fixing cancellation and failure recovery.

**Architecture:** Keep one shared assistant task domain and ordinary execution Sessions. Reuse Conversation through its registered factory inside the assistant page; keep task navigation and progress alongside it. Derive progress and bounded result summaries from durable execution facts, expose scoped model reads, and deliver attributable completion notices through the existing durable inbox.

**Tech stack:** TypeScript, Cordis, React, CSS Modules, Typert Remote, Vitest, existing dsh Web profile and recorded-session harness.

**Spec:** The user approved the implementation findings and requested agent execution in this chat; the acceptance requirements below are the working specification. The separate multi-bot/thread proposal is not this implementation's scope.

## Global constraints

- Work only in `/Users/jelvin/.codex/worktrees/assistant-experience/zhiliao`, branch `codex/assistant-experience-20261111`, based on `codex/local-testbed-integration-20261106`. Do not change master, existing worktrees, installed apps, or publish.
- Keep global and project assistant scope, normal execution approvals, ordinary user Session navigation, and Schedule's independent domain and Automation view. Do not add IM/thread/supervisor packages.
- Read applicable AGENTS.md, architecture, defensive patterns, error-handling, prose, lifecycle, and test-reliability skills. Use Node v24.19.0 through `/Users/jelvin/.nvm/versions/node/v24.19.0/bin`.
- Preserve existing task records. Optional persisted additions need decoder compatibility and declared persistence-type review; changed externally visible APIs need their upgrade guide. Do not add unknown casts.
- Use typed locale dictionaries in all supported locales, existing shared controls and semantic tokens, existing Conversation/SessionProvider composition, and effect-scoped registrations. Do not fork a chat renderer or bypass model/approval gates.
- Baseline is the four assistant-focused files: 24 tests passed on this fresh worktree before implementation. Write meaningful failing regression tests before fixes. No full repository test suite by default.
- Agents share this worktree but own disjoint files. No agent may stage, commit, switch branches, run generators/builds across other owners, or spawn another agent. The controller coordinates serialized generation, validation, and review after changes settle.

## Acceptance requirements

- Opening Assistant displays a usable scoped conversation plus an accessible task panel; users can submit to the selected assistant without leaving the page. At 390 CSS px, conversation and tasks remain reachable without overlap or page-wide horizontal scrolling.
- A new global assistant can accept input without an owning Workspace. Ordinary blank user Sessions retain their Workspace prerequisite; model availability and approvals remain enforced.
- The model can read scoped task progress and results through `list_tasks` and `get_task`. Completion or failure produces an attributable, deduplicated durable notice for its actual creating assistant Session; it is not represented as a human instruction or a successful task when the outcome is unknown.
- Task summaries are bounded by validated configuration, preserve result attribution, survive restart, and reach list/detail reads. Existing records without new fields still load.
- Cancellation immediately blocks new work and visibly reports cancelling while active execution drains; cancelled is committed only after quiescence. Do not await worker settlement while holding a write queue needed by that settlement.
- Task cards subscribe to current task state. The task list offers active/waiting/completed views and accessible history loading beyond the Host's default 50 rows, retains data on transient failures, and labels cancel failures separately from load errors.
- Fast project switching cannot open or submit to the wrong assistant. Concurrent refreshes and plugin disposal cannot publish stale state; temporary visibility failures cannot expose hidden Sessions.
- Add focused service and rendered-component regression coverage, a real assembled Web interaction case and recorded-session coverage for new model-visible tools/notices. Record a GIF from the real server and model flow; do not substitute a static mock for behavior evidence.

### Task 1: Durable task follow-through and lifecycle

**Files:** Own `packages/assistant/task/**`, `packages/assistant/tool-task/**`, `packages/bundle/web-app/presets/assistant.patch.yml`, their package docs, and new narrowly scoped task-domain persistence/upgrade/decision records. Do not edit `packages/client/**` or shared generated artifacts.

**Consumes:** Existing task creation, execution Session events, scoped tool registration, and ordinary durable inbox APIs.

**Produces:** `AssistantTaskStatus` additionally permits `cancelling`; `AssistantTaskView` adds optional `resultSummary?: string`; `assistantTasks/task` accepts `{ id: AssistantTaskId }` and returns the authorized `AssistantTaskView`; existing `tasks({ assistantId?, workspaceId?, limit?, offset? })` continues to work. Add `list_tasks` and `get_task` beside `create_task`, scoped to registered assistants. Coordinate any unavoidable interface change before consumers implement it.

- [x] Write regression cases for cancellation drain/deadlock and failure, persisted legacy records, scoped query denial, summary persistence, completion attribution/deduplication/restart, and interrupted/unknown outcomes. Use deferred promises and explicit event barriers, not timing sleeps.
- [x] Run the affected service/tool files and record the expected failing assertions. Add the minimum lifecycle, reads, summary projection, and durable notification implementation through current extension points; no agent-loop edits.
- [x] A representative cancellation assertion is `expect(service.getTask(taskId)?.status).toBe('cancelling')` while the fake Agent's `whenIdle()` promise is pending; resolve it, await cancellation, then assert `cancelled`. A notification retry must preserve the same notice identity and one inbox input after restart.
- [x] Re-run your focused tests, update bilingual owning docs and compatibility records, inspect the diff, and write a report with exact commands/results, interfaces, limitations, and files. Leave changes unstaged for controller review.

### Task 2: Assistant workspace, live cards, and client recovery

**Files:** Own `packages/client/ui-assistant/**` only, including its rendered-component tests, manifests and bilingual docs. Do not edit Conversation internals or Host sources.

**Consumes:** Task 1's optional result summary, cancelling status and single-task read; Task 3's `conversation.embedded` factory. Existing task list APIs provide Host-default pages via `offset`; do not silently restrict history to the first page.

**Produces:** A refined assistant page with global/project selection, embedded conversation, adjacent task panel, live status/result cards, history loading and per-operation error/retry state. Preserve selected state and retained task/visibility data across transient failures.

- [x] Write rendered tests that fail for the current empty management page: an assistant conversation is rendered without leaving the panel, current task state replaces creation-only labels, cancellation errors retain rows, later history pages remain accessible, stale project responses cannot change the selected assistant, and failed visibility reads retain hidden ids.
- [x] Use the framework SessionProvider with the selected assistant's Session reference and an assistant-owned session-scoped child. That child renders `conversation.embedded`; never pass a Session id directly to `renderFactorySlot` or import another plugin's concrete component.
- [x] Use shared Button/Menu/EmptyState/loading patterns and semantic CSS tokens. Provide useful empty instructions and an obvious way to start; status groups show work needing attention and finished results. Narrow screens expose both areas without discarding input or primary actions. Keep English sentence case and update all locale keys.
- [x] Keep task cards driven by Host state and single-task lookup, with result-summary access and explicit open/cancel actions. Keep history paging and project selection scoped and generation-guarded; a transient read failure must not replace retained data with an empty array.
- [x] Run focused rendered and plugin tests, inspect responsive/light/dark rendering when the controller's server is available, update owning docs, and report evidence plus any missing seams. Leave changes unstaged for controller review.

### Task 3: Reusable embedded Conversation and real-flow verification

**Files:** Own `packages/client/ui-conversation/**`, and assistant-focused Web/recorded-session fixtures and tests under `apps/web/tests` and `snapshots`. Do not edit `ui-assistant` or Host task files. The controller serializes shared generated outputs and broad builds.

**Consumes:** Existing `conversation.content`, SessionProvider scope, Session projections, real dsh profile test infrastructure, and the delivered Host/UI feature once available.

**Produces:** Registered `conversation.embedded` factory with Session scope and input `{ workspaceMode?: 'required' | 'optional' }`; it computes the existing Conversation phase and renders shared content with embedded layout. Extend the existing content input with the same optional policy where necessary. Default is required; Assistant calls optional without weakening Host authorization, model selection or normal Workspace-bound Session behavior.

- [x] Add rendered regression tests proving an ungrouped global assistant can type through the explicitly optional embedded occurrence, and a normal blank main Session still requires a Workspace. Cover normal composer controls, pending model selection, focus and cleanup.
- [x] Implement the reusable factory and smallest scoped Workspace policy change. Reuse existing phase logic and public declarations; provide JSDoc and bilingual documentation for the new supported factory input.
- [x] Add a deterministic assembled Web case covering Assistant selection, in-page conversation, task creation/status/result card and retained navigation. Include a real recorded-session scenario for model-visible `list_tasks`/`get_task` and completion notice; use the existing fixture/recording conventions, never fabricated expected logs or dummy assertions.
- [x] Coordinate with Task 1 and Task 2 when their sources are ready. Run your focused component/fixture checks; identify commands that need built artifacts or a real provider so the controller runs them once. The controller owns real-server GIF capture and final integration validation.
- [x] Report exact coverage and remaining environment constraints. Leave changes unstaged for controller review.

## Controller verification and review

After each task completes, save a path-scoped diff and its implementer report for independent spec/quality review. Integrate only after important findings are addressed. Once all edits settle, generate Typert/catalog/persistence artifacts in one serialized phase, run relevant focused tests, `build:artifacts` then `build:check` (or the branch's equivalent), documentation gates, lint and diff checks. Use the actual implemented server and model flow for browser/GIF evidence; explicitly report unavailable real-provider checks. Run one broad independent branch review and its required repair/re-review before delivery. Keep the worktree for user review, without merging, publishing or replacing their installed application.
