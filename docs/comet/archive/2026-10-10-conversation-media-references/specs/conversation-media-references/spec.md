# Conversation media and file references

English | [中文](spec.zh.md)

## Workspace-relative image resolution

The frontend `AssistantMarkdown` must support combining the session workspace `cwd` with relative image paths to generate a same-origin `/api/file` URL.

### Scenario: Resolve and render relative-path images

- **WHEN** Agent outputs `![图表](charts/figure.png)` and supplies a valid `cwd`
- **THEN** Frontend constructs a request URL pointing to `/api/file?path=...` and renders the image in the UI

## System prompt guidance

The system prompt must contain explicit file reference and image embedding guidance.

### Scenario: Prompt contains image embedding guidance

- **WHEN** Mount the `ui-deliverables` plugin and assemble the prompt
- **THEN** The prompt text explicitly instructs using `![alt](path)` to embed images
