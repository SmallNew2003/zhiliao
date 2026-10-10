// @vitest-environment jsdom
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownText } from '../src/index.ts'
import type { MarkdownCodeBlock, MarkdownCodeBlockRenderer } from '../src/index.ts'

afterEach(cleanup)

const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }

describe('Markdown code-block renderer', () => {
  it.each(['```', '`````', '~~~', '~~~~~'])('reports explicit closure and raw metadata for %s fences with CRLF', (fence) => {
    const renderCodeBlock = vi.fn<MarkdownCodeBlockRenderer>((_block, fallback) => fallback)
    const prefix = 'Intro.\r\n\r\n'
    render(<MarkdownText text={`${prefix}${fence}html preview runtime=dsh-v1 libs=echarts\r\n<b>Hello</b>\r\n${fence}`}
      labels={labels} renderCodeBlock={renderCodeBlock} />)
    expect(renderCodeBlock).toHaveBeenCalledWith({
      code: '<b>Hello</b>', language: 'html', meta: 'preview runtime=dsh-v1 libs=echarts',
      closed: true, sourceOffset: prefix.length, streaming: false,
    }, expect.anything())
  })

  it.each([true, false])('requires an authored closing delimiter even at end-of-input (streaming=%s)', (streaming) => {
    const renderCodeBlock = vi.fn<MarkdownCodeBlockRenderer>((_block, fallback) => fallback)
    render(<MarkdownText text={'```html preview runtime=dsh-v1\n<b>Hello</b>\n'}
      streaming={streaming} labels={labels} renderCodeBlock={renderCodeBlock} />)
    expect(renderCodeBlock.mock.calls.at(-1)?.[0]).toMatchObject({ closed: false, streaming })
  })

  it.each(['```', '~~~~', '````` suffix', '    `````'])('keeps a mismatched final line open: %s', (ending) => {
    const renderCodeBlock = vi.fn<MarkdownCodeBlockRenderer>((_block, fallback) => fallback)
    render(<MarkdownText text={`\`\`\`\`\`html preview runtime=dsh-v1\nhello\n${ending}`}
      labels={labels} renderCodeBlock={renderCodeBlock} />)
    expect(renderCodeBlock.mock.calls.at(-1)?.[0].closed).toBe(false)
  })

  it('reports unmarked and empty fences with absent language and metadata', () => {
    const renderCodeBlock = vi.fn<MarkdownCodeBlockRenderer>((_block, fallback) => fallback)
    const view = render(<MarkdownText text={'```\n```'} labels={labels} renderCodeBlock={renderCodeBlock} />)
    expect(renderCodeBlock.mock.calls.at(-1)?.[0]).toEqual({
      code: '', language: undefined, meta: undefined, closed: true, sourceOffset: 0, streaming: false,
    })
    expect(view.container.querySelector('pre code')).not.toBeNull()
  })

  it('keeps absolute offsets and closure through character-sized CRLF appends behind frozen blocks', () => {
    const seen: MarkdownCodeBlock[] = []
    const renderCodeBlock: MarkdownCodeBlockRenderer = (block, fallback) => { seen.push(block); return fallback }
    const prefix = 'One.\n\nTwo.\n\nThree.\n\nFour.\n\n'
    const opened = `${prefix}  ~~~~~html preview runtime=dsh-v1\r\n`
    const body = 'hello\r\nworld\r\n'
    const view = render(<MarkdownText text={opened} streaming labels={labels} renderCodeBlock={renderCodeBlock} />)
    let text = opened
    for (const char of body) {
      text += char
      view.rerender(<MarkdownText text={text} streaming labels={labels} renderCodeBlock={renderCodeBlock} />)
      expect(seen.at(-1)).toMatchObject({ closed: false, sourceOffset: prefix.length + 2 })
    }
    text += '  ~~~~~~'
    view.rerender(<MarkdownText text={text} streaming labels={labels} renderCodeBlock={renderCodeBlock} />)
    expect(seen.at(-1)).toMatchObject({ closed: true, code: 'hello\r\nworld', sourceOffset: prefix.length + 2 })
  })

  it('refreshes frozen presentation when the callback changes', () => {
    const text = '```html\nhello\n```\n\nOne.\n\nTwo.\n\nThree.'
    const first: MarkdownCodeBlockRenderer = () => <span>first</span>
    const second: MarkdownCodeBlockRenderer = () => <span>second</span>
    const view = render(<MarkdownText text={text} streaming labels={labels} renderCodeBlock={first} />)
    expect(view.container.textContent).toContain('first')
    view.rerender(<MarkdownText text={text} streaming labels={labels} renderCodeBlock={second} />)
    expect(view.container.textContent).toContain('second')
    expect(view.container.textContent).not.toContain('first')
  })

  it.each([
    '> ```html preview runtime=dsh-v1\n> quoted\n> ```',
    '- item\n\n  ```html preview runtime=dsh-v1\n  nested\n  ```',
    '    ```html preview runtime=dsh-v1\n    indented\n    ```',
  ])('leaves nested, quoted, and indented code outside the callback', (text) => {
    const renderCodeBlock = vi.fn<MarkdownCodeBlockRenderer>((_block, fallback) => fallback)
    const view = render(<MarkdownText text={text} labels={labels} renderCodeBlock={renderCodeBlock} />)
    expect(renderCodeBlock).not.toHaveBeenCalled()
    expect(view.container.querySelector('pre')).not.toBeNull()
  })

  it('keeps an extension child mounted across closure, freezing, and settlement', () => {
    let mounts = 0
    function Child({ block }: { block: MarkdownCodeBlock }): ReactNode {
      useEffect(() => { mounts += 1 }, [])
      return <span data-extension="true">{String(block.closed)}:{String(block.streaming)}</span>
    }
    const renderCodeBlock: MarkdownCodeBlockRenderer = block => <Child block={block} />
    const opened = 'Before.\n\n```html preview runtime=dsh-v1\nhello\n'
    const closed = `${opened}\`\`\``
    const appended = `${closed}\n\nAfter.\n\nMore.\n\nLast.`
    const view = render(<MarkdownText text={opened} streaming labels={labels} renderCodeBlock={renderCodeBlock} />)
    const child = view.container.querySelector('[data-extension]')
    expect(child?.textContent).toBe('false:true')
    for (const text of [closed, appended]) {
      view.rerender(<MarkdownText text={text} streaming labels={labels} renderCodeBlock={renderCodeBlock} />)
      expect(view.container.querySelector('[data-extension]')).toBe(child)
      expect(child?.textContent).toBe('true:true')
    }
    view.rerender(<MarkdownText text={appended} labels={labels} renderCodeBlock={renderCodeBlock} />)
    expect(child?.textContent).toBe('true:false')
    expect(mounts).toBe(1)
  })
})
