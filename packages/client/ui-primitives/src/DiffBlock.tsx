import { useCallback, useMemo, useState } from 'react'
import clsx from 'clsx'
import { diffWordsWithSpace, structuredPatch } from 'diff'
import { FoldToggle } from './FoldToggle.tsx'
import { writeClipboard } from './clipboard.ts'
import { IconCheckOutline16, IconCopyOutline16 } from './icons/index.tsx'
import css from './DiffBlock.module.css'

/** Output lines shown before the height cap collapses the middle. */
export const DEFAULT_DIFF_MAX_LINES = 16

/**
 * One file change in the form {@link DiffBlock} renders. It is declared here
 * so this primitive stays independent of the tool contract.
 */
export interface DiffHunk {
  /** The changed file's path, drawn verbatim as the hunk's header (the tool's model-facing path). */
  path: string
  /** Prior content including context, or `null` when no prior content is available. */
  oldText: string | null
  /** Content after the change, including any shared context. */
  newText: string
}

export interface DiffBlockProps {
  /** One entry per applied hunk, in file order; empty renders nothing. */
  diffs: DiffHunk[]
  /** Localized chrome supplied by the owning render site. */
  labels: DiffBlockLabels
  /** Height cap in body lines before the middle collapses (default {@link DEFAULT_DIFF_MAX_LINES}). */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/** Localized chrome for {@link DiffBlock}. */
export interface DiffBlockLabels {
  copy: string
  copied: string
  collapseAria: string
  expandAria: (hidden: number) => string
  collapse: string
  expand: (hidden: number) => string
  files: (count: number) => string
  copyPath?: string | undefined
  pathCopied?: string | undefined
}

/** A word- or character-level span inside a diff line. */
export interface DiffSpan {
  text: string
  highlight?: boolean | undefined
}

/** A single rendered body line and its role, so the height cap slices a flat list. */
interface DiffRow {
  kind: 'path' | 'del' | 'add' | 'context' | 'gap'
  text: string
  spans?: DiffSpan[] | undefined
}

/** Local exhaustiveness helper — this package does not depend on `dsh-llm`. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a row kind is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable diff row kind: ${String(value)}`)
}

/** The dim class per row kind (path/gap chrome vs the diff's own +/- colors). */
const ROW_CLASS: Record<DiffRow['kind'], string | undefined> = {
  path: css.path,
  del: css.del,
  add: css.add,
  context: css.context,
  gap: css.gap,
}

/** Bound synchronous edit-graph search; one replacement consumes two edits. */
const MAX_DIFF_EDIT_LENGTH = 256

/**
 * Row discriminant for a single line in a diff hunk.
 * @param line - line from a unified diff hunk.
 * @returns the line's diff role.
 */
function rowKind(line: string): 'del' | 'add' | 'context' {
  if (line.startsWith('-')) return 'del'
  if (line.startsWith('+')) return 'add'
  return 'context'
}

/**
 * Append a text span, coalescing with the prior span when both share the same highlight state.
 * @param spans - the target span list to append to.
 * @param text - the slice of text to append.
 * @param highlight - whether the span is an intra-line difference.
 */
function pushSpan(spans: DiffSpan[], text: string, highlight: boolean): void {
  const prev = spans[spans.length - 1]
  if (prev && Boolean(prev.highlight) === highlight) {
    prev.text += text
  } else {
    spans.push(highlight ? { text, highlight: true } : { text })
  }
}

/**
 * Compute word-level differences between a deleted line and an added line.
 * When the search exceeds the edit limit, both sides fall back to a full-line highlight.
 * @param delText - the removed line's content.
 * @param addText - the added line's content.
 * @returns the intra-line spans for the deleted side and the added side.
 */
export function computeWordDiff(delText: string, addText: string): { delSpans: DiffSpan[]; addSpans: DiffSpan[] } {
  const changes = diffWordsWithSpace(delText, addText, { maxEditLength: MAX_DIFF_EDIT_LENGTH })
  if (!changes) {
    return {
      delSpans: [{ text: delText, highlight: true }],
      addSpans: [{ text: addText, highlight: true }],
    }
  }

  const delSpans: DiffSpan[] = []
  const addSpans: DiffSpan[] = []

  for (const change of changes) {
    if (!change.added) {
      pushSpan(delSpans, change.value, change.removed)
    }
    if (!change.removed) {
      pushSpan(addSpans, change.value, change.added)
    }
  }

  return { delSpans, addSpans }
}

/**
 * Parse lines from a unified diff hunk into body rows, pairing adjacent
 * replacement runs of equal length for intra-line word difference highlighting.
 * @param lines - hunk lines prefixed with ' ', '-', or '+'.
 * @returns the parsed diff rows.
 */
export function parseHunkLines(lines: string[]): DiffRow[] {
  const rows: DiffRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const kind1 = rowKind(line)
    if (kind1 === 'context') {
      rows.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line })
      i++
      continue
    }

    const run1: string[] = []
    while (i < lines.length && rowKind(lines[i] as string) === kind1) {
      run1.push((lines[i] as string).slice(1))
      i++
    }

    const kind2 = kind1 === 'del' ? 'add' : 'del'
    const run2: string[] = []
    let j = i
    while (j < lines.length && rowKind(lines[j] as string) === kind2) {
      run2.push((lines[j] as string).slice(1))
      j++
    }

    if (run2.length > 0 && run1.length === run2.length) {
      i = j
      const spans1: DiffSpan[][] = []
      const spans2: DiffSpan[][] = []
      for (let k = 0; k < run1.length; k++) {
        const text1 = run1[k] as string
        const text2 = run2[k] as string
        const delText = kind1 === 'del' ? text1 : text2
        const addText = kind1 === 'add' ? text1 : text2
        const { delSpans, addSpans } = computeWordDiff(delText, addText)
        spans1.push(kind1 === 'del' ? delSpans : addSpans)
        spans2.push(kind2 === 'del' ? delSpans : addSpans)
      }
      for (let k = 0; k < run1.length; k++) {
        rows.push({ kind: kind1, text: run1[k] as string, spans: spans1[k] })
      }
      for (let k = 0; k < run2.length; k++) {
        rows.push({ kind: kind2, text: run2[k] as string, spans: spans2[k] })
      }
    } else {
      for (const text of run1) {
        rows.push({ kind: kind1, text })
      }
    }
  }
  return rows
}

