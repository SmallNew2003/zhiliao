# Goal

English | [中文](brief.zh.md)

Integrate Comet as a reusable, committable collaboration workflow so team members resolve the same project workflow from the project configuration, with a local adaptation layer constraining write operations for supported clients.

# Scope

- Commit the Comet project configuration, the workflow adaptation layer, client hook configuration, and the Native workflow documentation root.
- Commit the project-level overlay for DSH; it mounts `dsh-hooks-codex` and reuses Comet's Codex hook definitions.
- Extend `dsh-hooks-codex`: expose raw tool arguments to the Codex hook through an explicit configuration choice, so Comet can recognize DSH's file-operation targets.
- Verify that the integrated configuration resolves in this repository and does not change DSH bridge behavior when the configuration is not enabled.

# Non-goals

- Do not modify DeepSeek Harness runtime code, package configuration, test behavior, or release flow beyond `dsh-hooks-codex`.
- Do not implement business functionality, and do not commit the current Native change's runtime state as team-shared configuration.
- Do not integrate WorkBuddy into DSH; it uses the same Comet router as an independent client.

# Acceptance examples

- Running `comet workflow resolve . --activate --json` in a clean checkout returns the workflow selection stored in this repository and a valid Comet configuration.
- In-scope client write hooks call the in-repository Comet router and do not reference absolute paths on a developer machine.
- After DSH loads `dsh-hooks-codex` through the project overlay, the bridge provides raw tool arguments to the Comet router; non-write calls continue to execute, the Native Build phase permits implementation writes, the Shape phase rejects implementation writes, and a Verify-phase write invalidates the candidate and returns to Build.
- A DSH bridge without tool-argument passing continues to provide only `tool_input.command` to the Codex hook.
- Git tracks only the project-level Comet configuration, the adaptation layer, the DSH overlay, and formal documentation artifacts, ignoring local runtime state.

# Constraints and invariants

- The root AGENTS.md, existing development commands, and DeepSeek Harness runtime code outside `dsh-hooks-codex` stay unchanged.
- Every new committable path stays valid after another developer clones the repository.
- The DSH adaptation uses only its published `dsh-hooks-codex` plugin and the `PreToolUse` protocol subset of Codex.
- Tool-argument passing must be enabled by explicit configuration in `dsh-hooks-codex`; the default behavior stays compatible.

# Decisions

- The repository is currently clean with no other Native change found; this change proceeds in the current directory of `master` without creating a new worktree.
- Keep both the Native and Classic Comet workflows so the team can choose the matching flow per task.
- Commit the Codex and WorkBuddy adaptation layers; do not commit the GitHub Copilot and Trae adaptation layers.
- DSH reuses the Codex configuration through `dsh-hooks-codex`; WorkBuddy does not enter the DSH runtime.
- The shared Codex configuration matches every tool call, which the Comet router recognizes and constrains for write operations, accommodating the different tool names of DSH and Codex.
- `dsh-hooks-codex` adds a tool-argument passing configuration that is off by default; the Comet overlay enables it explicitly.
- Implementation writes in the Verify phase follow Comet's candidate invalidation and repair behavior rather than a rejection path.

# Open questions

None.

# Verification expectations

- Run Comet's configuration resolution command and check that the committed configuration contains no machine-specific absolute project paths.
- Load the DSH overlay, confirm that `dsh-hooks-codex` can read the shared Codex configuration, and cover allowed and rejected tool calls with replayable checks.
- Cover the default bridge's compatible payload, as well as the DSH file-write guard after the Comet overlay enables argument passing.
