---
description: "Browser Chat target that renders Session conversation nodes, historical images, actions, localization, and scroll state."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

## Summary

Use this package to render a browser chat from recorded Session conversations, including historical images, localized actions, and restored scroll position. Compact display groups consecutive process rows between visible Assistant responses, keeps running work open, and folds completed groups into summaries; packed historical Assistant runs remain collapsed. Local transcript and steering submissions appear immediately, disappear atomically when authoritative Session records arrive, and queued submissions stay outside Chat. The package does not assemble or modify model requests.

File-mention providers receive the viewed Session ID with the closing-turn owner, so links into inherited history can address the fork itself.

## Table of Contents

- [Reference previews](#reference-previews)
- [System prompt row](#system-prompt-row)
- [Turn token usage](#turn-token-usage)
- [Completed-turn footer](#completed-turn-footer)
- [Process groups](#turn-process-folding)
- [Scroll ownership](#scroll-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="reference-previews"></a>
## Reference previews

Chat supplies file and HTTP(S) navigation through one `MarkdownDelegateProvider` around its node list. Assistant Markdown file links open in the right Sidebar after the message settles, including references to unmodified files. Relative paths resolve in the viewed Session's workspace; absolute paths retain the same Session's filesystem access. `#L24` and `#L24-L30` navigate to the first specified line and reuse an existing file tab. Missing files show the preview's error state.

HTTP(S) links in Assistant Markdown open a new right-Sidebar Browser tab on ordinary clicks when that type is registered, or the system browser otherwise; modified clicks retain the native external-link behavior. Sent file references and skills confirmed by the message’s logged invocation also open in the right Sidebar. File paths use the viewed Session; skill names resolve through its current input-trigger source. Both use the prose file-link dotted underline on hover or focus. Sessions, directories, and command labels remain non-navigating references.

<a id="system-prompt-row"></a>
## System prompt row

Each nonempty appended `system/message` owns a collapsed prompt row, including a complete prompt at the start of a headerless window; the same-step header does not duplicate it. Chat also shows a collapsed `System prompt` row for a non-empty initial request, explicit message-series start, or `system/message` surface node replacement whose text differs, reading the last nonempty surviving system node in surface order at the `request/header`; a non-initial request whose preceding header is outside the loaded history window also shows one. A resume repeats the row even when its system text is unchanged, including after pagination supplies the preceding header and system node; same-series config-only or tool-only changes, tool steps, and retries create no repetition, and a `system/message` event is never rendered as a transcript message. The row appears before that request's user messages, matching the provider envelope, and expands to the exact model-visible text with its original line breaks. A request whose system node is empty or outside the loaded window creates no row until the page holding the node arrives.

<a id="turn-token-usage"></a>
## Turn token usage

A completed Turn shows an expandable usage row only when the loaded window includes `turn/start` and every started model attempt reports safe, exact usage. The row omits unavailable optional buckets. Incomplete or contradictory accounting hides the complete disclosure instead of presenting a partial total.

After Assistant replies settle, the completed-turn timing dialog omits TTFT and decoding speed, both after live replies and after reopening history. Elapsed turn time remains available. The Session Stats pill reads timing independently from its durable projection.

<a id="completed-turn-footer"></a>
## Completed-turn footer

The completed-turn action footer starts 20px below the preceding prose or extension content.

-----

<a id="turn-process-folding"></a>
## Process groups

Settings → General exposes a persisted, localized `Normal` / `Compact` conversation-display preference in the `ui-chat` namespace; `Compact` is the default. Compact groups each consecutive run of Context injection, reasoning, Tool rows, and Retry rows between visible Assistant responses. A visible Assistant response or `turn/end` closes the current group. System prompt, User, steering, error, max-token, and turn-tail rows remain independent. Normal leaves process rows flat and renders no group headers.

A running group starts expanded and its header names the current activity and elapsed Turn time. A completed group starts collapsed; its header summarizes up to two main action types without displaying counts, such as `Read files, ran commands`, and a reasoning-only group reads `Analyze request`. Failures append `Some actions failed`. Expanding a group caps its body at `min(400px, 50vh)`, scrolls it independently, and fades the edge in the remaining scroll direction. Child reasoning and Tool rows keep their own disclosures. Closed bodies use `hidden="until-found"`, so browser find opens the group that contains the match. The session-scoped store records explicit group expansion choices; a manual choice survives streaming, history paging, and Chat view remounts. Group keys and member seats survive running-to-settled and running-to-closed transitions without remounting Tool renderers. Switching between Compact and Normal changes presentation only; it does not add a Session event or model input.

-----

<a id="scroll-ownership"></a>
## Scroll ownership

Chat restores semantic anchors across history prepend and renderer remounts. Pinned scroll deliveries without reader movement update follow ownership immediately, before subsequent layout changes can invalidate their floor. Reader movement remains pending until the sampling interval or `scrollend`, even inside the follow threshold, so layout growth cannot erase small scroll gestures. While the reader is pinned to the floor, `ResizeObserver` follows the new floor and selects the latest loaded Turn without reading row geometry. Once the reader moves away, flow-height changes preserve the top position and the reading-line geometry selects the active Turn. Turn-rail previews paint above sticky Markdown code-block banners, while the rail frame remains inside the transcript band above the composer.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The transcript reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page. Turn navigation is wider than the window: the rail merges the loaded Turns with the host `turnOutline` projection, so every started Turn gets a fixed-pitch mark (10px apart; a ladder taller than the frame scrolls inside it with gradient fades), and activating an unloaded mark pages history through the Turn's `turn/start` seq before landing on its row. Without the projection (assemblies not mounting `dsh-session-turn-outline`) the rail falls back to loaded Turns only.
- **Rail previews are card-sized** — one prompt line (50 characters) and up to three response lines (120), on loaded and unloaded Turns alike; an unloaded Turn's response arrives from the outline only once the Turn settled, so an open Turn previews its prompt (or just the Turn number) until then.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Conversation and Slot registration enforce Chat target consistency.
