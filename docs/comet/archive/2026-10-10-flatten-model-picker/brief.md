# Outcome

English | [中文](brief.zh.md)

Let users see provider-grouped models immediately after opening the composer model control, and adjust the current model’s reasoning effort in the same panel. Deliver this one UI change with a real page and interaction recording built from the current workspace for user evaluation.

# Scope

The composer model panel, local styles, necessary Chinese and English copy, package documentation, and affected component tests, browser tests, and UI snapshots. The [model picker specification](specs/composer-model-picker/spec.md) defines the complete behavior.

# Non-goals

This change does not alter the sidebar, context records, overall branding, Models settings, provider integration, routing rules, or `/model` interactions. Model search and recommendations are excluded. Merging, pushing, and publishing are outside this demonstration.

# Acceptance examples

- In a session that permits model selection, one click opens provider-grouped models and marks the current model without an intermediate Model submenu.
- When the current model supports reasoning, the same panel shows exactly its provider-declared efforts and current value. Models without reasoning omit this section; arbitrary efforts are not introduced and provider default semantics remain intact.
- Successful model or effort selection updates the trigger from the Host-confirmed result, closes the panel, and restores trigger focus. Selecting the current value closes without another write. Existing persistence scope and subsequent-request semantics remain unchanged.
- Arrow keys move among actionable options; Enter, Space, or the existing Tab gesture selects. Escape or Shift+Tab closes in one step and restores trigger focus; outside clicks also close. A pending selection prevents duplicate submissions.
- Loading, retryable catalog errors, partial provider failures, empty lists, and rejected selections have explicit feedback. Rejected selections retain the original value and remain retryable.
- In Chinese and English, light and dark themes, desktop and 390px viewports, the panel stays within the viewport; long names and many options remain readable or scrollable, and the effort section is visually distinct from the model list.
- Provide the current worktree’s real Web UI and a date-stamped interaction GIF showing the list, model selection, and effort selection when supported. Update and validate relevant component tests, browser regressions, and owner-local snapshots, and complete independent read-only acceptance.

# Constraints and invariants

Reuse ModelDirectory, Host selection APIs, persistence, and locale dictionaries without changing model-call protocols or Session formats. Preserve provider directory ordering and the existing rules governing which later requests use a selection. Preserve unavailable and locked interaction constraints. Keep code and demonstrations in the independent worktree and protect existing changes in the primary directory.

# Decisions

- The user requested Comet and one UI improvement to evaluate; model-picker flattening is the first change.
- The user explicitly selected an independent worktree on `codex/flatten-model-picker`, targeting `master`.
- The panel shows models above the current model’s efforts and uses existing theme tokens. Successful selection closes immediately without an additional confirmation button.
- User-facing requirements, test reports, and acceptance explanations have Chinese versions. Comet formal files retain Runtime’s fixed filenames; screenshots and recordings use date stamps.

# Open questions

None. The user replied “开始吧”, confirming the complete requirements and implementation.

# Verification expectations

Use component tests for selection, focus, and failures, then the supported Web profile built from this worktree for model lists, reasoning efforts, and UI snapshots. Demonstrations use isolated data and the repository’s browser directory-picker overlay. Existing `default-model` and `declared-reasoning` scenarios are regression entry points; choose exact commands from the final diff. An independent read-only Verifier must give evidence for every acceptance item; unexecuted checks cannot pass. Report any environment limitation preventing real model calls.
