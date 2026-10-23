# Outcome

English | [中文](brief.zh.md)

Support Agents referencing images and files while replying in a session, ensuring Markdown links and images emitted by the model are correctly resolved in the frontend client, enabling direct navigation to code files and inline rendering of local and workspace images.

# Scope

1. Frontend image rendering enhancements:
   - Upgrade `localPathMediaUrl` in `packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx` to use the session workspace `cwd` and support resolving workspace-relative image paths.
   - Pass `cwd` to `AssistantMarkdown` from `packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx`.
2. System prompt reference guidance:
   - Update `FILE_REFERENCE_PROMPT` in `packages/client/ui-deliverables/src/index.ts` to add explicit guidance for using Markdown image syntax `![alt](path)` for images.
3. Tests and snapshots:
   - Add tests for `cwd`-relative path resolution in `packages/client/ui-chat/tests/assistant-markdown-path-images.client.spec.tsx`.
   - Update `packages/client/ui-deliverables/tests/prompt.host.spec.ts` and expected snapshots under `snapshots/web/*`.

# Non-goals

1. Implement standalone media player card nodes for audio and video.
2. Change the underlying permission checks of the backend `/api/file` or support non-HTTP transports such as Electron `file://`.

# Acceptance examples

- Scenario: Frontend renders workspace-relative images from cwd
  - **WHEN** Agent outputs an image with a relative path in a reply, such as `![图表](charts/figure.png)` or `./figure.png`, and supplies a valid session `cwd`
  - **THEN** Frontend resolves it to an absolute path pointing to `/api/file?path=...` and renders the image in the UI

- Scenario: Keep safe fallback for non-absolute paths without cwd
  - **WHEN** `cwd` is absent and the image target is a relative path
  - **THEN** Frontend does not construct an `/api/file` request and keeps the safe fallback

- Scenario: System prompt injects complete file and image reference guidance
  - **WHEN** Mount the `ui-deliverables` plugin and assemble the system prompt
  - **THEN** Generated system prompt contains guidance for Markdown file links and image embedding syntax

# Constraints and invariants

1. Keep safely ignoring non-HTTP page transports such as Electron `file://` and protocol-relative links.
2. Strictly follow TypeScript `strict: true` and ESM module conventions.

# Decisions

- Decision 1: Adopt option A (complete loop), combining frontend relative-path resolution with system prompt guidance so model output and frontend rendering stay consistent.

# Open questions

None.

# Verification expectations

1. `pnpm vitest run packages/client/ui-chat/tests/assistant-markdown-path-images.client.spec.tsx` passes.
2. `pnpm vitest run packages/client/ui-deliverables/tests/prompt.host.spec.ts` passes.
3. Relevant packages pass `tsc -b` type checking.