/** Derive exact local patches or a whole-fragment replacement when search exceeds the limit. */
function localHunks(diff: DiffHunk) {
  const oldLines = contentLines(diff.oldText ?? '')
  const newLines = contentLines(diff.newText)
  const normalize = (lines: string[]): string => lines.map(line => `${line}\n`).join('')
  return structuredPatch('', '', normalize(oldLines), normalize(newLines),
    undefined, undefined, { context: 3, maxEditLength: MAX_DIFF_EDIT_LENGTH })?.hunks
    ?? [{ lines: [...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)] }]
}

/**
 * Count displayed additions and deletions. Exact patches exclude shared context;
 * comparisons exceeding the edit limit count both complete fragments as replaced.
 * Text follows {@link contentLines}'s terminator rule.
 * @param diffs - the hunks to count.
 * @returns the +/- totals for summaries and the card footer.
 */
export function diffTotals(diffs: DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    for (const hunk of localHunks(diff)) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++
        if (line.startsWith('-')) removed++
      }
    }
  }
  return { added, removed }
}

/**
 * Flatten local patches into rows and count only added and removed lines.
 * A path header opens each new file. A `⋯` gap separates consecutive same-file
 * fragments and distant patches within a fragment. File counts use distinct paths.
 * @param diffs - the hunks to render.
 * @returns the body rows, the +/- totals, and the distinct-file count.
 */
function buildRows(diffs: DiffHunk[]): { rows: DiffRow[]; added: number; removed: number; files: number } {
  const rows: DiffRow[] = []
  const paths = new Set<string>()
  let prevPath: string | undefined
  for (const diff of diffs) {
    paths.add(diff.path)
    if (diff.path !== prevPath) rows.push({ kind: 'path', text: diff.path })
    else rows.push({ kind: 'gap', text: '⋯' })
    prevPath = diff.path
    for (const [index, hunk] of localHunks(diff).entries()) {
      if (index > 0) rows.push({ kind: 'gap', text: '⋯' })
      rows.push(...parseHunkLines(hunk.lines))
    }
  }
  return {
    rows,
    added: rows.filter(row => row.kind === 'add').length,
    removed: rows.filter(row => row.kind === 'del').length,
    files: paths.size,
  }
}

