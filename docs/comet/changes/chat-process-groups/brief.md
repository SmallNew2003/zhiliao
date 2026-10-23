# Outcome

English | [中文](brief.zh.md)

Change the `ui-chat` Compact conversation display to a Codex/Qoder-style sequence of response segments and semi-collapsed process groups: visible Assistant text remains the segment summary, while consecutive reasoning, tool calls, and retry rows between responses are grouped by time segment; running groups expand, completed groups collapse by default, and expanded group content scrolls within a height limit so the full execution log does not fill the conversation.

# Scope

- Chat Node projection, grouped rendering, folding interactions, localized copy, styles, and related tests in `packages/client/ui-chat`.
- `Compact` conversation display uses process groups; `Normal` retains its current flat presentation.
- Update the current “turn process folding” behavior in `packages/client/ui-chat/README.md` and `README.zh.md`.
- The user-provided Qoder screenshot is a behavior and visual reference, not a brand asset to copy; implementation uses existing design tokens, icons, and type scale.

## Source coverage

| Source item and location | Read status | Content to preserve | Spec location | Acceptance ID | Coverage status | Reason or replacement |
| --- | --- | --- | --- | --- | --- | --- |
| S1: Screenshot, completed collapsed row | complete | A completed process group containing only reasoning shows a concise “Analyze request” summary and can expand | `specs/chat-process-groups/spec.md` “Completed groups show a summary and collapse by default” scenario | A7 | covered | Current requirement |
| S2: Screenshot, first Assistant response segment | complete | The visible Assistant response segment remains in the conversation stream and is not merged into a process group | `specs/chat-process-groups/spec.md` “Assistant responses delimit process groups” scenario | A3 | covered | Current requirement |
| S3: Screenshot, completed process summary | complete | A completed group containing tool calls generates a short description from deduplicated action types, shows at most two main action types without counts, and appends “Some actions failed” when a failure exists | `specs/chat-process-groups/spec.md` “Completed groups show a summary and collapse by default” and “Completed summaries describe only action types” scenarios | A7 | covered | Current requirement |
| S4: Screenshot, second Assistant response segment | complete | Later Assistant responses continue to delimit process groups before and after them while preserving original chronological order | `specs/chat-process-groups/spec.md` “Assistant responses delimit process groups” scenario | A3 | covered | Current requirement |
| S5: Screenshot, expanded “Running · 86s” row | complete | A running process group expands by default, and the title shows running state and elapsed time for the turn | `specs/chat-process-groups/spec.md` “Running groups start expanded” scenario | A6 | covered | Current requirement |
| S6: Screenshot, reasoning, search, terminal, web-page, and in-progress reasoning rows in a running group | complete | Per-item status rows remain inside the group, completed and running items are distinguishable, and each item can still collapse independently | `specs/chat-process-groups/spec.md` “Group content stays compact and expands independently” scenario | A9 | covered | Current requirement |
| S7: Screenshot, indentation line and fade area at the left of a running group | complete | An expanded group uses an indented, semi-collapsed container; content scrolls internally when it exceeds the height limit, with fades at scrollable edges | `specs/chat-process-groups/spec.md` “Expanded groups limit height and scroll internally” scenario | A8 | covered | Current requirement |
| S8: Screenshot, process content not filling the conversation | complete | Completed groups collapse; the process area of a running group has a height limit and does not spread the complete long log | `specs/chat-process-groups/spec.md` “Expanded groups limit height and scroll internally” scenario | A8 | covered | Current requirement |

# Non-goals

- Do not call a model to generate new process summaries or add model requests or model-visible inputs.
- Do not change Session events, persistence format, SDK projection, or trace view.
- Do not rework tool cards, reasoning Markdown, run-trace details, or the statistics panel.
- Do not add group headers to `Normal`; it continues to show process rows flat.
- Do not port the upstream complete multi-level work-details settings system.

# Acceptance examples

- When a completed turn renders “process group, Assistant response, process group, Assistant response, final answer”, the conversation order matches the log; both responses remain visible, both process groups can expand independently, and completed groups collapse by default.
- In a running turn, the current process group expands by default and shows running state and elapsed time; after the preceding response appears, the previous process group collapses by default while the latest process content in the group remains identifiable.

# Constraints and invariants

- Grouping changes presentation only: it must not change `SessionEventMap`, Session logs, model history, or response order.
- User messages, steering, system prompts, errors, max-token notices, and turn-tail remain independent and do not enter process groups.
- One Assistant Node can contribute two parts: reasoning enters the process group and visible text remains outside it; the same content must not render twice.
- A process group uses the stable identity of its first member as its key; streaming appends, turn completion, and history pagination must not change the relative order of existing members.
- Toggling collapse state must not remount stateful tool renderers; folding uses visibility, height, or scroll state.
- Child items inside a group continue to use existing reasoning and tool rows; when a group expands by default, its children still follow their own default collapsed state.
- Group titles, states, and summaries belong in the `ui-chat` locale dictionaries rather than hardcoded Chinese or English component text.
- Reused hidden process content continues to support browser in-page find; a match in hidden content opens the corresponding process group.
- Visuals use existing `--dsw-*` and `--dsh-*` tokens; expanded group content has a maximum height of `min(400px, 50vh)` with fades at the top and bottom scrollable edges.
- `Compact` is the default mode; `Normal` shows no group titles and does not cap process height.

# Decisions

- Use the existing visible Assistant text as the “brief summary” without generating additional text.
- Group boundaries are the next visible Assistant response or turn boundary; within a single Assistant Node, the presence of a response block determines how reasoning and visible text are split.
- Running groups expand by default; the title shows the current activity such as “Analyzing / reading / searching / running” and the elapsed time for the turn.
- Completed groups collapse by default; reasoning-only groups show “Analyze request”, groups with tools show at most two main deduplicated action types without counts, and failures append “Some actions failed”.
- Preserve the existing `Compact / Normal` preference; `Compact` applies process groups and `Normal` stays flat.
- Implement in the current `ui-chat` projection layer without introducing Session events or adopting the full upstream work-details mode architecture.

# Open questions

None.

# Verification expectations

- Add unit tests for grouped projection covering response boundaries, reasoning and response splitting, action-type ordering, failure state, and running and completed states.
- Add component tests for `ChatView` covering running group expansion, completed group collapse, internal height-limited scrolling, manual expansion, in-page find, keyboard operation, and flat `Normal` presentation.
- Run focused `packages/client/ui-chat` tests, repository type checking, and lint; if the change affects Web snapshots or accessibility assertions, update the corresponding owner-local expectations.
- Manually preview a Web conversation to confirm both running and completed states match the screenshot rhythm and that the complete execution log does not fill the conversation.
