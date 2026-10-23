// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { DEFAULT_DIFF_MAX_LINES, DiffBlock as LocalizedDiffBlock, type DiffHunk } from '../src/index.ts'
import { diffBlockLabels } from './labels.client.ts'
import { computeWordDiff, diffTotals, parseHunkLines } from '../src/DiffBlock.tsx'

function DiffBlock(props: Omit<ComponentProps<typeof LocalizedDiffBlock>, 'labels'>) {
  return <LocalizedDiffBlock {...props} labels={diffBlockLabels} />
}

afterEach(cleanup)

beforeEach(() => {
  vi.useRealTimers()
})

function bodyRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[class*="_line_"]')].map(row => row.textContent ?? '')
}

function changeRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[class*="_del_"], [class*="_add_"]')].map(row => row.textContent ?? '')
}

function highlightSpans(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[class*="_wordHighlight_"]')].map(span => span.textContent ?? '')
}

function added(count: number): string {
  return Array.from({ length: count }, (_v, i) => `line ${i + 1}`).join('\n')
}

describe('DiffBlock structure', () => {
  it('renders a create as a path header and an added block (no removed side)', () => {
    const diffs: DiffHunk[] = [{ path: 'notes/new.txt', oldText: null, newText: 'hello\nworld' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(screen.getByText('notes/new.txt')).toBeTruthy()
    // No removed rows: both change lines are added.
    expect(changeRows(container)).toEqual(['hello', 'world'])
    expect(container.querySelectorAll('[class*="_del_"]').length).toBe(0)
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(2)
  })

  it('renders an edit as a removed block above an added block', () => {
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: 'old', newText: 'new' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(container.querySelectorAll('[class*="_del_"]').length).toBe(1)
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(1)
    expect(changeRows(container)).toEqual(['old', 'new'])
  })

  it('opens a same-file second hunk with a gap instead of repeating the path', () => {
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: 'x', newText: 'y' },
      { path: 'a.ts', oldText: 'p', newText: 'q' },
    ]
    const { container } = render(<DiffBlock diffs={diffs} />)
    // One path header, one gap row.
    expect(container.querySelectorAll('[class*="_path_"]').length).toBe(1)
    expect(container.querySelectorAll('[class*="_gap_"]').length).toBe(1)
  })

  it('opens a new file with its own path header', () => {
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: 'x', newText: 'y' },
      { path: 'b.ts', oldText: 'p', newText: 'q' },
    ]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(container.querySelectorAll('[class*="_path_"]').length).toBe(2)
    expect(container.querySelectorAll('[class*="_gap_"]').length).toBe(0)
  })

  it('renders nothing for empty diffs', () => {
    const { container } = render(<DiffBlock diffs={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('treats a trailing newline as a terminator, not an extra blank line', () => {
    // A create whose newText ends in a newline is one added line, not two, and
    // the footer counts one — the phantom `+ ` empty line the naive split drew.
    const { container } = render(<DiffBlock diffs={[{ path: 'n.txt', oldText: null, newText: 'hello\n' }]} />)
    expect(changeRows(container)).toEqual(['hello'])
    expect(screen.getByText('└ +1 -0 · 1 file')).toBeTruthy()
  })

  it('renders a full deletion as removed-only with no phantom added line', () => {
    // newText '' is zero added lines: an empty string must contribute nothing.
    const { container } = render(<DiffBlock diffs={[{ path: 'gone.ts', oldText: 'a\nb', newText: '' }]} />)
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(0)
    expect(screen.getByText('└ +0 -2 · 1 file')).toBeTruthy()
  })

  it('keeps a genuine interior blank line', () => {
    const { container } = render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x\n\ny' }]} />)
    expect(container.querySelectorAll('[class*="_add_"]').length).toBe(3)
  })
})

describe('DiffBlock local changes', () => {
  it.each([128, 129])('renders and copies %i replacements with bounded comparison', async (count) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const oldLines = ['shared context', ...Array.from({ length: count }, (_, i) => `old ${i}`)]
    const newLines = ['shared context', ...Array.from({ length: count }, (_, i) => `new ${i}`)]
    const diffs = [{ path: 'large.txt', oldText: oldLines.join('\n'), newText: newLines.join('\n') }]
    const total = count === 128 ? count : count + 1
    render(<DiffBlock diffs={diffs} maxLines={1000} />)
    expect(diffTotals(diffs)).toEqual({ added: total, removed: total })
    expect(screen.getByText(`└ +${total} -${total} · 1 file`)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制' })) })
    expect(writeText).toHaveBeenCalledWith(count === 128
      ? ['large.txt', '  shared context', ...oldLines.slice(1).map(line => `- ${line}`), ...newLines.slice(1).map(line => `+ ${line}`)].join('\n')
      : ['large.txt', ...oldLines.map(line => `- ${line}`), ...newLines.map(line => `+ ${line}`)].join('\n'))
  })

  it('keeps a sparse edit exact in a ten-thousand-line fragment', () => {
    const before = Array.from({ length: 10000 }, (_, i) => `line ${i}`)
    const after = [...before]
    after[5000] = 'changed'
    const diffs = [{ path: 'sparse.txt', oldText: before.join('\n'), newText: after.join('\n') }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(diffTotals(diffs)).toEqual({ added: 1, removed: 1 })
    expect(bodyRows(container)).toEqual([
      'sparse.txt', 'line 4997', 'line 4998', 'line 4999', 'line 5000', 'changed',
      'line 5001', 'line 5002', 'line 5003',
    ])
  })

  it('copies shared context once and counts only a changed line', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const diffs = [{ path: 'settings.ts', oldText: 'start\nmode = 1\nend', newText: 'start\nmode = 2\nend' }]
    render(<DiffBlock diffs={diffs} />)
    expect(screen.getAllByText('start')).toHaveLength(1)
    expect(screen.getAllByText('end')).toHaveLength(1)
    expect(screen.getByText('└ +1 -1 · 1 file')).toBeTruthy()
    expect(diffTotals(diffs)).toEqual({ added: 1, removed: 1 })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制' })) })
    expect(writeText).toHaveBeenCalledWith('settings.ts\n  start\n- mode = 1\n+ mode = 2\n  end')
  })

  it('keeps three neutral context lines around distant changes and separates hunks', () => {
    const before = Array.from({ length: 50 }, (_, i) => `item ${i}`)
    const after = before.map((line, i) => i === 10 || i === 40 ? `changed ${i}` : line)
    const { container } = render(<DiffBlock diffs={[{
      path: 'items.txt', oldText: before.join('\n'), newText: after.join('\n'),
    }]} maxLines={100} />)
    expect(bodyRows(container)).toEqual([
      'items.txt', 'item 7', 'item 8', 'item 9', 'item 10', 'changed 10',
      'item 11', 'item 12', 'item 13', '⋯', 'item 37', 'item 38', 'item 39',
      'item 40', 'changed 40', 'item 41', 'item 42', 'item 43',
    ])
    expect(changeRows(container)).toEqual(['item 10', 'changed 10', 'item 40', 'changed 40'])
    expect(screen.getByText('└ +2 -2 · 1 file')).toBeTruthy()
  })

  it.each([
    ['a\nx\na\ny\na', 'a\nx\na\nz\na', 1, 1],
    ['a\nb', 'a\nx\nb', 1, 0],
    ['a\nx\nb', 'a\nb', 0, 1],
    ['same\n', 'same', 0, 0],
    ['same', 'same', 0, 0],
    ['', '', 0, 0],
    ['a\n\nb', 'a\nb', 0, 1],
  ])('counts ordered changes in %j → %j', (oldText, newText, added, removed) => {
    const diffs = [{ path: 'a.txt', oldText, newText }]
    render(<DiffBlock diffs={diffs} />)
    expect(diffTotals(diffs)).toEqual({ added, removed })
    expect(screen.getByText(`└ +${added} -${removed} · 1 file`)).toBeTruthy()
  })
})

describe('DiffBlock footer', () => {
  it('counts added and removed lines and one file', () => {
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: 'a\nb', newText: 'c' }]
    render(<DiffBlock diffs={diffs} />)
    expect(screen.getByText('└ +1 -2 · 1 file')).toBeTruthy()
  })

  it('pluralizes the distinct-file count', () => {
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: null, newText: 'x' },
      { path: 'b.ts', oldText: null, newText: 'y' },
    ]
    render(<DiffBlock diffs={diffs} />)
    expect(screen.getByText('└ +2 -0 · 2 files')).toBeTruthy()
  })
})

