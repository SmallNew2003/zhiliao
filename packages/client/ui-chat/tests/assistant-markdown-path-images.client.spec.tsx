// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantMarkdown, localPathMediaUrl } from '../src/client/chat/AssistantMarkdown.tsx'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../src/client/contract/slots.ts'
import type { AssistantBlock } from '../src/client/contract/snapshot.ts'

afterEach(cleanup)

const t = ((_key: string) => 'label') as unknown as ChatViewSlotProps['t']
const renderMessageImages = (() => null) as unknown as ChatNodeOwnerProps['renderMessageImages']

function textBlock(text: string): AssistantBlock {
  return { kind: 'text', text }
}

const ORIGIN = 'http://127.0.0.1:3080'

describe('localPathMediaUrl', () => {
  it('maps an absolute POSIX path on an HTTP page to the file API', () => {
    expect(localPathMediaUrl('http:', ORIGIN, '/tmp/graph.png'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/tmp/graph.png')}`)
    expect(localPathMediaUrl('https:', 'https://127.0.0.1:3080', '/tmp/graph.png'))
      .toBe(`https://127.0.0.1:3080/api/file?path=${encodeURIComponent('/tmp/graph.png')}`)
  })

  it('keeps non-HTTP transports inert', () => {
    expect(localPathMediaUrl('file:', 'file:///app', '/tmp/graph.png')).toBeUndefined()
    expect(localPathMediaUrl('ws:', ORIGIN, '/tmp/graph.png')).toBeUndefined()
  })

  it('keeps destinations that cannot be Host-served local files inert', () => {
    expect(localPathMediaUrl('http:', ORIGIN, '')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, '//cdn.example.com/x.png')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, 'relative.png')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, 'C:\\tmp\\x.png')).toBeUndefined()
  })

  it('encodes the full path including spaces', () => {
    expect(localPathMediaUrl('http:', ORIGIN, '/tmp/my graph.png'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/tmp/my graph.png')}`)
  })

  it('resolves workspace-relative paths when cwd is provided', () => {
    expect(localPathMediaUrl('http:', ORIGIN, 'graph.png', '/workspace'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/workspace/graph.png')}`)
    expect(localPathMediaUrl('http:', ORIGIN, './images/graph.png', '/workspace'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/workspace/images/graph.png')}`)
    expect(localPathMediaUrl('http:', ORIGIN, 'nested/graph.png', '/workspace/'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/workspace/nested/graph.png')}`)
    expect(localPathMediaUrl('http:', ORIGIN, '图表/架构图.png', '/workspace'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/workspace/图表/架构图.png')}`)
    expect(localPathMediaUrl('http:', ORIGIN, 'charts/my graph.png', '/workspace'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/workspace/charts/my graph.png')}`)
    expect(localPathMediaUrl('http:', ORIGIN, 'charts/graph.png?v=1', '/workspace'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/workspace/charts/graph.png?v=1')}`)
  })
})

describe('AssistantMarkdown local-path images', () => {
  it('renders a local image path in closing prose through the same-origin API', () => {
    const { container } = render(
      <AssistantMarkdown
        blocks={[textBlock('See ![diagram](/tmp/graph.png) for the layout.')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    const image = container.querySelector('img')
    expect(image?.getAttribute('alt')).toBe('diagram')
    const url = new URL(image?.getAttribute('src') ?? '')
    expect(url.pathname).toBe('/api/file')
    expect(url.searchParams.get('path')).toBe('/tmp/graph.png')
  })

  it('renders a workspace-relative image path when cwd is provided', () => {
    const { container } = render(
      <AssistantMarkdown
        blocks={[textBlock('See ![diagram](charts/graph.png) for the layout.')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        cwd="/workspace"
        t={t}
      />,
    )
    const image = container.querySelector('img')
    expect(image?.getAttribute('alt')).toBe('diagram')
    const url = new URL(image?.getAttribute('src') ?? '')
    expect(url.pathname).toBe('/api/file')
    expect(url.searchParams.get('path')).toBe('/workspace/charts/graph.png')
  })

  it('renders a workspace-relative image path with Chinese characters', () => {
    const { container } = render(
      <AssistantMarkdown
        blocks={[textBlock('See ![架构图](图表/架构图.png) for details.')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        cwd="/workspace"
        t={t}
      />,
    )
    const image = container.querySelector('img')
    expect(image?.getAttribute('alt')).toBe('架构图')
    const url = new URL(image?.getAttribute('src') ?? '')
    expect(url.pathname).toBe('/api/file')
    expect(url.searchParams.get('path')).toBe('/workspace/图表/架构图.png')
  })

  it('renders a workspace-relative image path with spaces when enclosed in angle brackets', () => {
    const { container } = render(
      <AssistantMarkdown
        blocks={[textBlock('See ![架构图](<图表/我的 架构图.png>) for details.')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        cwd="/workspace"
        t={t}
      />,
    )
    const image = container.querySelector('img')
    expect(image?.getAttribute('alt')).toBe('架构图')
    const url = new URL(image?.getAttribute('src') ?? '')
    expect(url.pathname).toBe('/api/file')
    expect(url.searchParams.get('path')).toBe('/workspace/图表/我的 架构图.png')
  })

  it('keeps non-absolute destinations inert when cwd is absent or empty', () => {
    const { container: absentCwd } = render(
      <AssistantMarkdown
        blocks={[textBlock('See ![diagram](relative.png).')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    expect(absentCwd.querySelector('img')).toBeNull()
    expect(absentCwd.textContent).toContain('diagram')

    const { container: emptyCwd } = render(
      <AssistantMarkdown
        blocks={[textBlock('See ![diagram](relative.png).')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        cwd=""
        t={t}
      />,
    )
    expect(emptyCwd.querySelector('img')).toBeNull()
    expect(emptyCwd.textContent).toContain('diagram')
  })

  it('keeps URI scheme destinations inert even when cwd is provided', () => {
    expect(localPathMediaUrl('http:', 'http://localhost:3000', 'javascript:alert(1)', '/workspace')).toBeUndefined()
    expect(localPathMediaUrl('http:', 'http://localhost:3000', 'data:image/png;base64,abc', '/workspace')).toBeUndefined()
    expect(localPathMediaUrl('http:', 'http://localhost:3000', 'blob:http://localhost/123', '/workspace')).toBeUndefined()
    expect(localPathMediaUrl('http:', 'http://localhost:3000', 'http://example.com/a.png', '/workspace')).toBeUndefined()

    const { container } = render(
      <AssistantMarkdown
        blocks={[textBlock('See ![payload](javascript:alert(1)).')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        cwd="/workspace"
        t={t}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('payload')
  })
})
