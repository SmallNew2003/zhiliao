// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MessageEditControls } from '../src/client/chat/MessageEditControls.tsx'
import { en, zh } from '../src/client/locale.ts'

afterEach(cleanup)

describe('latest input editing', () => {
  it.each([en, zh])('prefills text, cancels with focus, and closes unchanged without a request', async (dictionary) => {
    const t = makeTranslate(dictionary)
    const editMessage = vi.fn()
    render(<MessageEditControls text="original" targetSeq={4} latest running={false} hasAttachments={false} editMessage={editMessage} t={t} />)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit') })
    fireEvent.click(trigger)
    expect((screen.getByRole<HTMLTextAreaElement>('textbox')).value).toBe('original')
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), { target: { value: 'draft' } })
    fireEvent.keyDown(screen.getByRole<HTMLTextAreaElement>('textbox'), { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit.resend') }))
    await waitFor(() =>{  expect(screen.queryByRole('textbox')).toBeNull() })
    expect(editMessage).not.toHaveBeenCalled()
  })

  it('keeps draft and request identity after a lost reply, and disables submission during cleanup', async () => {
    const t = makeTranslate(en)
    const editMessage = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, value: { accepted: true } })
    const props = { text: 'original', targetSeq: 4, latest: true, running: false, hasAttachments: true, editMessage, t }
    const view = render(<MessageEditControls {...props} />)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit') }))
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit.resend') }))
    await screen.findByRole('alert')
    expect((screen.getByRole<HTMLTextAreaElement>('textbox')).value).toBe('')
    view.rerender(<MessageEditControls {...props} running />)
    expect((screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit.resend') })).disabled).toBe(true)
    view.rerender(<MessageEditControls {...props} />)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit.resend') }))
    await waitFor(() =>{  expect(screen.queryByRole('textbox')).toBeNull() })
    expect(editMessage.mock.calls[1]).toEqual(editMessage.mock.calls[0])
  })

  it('retries the accepted request even after its target is superseded', async () => {
    const t = makeTranslate(en)
    const editMessage = vi.fn().mockRejectedValueOnce(new Error('lost reply')).mockResolvedValue({ ok: true, value: { accepted: true } })
    const props = { text: 'original', targetSeq: 4, latest: true, running: false, hasAttachments: false, editMessage, t }
    const view = render(<MessageEditControls {...props} />)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit') }))
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit.resend') }))
    await screen.findByRole('alert')
    view.rerender(<MessageEditControls {...props} text="changed" latest={false} />)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit.resend') }))
    await waitFor(() =>{  expect(screen.queryByRole('textbox')).toBeNull() })
    expect(editMessage.mock.calls[1]).toEqual(editMessage.mock.calls[0])
  })

  it.each([
    ['session/edit-stale', 'message.edit.stale'],
    ['session/agent-busy', 'message.edit.busy'],
    ['session/attachment-invalid', 'message.edit.attachmentError'],
    ['gateway/bad-request', 'message.edit.failed'],
  ] as const)('preserves text and localizes %s', async (code, key) => {
    const t = makeTranslate(en)
    const editMessage = vi.fn().mockResolvedValue({ ok: false, error: { code, message: 'wire detail' } })
    render(<MessageEditControls text="original" targetSeq={4} latest running={false} hasAttachments={false} editMessage={editMessage} t={t} />)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit') }))
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), { target: { value: 'draft' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit.resend') }))
    expect((await screen.findByRole('alert')).textContent).toBe(t(key))
    expect((screen.getByRole<HTMLTextAreaElement>('textbox')).value).toBe('draft')
  })

  it('rejects blank text without attachments and supports keyboard resend with one pending request', async () => {
    const t = makeTranslate(en)
    const accepted = Promise.withResolvers<{ ok: true; value: { accepted: true } }>()
    const editMessage = vi.fn().mockReturnValue(accepted.promise)
    render(<MessageEditControls text="original" targetSeq={4} latest running={false} hasAttachments={false} editMessage={editMessage} t={t} />)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit') })
    fireEvent.click(trigger)
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), { target: { value: '  ' } })
    fireEvent.keyDown(screen.getByRole<HTMLTextAreaElement>('textbox'), { key: 'Enter', ctrlKey: true })
    expect(screen.getByRole('alert').textContent).toBe(t('message.edit.empty'))
    expect(editMessage).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), { target: { value: 'changed' } })
    fireEvent.keyDown(screen.getByRole<HTMLTextAreaElement>('textbox'), { key: 'Enter', metaKey: true })
    fireEvent.keyDown(screen.getByRole<HTMLTextAreaElement>('textbox'), { key: 'Enter', ctrlKey: true })
    expect(editMessage).toHaveBeenCalledTimes(1)
    accepted.resolve({ ok: true, value: { accepted: true } })
    await waitFor(() => { expect(screen.queryByRole('textbox')).toBeNull() })
    expect(document.activeElement).toBe(trigger)
  })

  it('hides earlier edit actions and explains active-run restrictions', () => {
    const t = makeTranslate(en)
    const props = { text: 'old', targetSeq: 4, latest: false, running: false, hasAttachments: false, editMessage: vi.fn(), t }
    const view = render(<MessageEditControls {...props} />)
    expect(screen.queryByRole('button')).toBeNull()
    view.rerender(<MessageEditControls {...props} latest running />)
    const action = screen.getByRole<HTMLButtonElement>('button', { name: t('message.edit') })
    expect(action.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(action)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(t('message.edit.busy'))).toBeTruthy()
  })
})