describe('DiffBlock height cap', () => {
  it('shows head and tail with an expand control past the cap, then all lines expanded', () => {
    // One added line over the default cap forces the collapse.
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: null, newText: added(DEFAULT_DIFF_MAX_LINES) }]
    // The path header counts as a row, so a body of maxLines added lines plus
    // the header is one over the cap.
    const { container } = render(<DiffBlock diffs={diffs} />)
    const toggle = screen.getByRole('button', { name: /展开其余/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Collapsed shows fewer rows than the full body.
    const collapsedCount = bodyRows(container).length
    expect(collapsedCount).toBeLessThan(DEFAULT_DIFF_MAX_LINES + 1)
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '收起差异' }).getAttribute('aria-expanded')).toBe('true')
    expect(bodyRows(container).length).toBeGreaterThan(collapsedCount)
  })

  it('shows no expand control at or under the cap', () => {
    const diffs: DiffHunk[] = [{ path: 'a.ts', oldText: null, newText: added(4) }]
    render(<DiffBlock diffs={diffs} maxLines={16} />)
    expect(screen.queryByRole('button', { name: /展开其余|收起差异/ })).toBeNull()
  })
})

describe('DiffBlock copy', () => {
  it('copies the prefixed diff text and flips the label on success', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const diffs: DiffHunk[] = [
      { path: 'a.ts', oldText: 'old', newText: 'new' },
      { path: 'a.ts', oldText: 'p', newText: 'q' },
    ]
    render(<DiffBlock diffs={diffs} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    // Path header, del/add prefixes, and the same-file gap all reach the clipboard.
    expect(writeText).toHaveBeenCalledWith('a.ts\n- old\n+ new\n⋯\n- p\n+ q')
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('keeps the label on a refused clipboard write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x' }]} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('ignores a second click while the copied label is showing', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<DiffBlock diffs={[{ path: 'a.ts', oldText: null, newText: 'x' }]} />)
    const copy = screen.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(copy) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制成功' })) })
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})

