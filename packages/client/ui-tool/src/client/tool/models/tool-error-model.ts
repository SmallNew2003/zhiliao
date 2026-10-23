/**
 * Structured error classification and user-friendly formatting for failed Tool calls.
 *
 * Normalizes cryptic or raw command exceptions (such as command strings
 * passed as unknown tool names, non-zero exit codes, or unformatted runtime
 * errors) into user-facing summaries and localized explanations.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** Error kind categorized for display and localization. */
export type ToolErrorKind =
  | 'unknown_tool'
  | 'command_failed'
  | 'command_not_found'
  | 'timeout'
  | 'file_not_found'
  | 'permission_denied'
  | 'custom'

/** Structured tool failure details used for user-facing formatting. */
export interface ToolErrorModel {
  readonly kind: ToolErrorKind
  readonly name?: string
  readonly code?: number | string
  readonly summary: string
}

/**
 * Clean and truncate raw error messages for inline presentation.
 * @param text - first line or raw message.
 * @param maxLength - max characters before truncation (default 80).
 * @returns sanitized display string.
 */
export function sanitizeErrorMessage(text: string, maxLength = 80): string {
  let cleaned = text.trim()
  if (cleaned.startsWith('Error: ')) cleaned = cleaned.slice(7).trim()
  else if (cleaned.startsWith('[Error] ')) cleaned = cleaned.slice(8).trim()
  cleaned = cleaned.replace(/[\r\n\t]+/g, ' ')
  if (cleaned.length > maxLength) {
    return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`
  }
  return cleaned
}

/**
 * Parse a raw tool error output into a structured model.
 * @param output - raw output/error string from tool result.
 * @param toolName - the tool name reported on the wire call.
 * @returns structured error model, or null if output is empty.
 */
export function parseToolError(output: string | null | undefined, toolName?: string): ToolErrorModel | null {
  void toolName
  if (output === null || output === undefined || output.trim() === '') return null
  const first = output.split('\n')[0]?.trim() ?? ''
  if (first === '') return null

  // 0. Exact name/code fallback like "ToolError: timeout" preserved verbatim
  if (/^[A-Za-z0-9_]+Error:\s*[a-zA-Z0-9_-]+$/.test(first)) {
    return { kind: 'custom', summary: first }
  }

  // 1. Unknown tool check: `unknown tool "name"` or `Error: unknown tool "name"`
  const unknownMatch = first.match(/(?:Error:\s*)?unknown tool\s*"([^"]+)"/i)
  if (unknownMatch) {
    const rawTarget = unknownMatch[1] ?? ''
    // If the model passed a command like `grep -rn "foo" /path`, pick the executable name
    const candidate = rawTarget.trim().split(/\s+/)[0] || rawTarget
    return {
      kind: 'unknown_tool',
      name: candidate,
      summary: sanitizeErrorMessage(first),
    }
  }

  // 2. Command exit code: `exit code 127`, `Exit 1: ...`, `command failed with exit code 1`
  const exitMatch = first.match(/(?:command failed with exit code|exit code|exit)\s+(\d+)/i)
  if (exitMatch) {
    const code = Number(exitMatch[1])
    if (code === 127) {
      return { kind: 'command_not_found', code, summary: sanitizeErrorMessage(first) }
    }
    return { kind: 'command_failed', code, summary: sanitizeErrorMessage(first) }
  }

  // 3. Command not found
  if (/command not found/i.test(first)) {
    return { kind: 'command_not_found', summary: sanitizeErrorMessage(first) }
  }

  // 4. Timeout
  if (/\b(?:timed?\s*out|timeout|ETIMEDOUT)\b/i.test(first)) {
    return { kind: 'timeout', summary: sanitizeErrorMessage(first) }
  }

  // 5. File not found
  if (/\b(?:no such file or directory|ENOENT)\b/i.test(first)) {
    return { kind: 'file_not_found', summary: sanitizeErrorMessage(first) }
  }

  // 6. Permission denied
  if (/\b(?:permission denied|EACCES)\b/i.test(first)) {
    return { kind: 'permission_denied', summary: sanitizeErrorMessage(first) }
  }

  return {
    kind: 'custom',
    summary: sanitizeErrorMessage(first),
  }
}

/**
 * Localize a structured tool error into an immediate user-readable summary.
 * @param error - parsed tool error model.
 * @param t - conversation namespace translator.
 * @returns concise user-facing error text.
 */
export function localizeToolError(
  error: ToolErrorModel,
  t: TranslateNS<'conversation'>,
): string {
  switch (error.kind) {
    case 'unknown_tool':
      return t('tool.error.unknownTool', { name: error.name ?? '' })
    case 'command_failed':
      return t('tool.error.commandFailed', { code: error.code ?? 1 })
    case 'command_not_found':
      return t('tool.error.commandNotFound')
    case 'timeout':
      return t('tool.error.timeout')
    case 'file_not_found':
      return t('tool.error.fileNotFound')
    case 'permission_denied':
      return t('tool.error.permissionDenied')
    case 'custom':
      return error.summary
  }
}
