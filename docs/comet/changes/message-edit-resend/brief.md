# Outcome

English | [中文](brief.zh.md)

Users can edit the latest sent user message in the current chat and request a new model response. To adjust a historical message, users first branch from its completed turn into a new chat, then edit the latest user message there.

# Scope

Provide editing, text input, cancellation, and resending only for the latest sent user message. Historical messages use the existing branch-to-new-chat flow. Editing is disabled while a run is active and becomes available after completion or manual stop; original attachments remain unchanged. Include the required session APIs, history projections, persistence replay, and Chinese and English UI text.

# Non-goals

Do not directly edit historical user messages in their original chat, edit assistant responses or tool results, add message-version navigation, automatically stop a run, add or remove original attachments, or undo file changes, commands, or external operations from the original conversation. The model may execute tools again when answering the modified input.

# Acceptance examples

Cancelling an edit preserves the original message, response, and session history. Cancellation makes no model request and executes no tools.

Resending the latest message uses the conversation preceding that message and the modified input. The original input and its subsequent response are excluded from the model history. The current chat shows the modified input and new response while the committed original log remains replayable.

After branching from the completed turn containing a historical message, that user message is the latest user message in the new chat and can be edited. Resending affects only the new chat; the original chat and subsequent responses remain intact.

Invalid input or submission failure produces an understandable error and preserves the draft. Retrying must not submit the same operation twice. Original attachments remain viewable and are not uploaded again. Complete acceptance scenarios are defined in this change's specs/message-edit-resend/spec.md.

# Constraints and invariants

The session log remains replayable; committed events must not be overwritten or deleted in place. Every model-visible input has a corresponding log record. Editing and resending do not undo external side effects of the original conversation.

The existing chat branch action is on the final message of a completed turn; the remote fork API resolves its anchor to that turn's turn/end. Historical adjustment uses that branch result so the target user message becomes the latest in the child chat. The edit operation separately excludes the original input and subsequent history.

A latest user message remains editable when inherited from a branch. The server rechecks that the target is still the latest user message at submission, so another client's input cannot leave the draft targeting a historical message.

Cover the first message, subsequent messages, and log replay. Product text belongs to typed locale dictionaries; tests and recording follow the repository's session snapshot, GUI, and real-model verification requirements.

# Decisions

Reuse the existing isolated worktree and Native change message-edit-resend. Do not change product implementation before requirements confirmation.

The chat entry point, session history, and resending operation form one acceptance goal and remain a single change.

Q1 confirmed: only the latest user message is editable.

Q2 historical adjustment confirmed: users branch into a new chat to adjust historical messages. The latest message is edited and resent in the current chat, without message-version navigation.

Q3 confirmed: disable editing while a run is active; enable it after completion or after manual stop and cleanup finish.

Q4 confirmed: edit text only and preserve original attachments.

# Open questions

None.

# Verification expectations

Build runs focused tests, type checks, documentation checks, and user-visible session snapshots appropriate to the actual changes. Session lifecycle and event changes also cover TypeScript and Python SDK projections. GUI acceptance uses the real server and model flow to verify latest-message editing, active-run disablement, cancellation, attachment preservation, and historical branching. Verify uses an independent read-only Verifier to assess every complete Spec scenario.
