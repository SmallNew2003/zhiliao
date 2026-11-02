# Goal

English | [中文](brief.zh.md)

Integrate Comet as a reusable, committable collaboration workflow for this repository, so team members resolve the same workflow from the project configuration and a local adaptation layer constrains write operations within the supported clients.

# Scope

- Commit the Comet project configuration, the workflow adaptation layer, the client hook configuration, and the Native workflow documentation root.
- Commit the project-level overlay for DSH; it mounts `dsh-hooks-codex` and reuses Comet's Codex hook definitions.
- Extend `dsh-hooks-codex`: expose the raw tool arguments to the Codex hook through an explicit configuration choice, so Comet can identify DSH's file-operation targets.
- Verify that the integrated configuration resolves in this repository and does not change DSH bridge behavior for checkouts that do not enable it.

# Non-goals

- Do not modify DeepSeek Harness runtime code, default profiles, or the release process beyond `dsh-hooks-codex`.
- Do not implement business features, and do not commit the current Native change's runtime state as team-shared configuration.
- Do not integrate WorkBuddy into DSH; it stays a separate client that uses the same Comet router.

# Acceptance examples

- Running `comet workflow resolve . --activate --json` in a clean checkout returns the workflow selection saved for this repository together with a valid Comet configuration.
- The client write hooks brought into scope call the in-repository Comet router and reference no absolute path on a developer's machine.
- After DSH loads `dsh-hooks-codex` through the project overlay, the bridge passes the raw tool arguments to the Comet router; non-write calls continue to execute, the Native Build phase allows implementation writes, the Shape phase rejects implementation writes, and a Verify-phase write invalidates the candidate and returns to Build.
- A DSH bridge without tool-argument passing keeps providing only `tool_input.command` to the Codex hook.
- Git tracks only the project-level Comet configuration, the adaptation layer, the DSH overlay, and the formal documentation artifacts, and ignores machine-local runtime state.

# Constraints and invariants

- The root AGENTS.md, the existing development commands, and the DeepSeek Harness runtime code outside `dsh-hooks-codex` stay unchanged.
- Every newly added committable path stays valid after another developer clones the repository.
- The DSH adaptation uses only its published `dsh-hooks-codex` plugin and the `PreToolUse` protocol subset of Codex.
- Tool-argument passing must be enabled by explicit `dsh-hooks-codex` configuration; the default behavior stays compatible.

# Decisions

- The repository is clean and no other Native change was found; this change proceeds in the current directory of `master` and creates no worktree.
- Keep both the Native and Classic Comet workflows so the team can pick the matching process per task.
- Commit the Codex and WorkBuddy adaptation layers; do not commit the GitHub Copilot and Trae adaptation layers.
- DSH reuses the Codex configuration through `dsh-hooks-codex`; WorkBuddy does not enter the DSH runtime.
- The shared Codex configuration matches every tool call; the Comet router recognizes it and constrains write operations, which keeps DSH and Codex compatible despite their different tool names.
- `dsh-hooks-codex` gains a tool-argument passing configuration that is off by default; the Comet overlay enables it explicitly.
- Verify-phase implementation writes follow Comet's candidate invalidation and repair behavior instead of a rejection path.

# Open questions

None.

# Verification expectations

- Run Comet's configuration resolution command and confirm the committed configuration carries no machine-specific absolute project path.
- Load the DSH overlay, confirm `dsh-hooks-codex` reads the shared Codex configuration, and cover the allowed and rejected tool calls with replayable checks.
- Cover the default bridge's compatibility payload, and DSH's file-write guard after the Comet overlay enables argument passing.