/**
 * Split a side's text into its content lines. Empty text is zero lines (a full
 * deletion's `newText` or a create's absent `oldText` side draws nothing), and a
 * single trailing newline is a line terminator rather than an extra empty line —
 * the same terminator rule TerminalBlock applies to command output. An interior
 * blank line (a genuine `\n\n`) survives.
 * @param text - the removed or added side's text.
 * @returns the content lines, without the terminating newline.
 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * Copy the full local diff, including folded rows: removed/added lines have
 * `- `/`+ ` prefixes, context has two spaces, and paths and gaps stay verbatim.
 * @param rows - the flattened body rows.
 * @returns the diff as plain text.
 */
function copyText(rows: DiffRow[]): string {
  return rows.map((row) => {
    switch (row.kind) {
      case 'del': return `- ${row.text}`
      case 'add': return `+ ${row.text}`
      case 'context': return `  ${row.text}`
      case 'path': return row.text
      case 'gap': return row.text
      /* v8 ignore next -- closed-union backstop; only reached if a row kind is forged */
      default: return assertNever(row.kind)
    }
  }).join('\n')
}

/**
 * Render a file mutation as an inline diff surface.
 * @param props - see {@link DiffBlockProps}.
 * @returns the diff block element.
 */
export function DiffBlock({ diffs, labels, maxLines = DEFAULT_DIFF_MAX_LINES, className }: DiffBlockProps) {
  const { rows, added, removed, files } = useMemo(() => buildRows(diffs), [diffs])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(copyText(rows)).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, rows])

  const onCopyPath = useCallback((path: string) => {
    if (copiedPath === path) return
    void writeClipboard(path).then((ok) => {
      if (!ok) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(prev => (prev === path ? null : prev))
      }, 1000)
    })
  }, [copiedPath])

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  if (rows.length === 0) return null

  const hidden = rows.length - maxLines
  const capped = hidden > 0 && !expanded
  // Same split arithmetic as TerminalBlock and the TUI transcript's collapsed
  // card, so a body's head and tail slices agree across the front ends.
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = maxLines - headLines
  const head = capped ? rows.slice(0, headLines) : rows
  const tail = capped ? rows.slice(rows.length - tailLines) : []

  const copyPathLabel = labels.copyPath ?? labels.copy
  const pathCopiedLabel = labels.pathCopied ?? labels.copied

  const renderRow = (row: DiffRow, index: number) => {
    if (row.kind === 'path') {
      const isPathCopied = copiedPath === row.text
      const actionLabel = isPathCopied ? pathCopiedLabel : copyPathLabel
      return (
        <div key={index} className={clsx(css.line, ROW_CLASS[row.kind])}>
          <span className={css.pathText}>{row.text}</span>
          <button
            type="button"
            className={css.copyPathButton}
            onClick={() => { onCopyPath(row.text) }}
            title={actionLabel}
            aria-label={actionLabel}
          >
            {isPathCopied ? <IconCheckOutline16 size={12} /> : <IconCopyOutline16 size={12} />}
          </button>
        </div>
      )
    }

    return (
      <div key={index} className={clsx(css.line, ROW_CLASS[row.kind])}>
        {row.spans && row.spans.length > 0 ? (
          row.spans.map((span, sIndex) =>
            span.highlight ? (
              <span key={sIndex} className={css.wordHighlight}>{span.text}</span>
            ) : (
              span.text
            ),
          )
        ) : (
          row.text
        )}
      </div>
    )
  }

  return (
    <div className={clsx(css.block, className)} data-diff="">
      <button type="button" className={css.copyButton} onClick={onCopy}>
        {copied ? labels.copied : labels.copy}
      </button>
      <div className={css.body}>
        {head.map((row, index) => renderRow(row, index))}
        {hidden > 0 && (
          <FoldToggle
            className={css.expand}
            expanded={expanded}
            hidden={hidden}
            labels={labels}
            onToggle={onToggle}
          />
        )}
        {tail.map((row, index) => renderRow(row, headLines + index))}
      </div>
      <div className={css.footer}>└ +{added} -{removed} · {labels.files(files)}</div>
    </div>
  )
}
