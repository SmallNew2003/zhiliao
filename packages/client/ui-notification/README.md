---
description: "Native OS notifications for session completion, pending approval, and agent-loop failure, with a merge window and click-to-open routing."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-notification

English | [中文](README.zh.md)

## Summary

This package raises native OS notifications when a session needs the user and its conversation is not on screen. Three transitions are announced: a session that stopped while another conversation was in the main view, a domain request awaiting the user, and an agent-loop failure. The transport is selected once per page: the Electron shell on Desktop, the browser Notification API on Web. Announcements arriving together merge into one per kind, and clicking one focuses the window and opens the session it named. Preferences live in the `ui-notification` user-settings section.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in the Web composition; the row takes no config and the `web-app` bundle already carries it. The settings General section gains a **System notifications** row with a master switch and one switch per announcement kind. Turning the master switch off silences every kind while keeping the per-kind choices.

### What to expect

A session that finishes while another conversation occupies the main view raises one notification naming that session; a session the user is already reading raises none. A pending approval or question raises one notification when the request arrives, and not again while it stays pending. An agent-loop failure raises one notification carrying the failure message. Several sessions finishing together raise a single notification stating the count, because triggers that arrive within 800 ms of each other are merged per kind. Clicking a notification restores and focuses the application window and opens the session the announcement named; a merged announcement opens its first session. The row reports the OS authorization state, and the Web build asks the browser for permission on the first announcement.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The node half ([`src/index.ts`](src/index.ts)) registers the `ui-notification` schemastery section, which is the only authority for every default. The browser half ([`src/client/index.ts`](src/client/index.ts)) binds that section, selects the transport, and registers two slot entries.

[`src/planner.ts`](src/planner.ts) is the pure decision surface: it diffs two `SessionStatusSnapshot` values and returns the triggers the transition earned. A completion requires the session to have stopped *and* still be unacknowledged outside the main view, which is exactly `SessionStatus.completionUnread`; a failed turn raises the error trigger instead, so one stop never raises both. [`src/coalescer.ts`](src/coalescer.ts) is the merge window: a debouncing collector that restarts on every trigger and flushes one batch per kind. Both take their timers by injection, so neither needs a client runtime to test.

[`src/client/NotificationBridge.tsx`](src/client/NotificationBridge.tsx) is the seat that feeds the planner. It renders nothing and registers on `shell.overlay`, so one instance survives every conversation switch; it keeps the previous snapshot in a ref and pushes the earned triggers. [`src/client/runtime.ts`](src/client/runtime.ts) owns the merge window, renders the announced copy through the locale service, and routes a click to `ctx.uiWorkspace.openSession` when that optional collaborator is composed. [`src/client/notifier.ts`](src/client/notifier.ts) holds the `Notifier` interface with its two providers; the Electron shell wins whenever it owns the document, because only it can focus the window on a click.

On Desktop, [`apps/desktop/src/notifications.ts`](../../../apps/desktop/src/notifications.ts) validates each IPC payload — IPC is a process boundary — presents it through Electron's `Notification`, and forwards the click as a `notify-clicked` message after focusing the window. Every handler accepts only the main window's top frame.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-client-ui-session](../ui-session/README.md) — the `SessionStatus` signals this package consumes.
- [dsh-settings](../../settings/settings/README.md) — the namespace-registration and resolution contract behind the durable preferences.
- [dsh-client-ui-theme](../ui-theme/README.md) — the sibling feature that owns its own settings row the same way.

-----

<a id="model-experience"></a>
## Model Experience

None, as the announcement copy is selected from this package's own locale dictionaries and no announcement text ever enters a session log or a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **macOS reports no authorization state before the first presentation.** Electron exposes no permission query, so the shell reports `default` until the OS has answered, and the row shows "the system asks for permission on the first notification" rather than a granted or denied state.
- **A merged announcement opens only its first session.** The click target is the batch's first session id; the remaining sessions stay in the sidebar marked as unread completions.
- **The Web build depends on a live page.** Browser notifications are raised by the document, so a closed tab raises nothing, while Desktop keeps announcing because the window process owns the transport.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The trigger signals already existed: `SessionStatus.completionUnread` encodes "stopped outside the main view, still unacknowledged", and `ui-workspace` renders it as the completion dot. The one addition to a shared surface is `SessionStatus.lastAgentError`, fed by the existing `api-session/error` remote event that `agent/error` already emits at the agent loop's failure boundary.

</details>

**Runtime invariant:** No companion is published. The planner and the coalescer are pure functions with no second copy to diverge, and the only stateful objects are the settings mirror and the merge window, both owned by one plugin fiber whose disposal the HMR-safety spec proves.
