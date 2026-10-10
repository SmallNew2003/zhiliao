// @vitest-environment jsdom
/** Real selector, locale, and registration lifetimes through the Client slot runtime. */
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, waitFor, fireEvent } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { Config } from '../src/config.ts'
import type { MarkdownCodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'

let runtime: SlotTestRuntime | undefined
afterEach(async () => { await runtime?.dispose(); runtime = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks() })

const theme = { preference: 'light' as const, active: { id: 'light', colorScheme: 'light' as const, tokens: {} }, themes: [], fontSize: 14, revision: 0 }
const source: MarkdownCodeBlock = { code: '<b>Hello</b>', language: 'html', meta: undefined, closed: true, streaming: false, sourceOffset: 0 }

it('declines ordinary code, owns invalid marked metadata, and removes the provider and locale on disposal', async () => {
  const rt = await SlotTestRuntime.create(); runtime = rt
  const locale = new LocaleRuntime(rt.ctx)
  rt.ctx.provide('locale', locale); rt.slots.installLocale(locale)
  rt.ctx.provide('theme', { getTheme: () => theme } as unknown as typeof rt.ctx.theme)
  vi.stubGlobal('__DSH_VISUALIZATION_CONFIG__', Config({}))
  await rt.sessions.add({ id: 'preview-session' })
  const session = rt.sessions.retainFor(rt.ctx, 'preview-session' as SessionId)
  let setCurrent: (block: MarkdownCodeBlock) => void = () => {}
  function Frame(props: PropsRenderSlots<'conversation.chat.codeBlock'>) {
    const [current, set] = useState(source)
    setCurrent = set
    return props.renderSlotChain('conversation.chat.codeBlock', { block: current }, { fallback: <pre>{current.code}</pre> })
  }
  await rt.root.declare({ 'conversation.chat.codeBlock': { kind: 'chain', scope: 'session' } }, props => <props.SessionProvider session={session}><Frame {...props} /></props.SessionProvider>)
  const feature = await rt.mount({ apply, inject })
  const view = rt.renderRoot()
  expect(view.container.querySelector('[data-visualization]')).toBeNull()
  expect(view.container.querySelector('pre')?.textContent).toBe('<b>Hello</b>')
  await act(async () => { setCurrent({ ...source, meta: 'preview runtime=unavailable' }); locale.setLocale('en') })
  await waitFor(() => { expect(view.getByRole('alert').textContent).toContain('runtime is unavailable') })
  const create = vi.fn(() => 'blob:source'), revoke = vi.fn()
  const OriginalURL = URL
  vi.stubGlobal('URL', class extends OriginalURL { static override createObjectURL = create; static override revokeObjectURL = revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  fireEvent.click(view.getByRole('button', { name: 'Download source' }))
  expect(click).toHaveBeenCalledOnce()
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toMatch(/\.html$/u)
  await waitFor(() => { expect(revoke).toHaveBeenCalledWith('blob:source') })
  await act(async () => { setCurrent({ ...source, meta: 'preview runtime=dsh-v1' }) })
  await waitFor(() => { expect(view.container.querySelector('iframe')).not.toBeNull() })
  fireEvent.click(view.getByRole('button', { name: 'Reload' }))
  await act(async () => { rt.ctx.emit('theme/change', { ...theme, active: { ...theme.active, colorScheme: 'dark' } }) })
  await feature.dispose()
  expect(rt.slots.entries('conversation.chat.codeBlock')).toEqual([])
  expect(view.container.querySelector('[data-visualization]')).toBeNull()
  expect(locale.bind('visualizations')('preview')).toBe('preview')
})

it('fails visibly when the Client mounts without Host-resolved limits', async () => {
  const rt = await SlotTestRuntime.create(); runtime = rt
  expect(() => { apply(rt.ctx) }).toThrow('Host configuration is missing')
})
