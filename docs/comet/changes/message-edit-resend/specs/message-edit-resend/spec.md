# Latest user message editing and resending

English | [中文](spec.zh.md)

Users can edit the latest sent user message's text in the current chat and request a new model response. Historical adjustments use a branch into a new chat. Editing is disabled during active runs, and original attachments remain unchanged.

## Editing eligibility

Only the latest sent user message in the current chat is editable. Assistant responses, tool results, and earlier user messages have no direct edit action. The latest user message inherited into a branch is also editable; its parent chat remains intact. Queued input retains its existing queue-editing operation and is not treated as a sent chat message.

### Scenario: Only the latest user message is editable

The chat contains input A, response A, input B, and response B. Users can edit B; A has no direct edit action. Response B does not change B's status as the latest user message.

### Scenario: The first user message is editable

The chat contains only sent user message A and its response. Users can edit A. Resending excludes original A and its response and does not reject the edit merely because there is no earlier user input.

## Editing and resending

The edit action opens an editor prefilled with the original text; users can cancel or submit modified input. The current chat displays the modified input and new response. The model receives the effective history preceding that input and the modified input. Committed events are not overwritten or deleted in place. Reloading and persistence recovery reconstruct the same effective conversation.

### Scenario: Cancelling an edit

Users modify the latest message and cancel. The chat restores the original input and response without a new model request or tool execution.

### Scenario: Resending excludes original input and response

The chat contains A and its response, then B and its response. Users modify B to B2 and submit. The current chat displays A and its response, followed by B2 and a new response. Model history contains A and its response and B2, excluding original B and response B.

### Scenario: Persistence recovery after resending

After the modified latest message and new response are saved, users reload the chat or restart the server. Display and effective model history retain modified input and the new response. The log retains replayable original events and the edit record.

### Scenario: A draft target is no longer latest

A client starts editing B, but the chat accepts newer user message C before submission. The server rejects editing B. The client preserves the draft and explains that its target is no longer latest. The edit makes no model request and does not affect C.

### Scenario: Another client edits the same message first

Two clients edit latest message B. One successfully submits B2 first. The other submission based on original B is rejected. Its draft remains recoverable, does not overwrite B2, and makes no extra model request.

## Run state

Editing is disabled during model responses, tool execution, and stop cleanup. After manual stop, editing resumes only once the server confirms the run ended. If a run starts while the editor is open, the UI disables submission. The server independently checks run state and rejects stale submissions while preserving the draft. It does not automatically stop the run.

### Scenario: Editing is disabled during an active run

The latest message is awaiting a model response or running a tool. The edit action is unavailable and gives a localized reason. Users cannot interrupt the run through this action.

### Scenario: Editing after manual stop

Users manually stop a run. Editing remains unavailable until stopping and tool cleanup finish. After the server confirms the run ended, the latest user message becomes eligible again.

### Scenario: A run starts while editing

The editor is open when the chat starts running. The client disables submission and preserves the draft. A direct server edit request is also rejected; the existing run is not automatically stopped.

## Attachments and input validation

The editor displays original attachments and permits text changes only. Users cannot add, delete, or replace attachments through editing. Resending references original attachments without another upload. File references and other non-text content retain their original order. Display text is not reparsed into new attachments or uploads.

### Scenario: Text changes preserve attachments

The latest user message contains text and multiple attachments. After text changes are submitted, the modified message and model request retain original attachment identities, order, and content. The UI offers no attachment addition or removal and performs no repeated upload.

### Scenario: Attachment-only input remains valid

Users clear the text while valid original attachments remain. Resending preserves them and accepts the input under existing attachment-input rules. Blank input with neither text nor attachments is rejected, preserving the draft and original conversation.

### Scenario: An original attachment cannot be read

An original attachment required for resending is unavailable. The system explains the failure, does not silently drop attachments or request the model with partial input, and preserves a recoverable text draft.

### Scenario: Submitted content is unchanged

Users open the editor without changing text, or restore the original text. The UI makes no resend request and does not call the model or tools again.

## Failures and retries

Before acceptance, validation or network failure does not replace the original effective conversation; the editor preserves the draft and an understandable error. Retries use a stable request identifier. If the server already accepted the operation, even when it changed the target, the server returns the original acceptance without another input. If the model fails after acceptance, the chat retains modified input and uses existing failure presentation and recovery actions without silently restoring original input.

### Scenario: Failure before acceptance

Users submit valid text, but the operation fails before acceptance. Original input and response remain intact. The UI preserves the draft and allows retry. The failed operation made no model request.

### Scenario: Retrying after losing an acceptance response

The server accepted resending, but the client did not receive its response. Retrying with the same request identifier returns the same acceptance. The edit input is recorded once and only one new response is started.

### Scenario: Model failure after acceptance

The edit request was accepted and the model subsequently fails. The chat still displays modified input and a failure state, and users can use existing recovery actions. Original input and response are not restored as current effective history.

## Historical message adjustment

Users enter a new chat through the existing completed-turn branch action. The branch retains that turn and earlier history, making the turn's last user message the latest user message in the child. Users edit and resend there while the parent and its subsequent conversation remain intact.

### Scenario: The latest inherited message is editable

The parent chat contains A and its response, then B and its response. Users branch from the end of response A into a new chat containing A and its response. A is editable. Resending modified A2 gives the child A2 and a new response; the parent's A, B, and original responses remain intact.

## External operations

Editing conversation history does not undo completed file changes, commands, or external operations. The model may call tools again when answering modified input.

### Scenario: External side effects are not rolled back

The original response modified a file. Users edit and resend the latest message or adjust a message in a branch. Editing and branching do not undo that file change.

## Presentation and accessibility

The edit action, input, cancellation, resending, disabled reasons, and errors support the current Chinese and English UI and have localized accessible names. Editing supports keyboard use. Cancellation or submission returns focus to an appropriate chat position.

### Scenario: Chinese and English keyboard operation

Users use the keyboard to open the editor, change text, and cancel or resend in Chinese or English. Controls have names in the selected language. Disabled and error reasons are perceivable, and closing the editor does not lose focus.
