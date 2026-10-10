/** Execute generated documents after native load; Chromium separately covers modules. */
import { JSDOM, VirtualConsole } from 'jsdom'
import { MessageChannel, MessagePort } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { createPreviewDocument, createStandaloneDocument } from '../src/client/runtime/document.ts'

const theme = { colorScheme: 'light' as const, background: '#fff', foreground: '#222', accent: '#06f', fontFamily: 'system-ui', fontSize: 14 }
const source = `<output id="result">initial</output><script>
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('result').textContent = 'initialized';
  document.body.dataset.initializations = String(Number(document.body.dataset.initializations || 0) + 1);
});
</script>`

it.each([
  { offline: false, fails: false }, { offline: true, fails: false }, { offline: false, fails: true },
])('initializes listeners only after successful scripts, offline=$offline fails=$fails', async ({ offline, fails }) => {
  const channel = new MessageChannel()
  let ready = false
  let error: string | undefined
  channel.port1.on('message', (message: { type: string; error?: string }) => {
    if (message.type === 'ready') ready = true
    if (message.type === 'error') error = message.error
  })
  const input = { source: source + (fails ? '<script>throw new Error("authored initialization failed")</script>' : ''), language: 'html' as const, assets: { css: [], scripts: [] }, theme }
  const html = offline ? createStandaloneDocument(input) : createPreviewDocument({ ...input, generation: 'test' })
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      Object.assign(window, {
        MessagePort,
        ResizeObserver: class { observe() {} disconnect() {} },
        requestAnimationFrame() {},
      })
    },
  })
  try {
    await new Promise<void>((resolve) => { dom.window.addEventListener('load', () => { resolve() }, { once: true }) })
    if (!offline) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        source: dom.window as unknown as Window,
        data: { type: 'dsh-preview-init', generation: 'test' },
        ports: [channel.port2 as unknown as globalThis.MessagePort],
      }))
      await expect.poll(() => fails ? error !== undefined : ready).toBe(true)
    }
    await Promise.resolve()
    expect(dom.window.document.getElementById('result')?.textContent).toBe(fails ? 'initial' : 'initialized')
    expect(dom.window.document.body.dataset.initializations).toBe(fails ? undefined : '1')
    if (fails) expect(error).toBe('authored initialization failed')
  } finally { channel.port1.close(); channel.port2.close(); dom.window.close() }
})