describe('DiffBlock word-level highlighting', () => {
  it('highlights fine-grained variable change within paired replacement line', () => {
    const diffs: DiffHunk[] = [{ path: 'code.ts', oldText: 'const oldVar = 1', newText: 'const newVar = 1' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(highlightSpans(container)).toEqual(['oldVar', 'newVar'])
    const delLine = container.querySelector('[class*="_del_"]')
    const addLine = container.querySelector('[class*="_add_"]')
    expect(delLine?.querySelector('[class*="_wordHighlight_"]')?.textContent).toBe('oldVar')
    expect(addLine?.querySelector('[class*="_wordHighlight_"]')?.textContent).toBe('newVar')
  })

  it('highlights typo fix on a single line', () => {
    const diffs: DiffHunk[] = [{ path: 'code.ts', oldText: 'calclate()', newText: 'calculate()' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(highlightSpans(container)).toEqual(['calclate', 'calculate'])
  })

  it('pairs and highlights multiple replacement lines of equal length', () => {
    const diffs: DiffHunk[] = [{
      path: 'calc.ts',
      oldText: 'const x = 1\nconst y = 2',
      newText: 'const x = 10\nconst y = 20',
    }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(highlightSpans(container)).toEqual(['1', '2', '10', '20'])
  })

  it('coalesces adjacent unchanged tokens during word insertion', () => {
    const diffs: DiffHunk[] = [{ path: 'greeting.ts', oldText: 'hello world', newText: 'hello brave world' }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(highlightSpans(container)).toEqual(['brave '])
  })

  it('does not highlight intra-line words when replacement runs have unequal lengths', () => {
    const diffs: DiffHunk[] = [{
      path: 'list.ts',
      oldText: 'item 1',
      newText: 'item 1\nitem 2',
    }]
    const { container } = render(<DiffBlock diffs={diffs} />)
    expect(highlightSpans(container)).toEqual([])
  })

  it('falls back to full-line highlight when intra-line diff exceeds max edit length', () => {
    const oldLine = Array.from({ length: 130 }, (_, i) => `a${i}`).join(' ')
    const newLine = Array.from({ length: 130 }, (_, i) => `b${i}`).join(' ')
    const res = computeWordDiff(oldLine, newLine)
    expect(res.delSpans).toEqual([{ text: oldLine, highlight: true }])
    expect(res.addSpans).toEqual([{ text: newLine, highlight: true }])
  })

  it('parses inverted hunk lines where add precedes del and context without space', () => {
    const rows = parseHunkLines(['no-space-context', '+new line', '-old line'])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ kind: 'context', text: 'no-space-context' })
    expect(rows[1]!.kind).toBe('add')
    expect(rows[2]!.kind).toBe('del')
    expect(rows[1]!.spans).toBeDefined()
    expect(rows[2]!.spans).toBeDefined()
  })
})

describe('DiffBlock copy path', () => {
  it('renders a copy path button on the file header and copies the path', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const diffs: DiffHunk[] = [{ path: 'src/model.ts', oldText: 'a', newText: 'b' }]
    render(<DiffBlock diffs={diffs} />)

    const copyPathBtn = screen.getByRole('button', { name: '复制路径' })
    expect(copyPathBtn).toBeTruthy()
    expect(copyPathBtn.getAttribute('title')).toBe('复制路径')

    await act(async () => { fireEvent.click(copyPathBtn) })
    expect(writeText).toHaveBeenCalledWith('src/model.ts')
    expect(screen.getByRole('button', { name: '已复制路径' })).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByRole('button', { name: '复制路径' })).toBeTruthy()
  })

  it('keeps the label on a refused path clipboard write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<DiffBlock diffs={[{ path: 'src/file.ts', oldText: null, newText: 'x' }]} />)
    const copyPathBtn = screen.getByRole('button', { name: '复制路径' })
    await act(async () => { fireEvent.click(copyPathBtn) })
    expect(screen.getByRole('button', { name: '复制路径' })).toBeTruthy()
  })

  it('ignores a second click on copy path while copied feedback is active', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<DiffBlock diffs={[{ path: 'src/file.ts', oldText: null, newText: 'x' }]} />)
    const copyPathBtn = screen.getByRole('button', { name: '复制路径' })
    await act(async () => { fireEvent.click(copyPathBtn) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '已复制路径' })) })
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('supports copying paths independently across multiple files', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const diffs: DiffHunk[] = [
      { path: 'first.ts', oldText: 'a', newText: 'b' },
      { path: 'second.ts', oldText: 'c', newText: 'd' },
    ]
    render(<DiffBlock diffs={diffs} />)
    const copyPathButtons = screen.getAllByRole('button', { name: '复制路径' })
    expect(copyPathButtons).toHaveLength(2)

    await act(async () => { fireEvent.click(copyPathButtons[0]!) })
    expect(writeText).toHaveBeenCalledWith('first.ts')
    expect(screen.getByRole('button', { name: '已复制路径' })).toBeTruthy()

    // Advance 500ms so timer 1 is due at 1000ms, whereas timer 2 will be due at 1500ms
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })

    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '复制路径' })[0]!) })
    expect(writeText).toHaveBeenCalledWith('second.ts')

    // Advance 500ms (reaching 1000ms): timer 1 fires, prev is second.ts, so prev !== first.ts -> preserves second.ts
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.getByRole('button', { name: '已复制路径' })).toBeTruthy()

    // Advance 500ms (reaching 1500ms): timer 2 fires, resets back to idle
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.getAllByRole('button', { name: '复制路径' })).toHaveLength(2)
  })

  it('falls back to labels.copy and labels.copied when copyPath labels are omitted', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const labelsWithoutCopyPath = {
      copy: 'Copy',
      copied: 'Copied',
      collapseAria: 'Collapse',
      expandAria: (n: number) => `Expand ${n}`,
      collapse: 'Collapse',
      expand: (n: number) => `Expand ${n}`,
      files: (n: number) => `${n} files`,
    }
    const diffs: DiffHunk[] = [{ path: 'fallback.ts', oldText: '1', newText: '2' }]
    const { container } = render(<LocalizedDiffBlock diffs={diffs} labels={labelsWithoutCopyPath} />)

    const pathButtons = container.querySelectorAll('[class*="_copyPathButton_"]')
    expect(pathButtons).toHaveLength(1)
    const btn = pathButtons[0] as HTMLButtonElement
    expect(btn.getAttribute('aria-label')).toBe('Copy')

    await act(async () => { fireEvent.click(btn) })
    expect(writeText).toHaveBeenCalledWith('fallback.ts')
    expect(btn.getAttribute('aria-label')).toBe('Copied')

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(btn.getAttribute('aria-label')).toBe('Copy')
  })
})
