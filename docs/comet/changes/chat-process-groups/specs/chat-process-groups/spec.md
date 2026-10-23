# Conversation process groups

English | [中文](spec.zh.md)

## Response segmentation

The conversation must retain visible Assistant text and aggregate consecutive process content between adjacent response segments into separate process groups. Grouping changes presentation only and does not change the persisted Session order or model-visible content.

### Scenario: Assistant responses delimit process groups

- **WHEN** A turn contains “process content, visible Assistant response, process content, visible Assistant response, final answer”
- **THEN** Both visible responses remain outside process groups and retain their original order
- **AND** Each consecutive run of process content forms a separate process group
- **AND** Standalone process content before the first response may also form a process group

### Scenario: Split one Assistant Node by content

- **WHEN** One Assistant Node contains both a non-empty reasoning block and a visible response block
- **THEN** The reasoning block enters the process group that contains it
- **AND** The visible response block remains outside process groups
- **AND** The same content block does not render twice

### Scenario: Standalone rows stay outside process groups

- **WHEN** A turn contains a user message, steering, system prompt, error, max-token notice, or turn-tail
- **THEN** The row remains standalone and renders in its original order
- **AND** It becomes a boundary between adjacent process groups

## Running and completed states

A process group must distinguish running from completed state based on whether more response content or the end of the turn follows it.

### Scenario: Running groups start expanded

- **WHEN** A process group is still running
- **THEN** The group starts expanded
- **AND** The title shows current activity and elapsed time for the turn
- **AND** In-progress reasoning or tool rows show running state

### Scenario: Completed groups show a summary and collapse by default

- **WHEN** A subsequent visible Assistant response appears or the end of the turn closes the process group
- **THEN** The group starts collapsed
- **AND** A reasoning-only group shows “Analyze request”
- **AND** A group containing tool calls generates a short summary from its actual actions
- **AND** A failed call appends “Some actions failed”

### Scenario: Completed summaries describe only action types

- **WHEN** A completed process group contains one or more tool actions
- **THEN** The group title describes at most two main action types, such as “Read files, ran commands”
- **AND** The title does not show any call counts
- **AND** Actions are classified from deduplicated tool calls within the group
- **AND** More than two action types append “and more” after the description

### Scenario: Expanded groups limit height and scroll internally

- **WHEN** Users expand a process group
- **THEN** The group content area has a maximum height of `min(400px, 50vh)`
- **AND** Content that exceeds the height scrolls inside the process group
- **AND** The corresponding edge fades when more content can be scrolled into view

### Scenario: Group content stays compact and expands independently

- **WHEN** An expanded process group contains multiple reasoning or tool rows
- **THEN** Each row retains its existing compact summary form
- **AND** Completed, failed, and running states are distinguishable
- **AND** Reasoning and tool rows can each expand their details

## Interaction and presentation modes

### Scenario: Group titles support keyboard and pointer operation

- **WHEN** Users click a process group title or focus it and press Enter or Space
- **THEN** The process group toggles its expanded state
- **AND** The title exposes `aria-expanded`
- **AND** Focus remains on the title after toggling

### Scenario: In-page find reveals hidden process content

- **WHEN** Browser in-page find matches text inside a collapsed process group
- **THEN** The corresponding process group expands automatically and shows the match

### Scenario: Compact uses process groups

- **WHEN** Conversation display is set to `Compact`
- **THEN** Eligible consecutive process content uses process groups
- **AND** Running groups expand while completed groups collapse

### Scenario: Normal stays flat

- **WHEN** Conversation display is set to `Normal`
- **THEN** Process rows render in their existing flat presentation
- **AND** No process group titles or group-level height limits appear

### Scenario: Streaming appends and history pagination preserve order

- **WHEN** Process group content streams in, a turn completes, or history pagination changes the loaded window
- **THEN** Existing members retain stable keys and relative order
- **AND** A user's manual expansion state is retained only while the corresponding group still exists
- **AND** Re-rendering does not change state already chosen by tool or reasoning nodes

## Localization and accessibility

### Scenario: Process group copy comes from locale dictionaries

- **WHEN** A process group shows running state, a completed summary, or failure state
- **THEN** Copy comes from the `ui-chat` locale dictionaries
- **AND** Chinese and English cover every new key

### Scenario: Running state does not rely on color alone

- **WHEN** A process group or a row inside it is running
- **THEN** Text or status semantics are provided as well
- **AND** Animation stops under `prefers-reduced-motion`
