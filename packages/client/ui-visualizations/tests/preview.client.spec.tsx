// @vitest-environment jsdom
/** Toolbar state retains its one frame and unclosed fences stay inert. */
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { Preview } from '../src/client/Preview.tsx'
import { createPreviewBudget } from '../src/client/budget.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Config } from '../src/config.ts'
import { en } from '../src/client/locales.ts'

const theme = { colorScheme: 'light' as const, background: '#fff', foreground: '#222', accent: '#06f', fontFamily: 'system-ui', fontSize: 14 }
const budgets: ReturnType<typeof createPreviewBudget>[] = []
afterEach(() => { cleanup(); budgets.splice(0).forEach((budget) => { budget.dispose() }) })
function harness(closed = true) {
  const budget = createPreviewBudget(4); budgets.push(budget)
  const props = {
    block: { code: '<input value="initial">', language: 'html', meta: 'preview runtime=dsh-v1', closed, sourceOffset: 0, streaming: !closed },
    matched: { kind: 'valid' as const, language: 'html' as const, libraries: [], closed },
    config: Config({}), t: makeTranslate(en), useBudget: bindSnapshotSelector(budget),
    useTheme: bindSnapshotSelector(createSnapshotStore(theme)),
    enter: (id: string) => { budget.enter(id) },
    leave: (id: string) => { budget.leave(id) },
    activate: (id: string) => { budget.activate(id) },
    download() {},
    filename: (title: string, extension: string) => `${title}.${extension}`,
  }
  return props as unknown as Parameters<typeof Preview>[0]
}

it('does not mount an executing iframe for an unclosed fence', async () => {
  const view = render(<Preview {...harness(false)} />)
  expect(view.container.querySelector('iframe')).toBeNull()
  expect(view.getByText('Waiting for a closing fence')).toBeTruthy()
  expect(view.getByText('<input value="initial">')).toBeTruthy()
})

it('preserves its active iframe through source switching, enlargement, and settlement', async () => {
  const props = harness()
  const view = render(<Preview {...props} />)
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  const frame = view.container.querySelector('iframe')!
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  fireEvent.click(view.getByRole('button', { name: 'Source', exact: true }))
  expect(view.container.querySelector('iframe')).toBe(frame)
  fireEvent.click(view.getByRole('button', { name: 'Preview', exact: true }))
  const enlarge = view.getByRole('button', { name: 'Enlarge' }); enlarge.focus()
  fireEvent.click(enlarge)
  expect(view.getByRole('dialog')).toBeTruthy()
  expect(view.container.querySelector('iframe')).toBe(frame)
  fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' })
  expect(document.activeElement).toBe(enlarge)
  view.rerender(<Preview {...props} block={{ ...props.block, streaming: false }} />)
  expect(view.container.querySelector('iframe')).toBe(frame)
  fireEvent.click(view.getByRole('button', { name: 'Reload' }))
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBe(frame) })
})
