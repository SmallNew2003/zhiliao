# Comet workflow integration

English | [中文](spec.zh.md)

## Dual workflow configuration

The repository must list both Native and Classic as available Comet workflows, and the project-local default workflow selection must be resolvable by the Comet CLI.

### Scenario: Resolving the committed project workflow

- **WHEN** a developer runs the Comet workflow resolution command in the repository root
- **THEN** the command returns the valid configuration saved with the project
- **AND** the returned available workflows include Native and Classic

## Client write adaptation

The repository must provide Comet write hooks for Codex and WorkBuddy. Each hook must execute the in-repository Comet router and must not depend on absolute paths on a developer machine. The GitHub Copilot and Trae adaptation layers are not part of this project's committed configuration.

### Scenario: A client calls the portable router

- **WHEN** Codex or WorkBuddy calls the committed write hook inside a repository checkout
- **THEN** the hook calls the in-repository resolvable Comet router
- **AND** the call carries no developer-specific absolute project path

## DSH hook adaptation

The repository must provide an explicitly enabled DSH overlay. That overlay mounts `dsh-hooks-codex` and references the shared Codex hook configuration, so DSH calls the Comet router at `PreToolUse`. The overlay must explicitly enable the bridge's raw tool-argument passing so the router can recognize DSH file-operation targets. The shared configuration must match every DSH tool call; the router passes non-write calls through on its own, permits implementation writes in the Native Build phase, rejects implementation writes in the Shape phase, and invalidates a write candidate in the Verify phase and returns to Build.

### Scenario: DSH reuses Comet's write constraints

- **WHEN** DSH runs a tool call with the project's Comet overlay
- **THEN** `dsh-hooks-codex` calls the Comet router at `PreToolUse`
- **AND** the bridge passes tool arguments to the router to recognize file-operation targets
- **AND** non-write calls continue to execute
- **AND** implementation writes in the Native Build phase continue to execute
- **AND** implementation writes in the Native Shape phase are rejected
- **AND** implementation writes in the Native Verify phase invalidate the candidate and return to Build

## DSH bridge argument compatibility

`dsh-hooks-codex` must define full tool-argument passing as a configuration option that is off by default. When it is off, the bridge must continue to provide a Codex `tool_input` carrying only `command`; when it is on, the bridge must retain the raw tool arguments and keep `command` a string.

### Scenario: The existing payload is retained when argument passing is off

- **WHEN** `dsh-hooks-codex` does not enable tool-argument passing
- **THEN** every Codex tool payload's `tool_input` carries only the string `command`

### Scenario: The Comet overlay enables argument passing

- **WHEN** DSH calls a tool carrying a file path with the Comet overlay
- **THEN** the Codex hook payload retains that file path
- **AND** `tool_input.command` stays a string

## Committable state

The repository must track the project-level Comet configuration, the selected client adaptation layers, the DSH overlay, and formal change artifacts, and must ignore Comet's machine-local runtime state.

### Scenario: A clean checkout holds no local state

- **WHEN** a developer checks out the repository on another machine
- **THEN** every tracked Comet configuration and adaptation file is available
- **AND** machine-local runtime state is not tracked by Git
