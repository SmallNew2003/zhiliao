// @vitest-environment jsdom
/** Toolbar state retains its one frame and unclosed fences stay inert. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { Preview } from '../src/client/Preview.tsx'
import { createPreviewBudget } from '../src/client/budget.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Config } from '../src/config.ts'
import { en } from '../src/client/locales.ts'

const theme = { colorScheme: 'light' as const, background: '#fff', foreground: '#222', accent: '#06f', fontFamily: 'system-ui', fontSize: 14 }
const budgets: ReturnType<typeof createPreviewBudget>[] = []
const dialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
}
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true, value(this: HTMLDialogElement) { this.open = true },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true, value(this: HTMLDialogElement) { this.open = false },
  })
})

afterEach(() => {
  cleanup()
  budgets.splice(0).forEach((budget) => { budget.dispose() })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const [name, descriptor] of Object.entries(dialogMethods)) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name)
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
  }
})
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
  fireEvent.click(view.getByRole('button', { name: 'Source' }))
  expect(view.container.querySelector('iframe')).toBe(frame)
  fireEvent.click(view.getByRole('button', { name: 'Preview' }))
  const enlarge = view.getByRole('button', { name: 'Enlarge' }); enlarge.focus()
  fireEvent.click(enlarge)
  expect(view.getByRole('dialog')).toBeTruthy()
  expect(view.container.querySelector('iframe')).toBe(frame)
  fireEvent(view.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }))
  expect(document.activeElement).toBe(enlarge)
  view.rerender(<Preview {...props} block={{ ...props.block, streaming: false }} />)
  expect(view.container.querySelector('iframe')).toBe(frame)
  fireEvent.click(view.getByRole('button', { name: 'Reload' }))
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBe(frame) })
})

it('shows local load failures with source and recovers only after explicit Reload', async () => {
  const assets = await import('../src/client/runtime/assets.ts')
  const spy = vi.spyOn(assets, 'loadRuntimeAssets').mockRejectedValueOnce(new Error('chunk unavailable'))
  const view = render(<Preview {...harness()} />)
  await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('Visualization failed') })
  expect(view.container.querySelector('code')?.textContent).toBe('<input value="initial">')
  fireEvent.click(view.getByRole('button', { name: 'Reload' }))
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  spy.mockRestore()
})

it('retires a pending asset reader on unmount', async () => {
  const assets = await import('../src/client/runtime/assets.ts')
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof assets.loadRuntimeAssets>>>()
  const spy = vi.spyOn(assets, 'loadRuntimeAssets').mockReturnValueOnce(pending.promise)
  const view = render(<Preview {...harness()} />)
  view.unmount()
  await act(async () => { pending.resolve({ css: [], scripts: [] }); await pending.promise })
  expect(view.container.innerHTML).toBe('')
  spy.mockRestore()
})

it('copies source and reports a clipboard failure locally', async () => {
  const write = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText: write } })
  const view = render(<Preview {...harness(false)} />)
  fireEvent.click(view.getByRole('button', { name: 'Copy' }))
  await waitFor(() => { expect(view.getByRole('button', { name: 'Copied' })).toBeTruthy() })
  expect(write).toHaveBeenCalledWith('<input value="initial">')
  write.mockRejectedValueOnce(new Error('denied'))
  fireEvent.click(view.getByRole('button', { name: 'Copied' }))
  await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('Could not copy source') })
})

it('uses one persistent native dialog for enlargement and handles frame-originated cancellation', async () => {
  const view = render(<Preview {...harness()} />)
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  const frame = view.container.querySelector('iframe')!
  const wrapper = view.container.querySelector('dialog')!
  const showModal = vi.spyOn(wrapper, 'showModal'), close = vi.spyOn(wrapper, 'close')
  fireEvent.click(view.getByRole('button', { name: 'Enlarge' }))
  expect(showModal).toHaveBeenCalledOnce()
  expect(view.getByRole('dialog')).toBe(wrapper)
  fireEvent(wrapper, new Event('cancel', { bubbles: false, cancelable: true }))
  expect(view.queryByRole('dialog')).toBeNull()
  expect(wrapper.open).toBe(true)
  expect(close).toHaveBeenCalledTimes(2)
  expect(view.container.querySelector('iframe')).toBe(frame)
})

type FrameRequest = { type: string; generation: string; requestId: string; format: string; chart?: string }
type TestPort = {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: ReturnType<typeof vi.fn<(message: FrameRequest) => void>>
  close: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
}

function browserChannel() {
  const ports: { port: TestPort; generation: string }[] = []
  vi.stubGlobal('MessageChannel', class {
    port1: TestPort = {
      onmessage: null, postMessage: vi.fn<(message: FrameRequest) => void>(), close: vi.fn(), start: vi.fn(),
    }
    port2 = {}
    constructor() { ports.push({ port: this.port1, generation: '' }) }
  })
  return {
    async connect(frame: HTMLIFrameElement) {
      await waitFor(() => { expect(ports.length).toBeGreaterThan(0) })
      const current = ports.at(-1)!
      current.generation = /"generation":"([^"]+)"/u.exec(frame.srcdoc)![1]!
      return {
        port: current.port,
        async respond(message: object) {
          await act(async () => {
            current.port.onmessage?.({ data: { generation: current.generation, ...message } } as MessageEvent)
          })
        },
      }
    },
  }
}

it('dismisses enlargement on frame Escape while keeping an inline frame active', async () => {
  const channel = browserChannel(), view = render(<Preview {...harness()} />)
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  const frame = view.container.querySelector('iframe')!, connection = await channel.connect(frame)
  await connection.respond({ type: 'ready', title: '', charts: [] })
  await connection.respond({ type: 'escape' })
  expect(view.queryByRole('dialog')).toBeNull()
  expect(view.container.querySelector('iframe')).toBe(frame)
  const enlarge = view.getByRole('button', { name: 'Enlarge' })
  fireEvent.click(enlarge)
  expect(view.getByRole('dialog')).toBeTruthy()
  await connection.respond({ type: 'escape' })
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(enlarge)
  expect(view.container.querySelector('iframe')).toBe(frame)
})

it('shows late chart exports and retains or repairs the selected chart as the catalog changes', async () => {
  const channel = browserChannel(), view = render(<Preview {...harness()} />)
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  const frame = view.container.querySelector('iframe')!, connection = await channel.connect(frame)
  await connection.respond({ type: 'ready', title: '', charts: [] })
  expect(view.queryByRole('button', { name: 'Download PNG' })).toBeNull()
  await connection.respond({ type: 'charts', charts: ['2', '3'] })
  expect(view.getByRole('button', { name: 'Download PNG' })).toBeTruthy()
  const chooser = view.getByRole('combobox', { name: 'Chart' }) as HTMLSelectElement
  expect(chooser.value).toBe('2')
  fireEvent.change(chooser, { target: { value: '3' } })
  await connection.respond({ type: 'charts', charts: ['2', '3', '4'] })
  expect(chooser.value).toBe('3')
  await connection.respond({ type: 'charts', charts: ['4', '5'] })
  expect(chooser.value).toBe('4')
  fireEvent.click(view.getByRole('button', { name: 'Download PNG' }))
  expect(connection.port.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ format: 'png', chart: '4' })
  await connection.respond({ type: 'charts', charts: [] })
  expect(view.queryByRole('button', { name: 'Download PNG' })).toBeNull()
  expect(view.container.querySelector('iframe')).toBe(frame)
})

it('downloads source, offline HTML and a chosen helper chart only from toolbar gestures', async () => {
  const channel = browserChannel(), download = vi.fn<Parameters<typeof Preview>[0]['download']>()
  const props = { ...harness(), download }
  const view = render(<Preview {...props} />)
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  const frame = view.container.querySelector('iframe')!
  const connection = await channel.connect(frame)
  await connection.respond({ type: 'height', height: 300 })
  expect(frame.style.height).toBe('300px')
  await connection.respond({ type: 'ready', title: 'Revenue', charts: ['1', '2'] })
  expect(frame.title).toBe('Revenue')
  fireEvent.click(view.getByRole('button', { name: 'Download source' }))
  expect(new TextDecoder().decode(download.mock.calls[0]?.[0])).toBe('<input value="initial">')
  fireEvent.click(view.getByRole('button', { name: 'Download HTML' }))
  const html = new TextDecoder().decode(download.mock.calls[1]?.[0])
  expect(html).toContain('const offline = true;'); expect(html).not.toContain('dsh-preview-init')
  fireEvent.change(view.getByRole('combobox', { name: 'Chart' }), { target: { value: '2' } })
  fireEvent.click(view.getByRole('button', { name: 'Download PNG' }))
  const request = connection.port.postMessage.mock.calls.at(-1)![0]
  expect(request).toMatchObject({ format: 'png', chart: '2' })
  await connection.respond({ type: 'export', requestId: request.requestId, mime: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' })
  expect(download.mock.calls[2]?.[0].length).toBe(8)
  expect(download.mock.calls[2]?.[1]).toBe('image/png')
  fireEvent.load(frame)
  expect(view.getByRole('alert').textContent).toBe('Preview left its controlled document')
  expect(view.container.querySelector('iframe')).toBeNull()
  expect(connection.port.close).toHaveBeenCalledOnce()
})

it('exports Mermaid SVG and retires pending exports when a frame is reloaded', async () => {
  const channel = browserChannel(), download = vi.fn<Parameters<typeof Preview>[0]['download']>()
  const base = harness()
  const props = { ...base, download, block: { ...base.block, language: 'mermaid', code: 'flowchart LR\n A-->B' }, matched: { kind: 'valid' as const, language: 'mermaid' as const, closed: true, libraries: [] } }
  const view = render(<Preview {...props} />)
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  const frame = view.container.querySelector('iframe')!
  const connection = await channel.connect(frame)
  await connection.respond({ type: 'ready', title: '', charts: [] })
  fireEvent.click(view.getByRole('button', { name: 'Download source' }))
  expect(download.mock.calls[0]?.[2]).toBe('Visualization.mmd')
  fireEvent.click(view.getByRole('button', { name: 'Download SVG' }))
  const request = connection.port.postMessage.mock.calls.at(-1)![0]
  await connection.respond({ type: 'export', requestId: request.requestId, mime: 'image/svg+xml', data: '<svg/>' })
  expect(download.mock.calls[1]?.[1]).toBe('image/svg+xml')
  fireEvent.click(view.getByRole('button', { name: 'Download SVG' }))
  fireEvent.click(view.getByRole('button', { name: 'Reload' }))
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBe(frame) })
  await connection.respond({ type: 'export', requestId: 'stale', mime: 'image/svg+xml', data: '<svg/>' })
  expect(download).toHaveBeenCalledTimes(2)
  expect(view.queryByRole('alert')).toBeNull()
})

it.each(['readinessTimeout', 'script broke'])('keeps source readable after frame failure: %s', async (error) => {
  const channel = browserChannel()
  const view = render(<Preview {...harness()} />)
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  const connection = await channel.connect(view.container.querySelector('iframe')!)
  await connection.respond({ type: 'error', error })
  expect(view.getByRole('alert').textContent).toBe(error === 'readinessTimeout' ? 'Visualization did not become ready in time' : 'Visualization failed: script broke')
  expect(view.container.querySelector('code')?.textContent).toBe('<input value="initial">')
  expect(view.container.querySelector('iframe')).toBeNull()
})

it.each([new Error('exportTooLarge'), new Error('other'), 'non-error'])('reports export rejection locally: %s', async (error) => {
  const download = vi.fn<Parameters<typeof Preview>[0]['download']>(() => { throw error })
  const view = render(<Preview {...harness(false)} download={download} />)
  fireEvent.click(view.getByRole('button', { name: 'Download source' }))
  await waitFor(() => { expect(view.getByRole('alert').textContent).toBe(error instanceof Error && error.message === 'exportTooLarge' ? 'Download exceeds the configured limit' : 'Could not download visualization') })
})

it('evicts offscreen frames, preserves an enlarged active frame, and remounts initial source on activation', async () => {
  const callbacks: IntersectionObserverCallback[] = []
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { callbacks.push(callback) }
    observe() {}
    disconnect = disconnect
  })
  const props = harness()
  const view = render(<Preview {...props} />)
  expect(view.container.querySelector('iframe')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Activate preview' }))
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  const frame = view.container.querySelector('iframe')!
  await act(async () => { callbacks[0]?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver) })
  fireEvent.click(view.getByRole('button', { name: 'Enlarge' }))
  await act(async () => { callbacks[0]?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver) })
  expect(view.container.querySelector('iframe')).toBe(frame)
  fireEvent.click(view.getByRole('button', { name: 'Close' }))
  await act(async () => { callbacks[0]?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver) })
  expect(view.container.querySelector('iframe')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Activate preview' }))
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  expect(view.container.querySelector('iframe')?.srcdoc).toContain('initial')
  view.unmount(); expect(disconnect).toHaveBeenCalledOnce()
  await act(async () => { callbacks[0]?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver) })
  expect(budgets.at(-1)?.getSnapshot()).toEqual([])
})

it('declares ECharts before asset loading and retires a rejected reader on unmount', async () => {
  const assets = await import('../src/client/runtime/assets.ts')
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof assets.loadRuntimeAssets>>>()
  const spy = vi.spyOn(assets, 'loadRuntimeAssets').mockReturnValueOnce(pending.promise)
  const base = harness()
  const view = render(<Preview {...base} matched={{ kind: 'valid', language: 'html', libraries: ['echarts'], closed: true }} />)
  expect(spy).toHaveBeenCalledWith('html', ['echarts'])
  view.unmount()
  await act(async () => { pending.reject(new Error('retired reader')); await expect(pending.promise).rejects.toThrow('retired reader') })
  expect(view.container.innerHTML).toBe('')
})

it('does not download an export settled in the same tick as owner removal', async () => {
  const channel = browserChannel(), download = vi.fn<Parameters<typeof Preview>[0]['download']>(), base = harness()
  const view = render(<Preview {...base} download={download} matched={{ kind: 'valid', language: 'mermaid', libraries: [], closed: true }} />)
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  const frame = view.container.querySelector('iframe')!, connection = await channel.connect(frame)
  await connection.respond({ type: 'ready', title: '', charts: [] })
  fireEvent.click(view.getByRole('button', { name: 'Download SVG' }))
  const request = connection.port.postMessage.mock.calls.at(-1)![0]
  await act(async () => {
    connection.port.onmessage?.({ data: { type: 'export', generation: request.generation, requestId: request.requestId, mime: 'image/svg+xml', data: '<svg/>' } } as MessageEvent)
    view.unmount()
  })
  expect(download).not.toHaveBeenCalled()
})

it('downloads offline HTML with the localized fallback title when the document title is empty', async () => {
  const download = vi.fn<Parameters<typeof Preview>[0]['download']>(), view = render(<Preview {...harness()} download={download} />)
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  fireEvent.click(view.getByRole('button', { name: 'Download HTML' }))
  expect(download.mock.calls[0]?.[2]).toBe('Visualization.html')
})
