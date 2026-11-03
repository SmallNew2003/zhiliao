# Comet workflow integration

English | [中文](spec.zh.md)

## Dual workflow configuration

The repository must list Native and Classic as available Comet workflows at the same time, and the project-local default workflow choice must be resolvable by the Comet CLI.

### Scenario: resolving the committed project workflow

- **WHEN** a developer runs the Comet workflow resolution command in the repository root
- **THEN** the command returns the valid configuration saved for the project
- **AND** the returned available workflows include Native and Classic

## Client write adaptation

The repository must provide Comet write hooks for Codex and WorkBuddy. Each hook must run the in-repository Comet router and must not depend on an absolute path on the developer's machine. The GitHub Copilot and Trae adaptation layers are not part of this project's committed configuration.

### Scenario: a client calls the portable router

- **WHEN** Codex or WorkBuddy calls the committed write hook in a repository checkout
- **THEN** the hook invokes the Comet router resolvable inside the repository
- **AND** the call carries no absolute project path specific to a developer

## DSH hook adaptation

The repository must provide an explicitly enabled DSH overlay. The overlay mounts `dsh-hooks-codex` and references the shared Codex hook configuration, so DSH calls the Comet router on `PreToolUse`. The overlay must explicitly enable the bridge's raw tool-argument passing so the router can identify DSH file-operation targets. The shared configuration must match every DSH tool call; the router passes non-write calls through on its own, allows implementation writes during the Native Build phase, rejects implementation writes during the Shape phase, and invalidates write candidates during the Verify phase and returns to Build.

### Scenario: DSH reuses the Comet write constraints

- **WHEN** DSH runs a tool call with the project's Comet overlay
- **THEN** `dsh-hooks-codex` calls the Comet router on `PreToolUse`
- **AND** the bridge passes tool arguments to the router to identify file-operation targets
- **AND** non-write calls continue to execute
- **AND** implementation writes during the Native Build phase continue to execute
- **AND** implementation writes during the Native Shape phase are rejected
- **AND** implementation writes during the Native Verify phase invalidate the candidate and return to Build

## DSH bridge argument compatibility

`dsh-hooks-codex` must define full tool-argument passing as a configuration option that is off by default. When it is not enabled, the bridge must continue to provide a Codex `tool_input` that contains only `command`; when it is enabled, the bridge must preserve the raw tool arguments and keep `command` a string.

### Scenario: the existing payload is preserved when argument passing is off

- **WHEN** `dsh-hooks-codex` does not have tool-argument passing enabled
- **THEN** each Codex tool payload's `tool_input` contains only the string `command`

### Scenario: the Comet overlay enables argument passing

- **WHEN** DSH calls a tool with a file path under the Comet overlay
- **THEN** the Codex hook payload preserves that file path
- **AND** `tool_input.command` remains a string

## Committable state

The repository must track the project-level Comet configuration, the selected client adaptation layer, the DSH overlay, and the formal change artifacts, and must ignore Comet's machine-local runtime state.

### Scenario: a clean checkout carries no local state

- **WHEN** a developer checks out the repository on another machine
- **THEN** all tracked Comet configuration and adaptation files are available
- **AND** the local runtime state is not tracked in Git
