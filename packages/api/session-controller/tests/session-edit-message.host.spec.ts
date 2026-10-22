/** Latest-input edit admission through the production AgentLoop and Session Controller. */

import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmResolvedModelInfo, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createSessionTestController } from './test-remote.ts'
import type { SessionRequestId } from '../src/types.ts'

const image: ImageAttachmentRef = {
  attachmentId: AttachmentId('edit-image'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
}
const file: FileAttachmentRef = { attachmentId: AttachmentId('edit-file'), name: 'input.txt', bytes: 1 }
const input = (text: string): UserMessage => createUserMessage({
  content: [{ type: 'text', text }], source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
})

async function harness(adapter = new MockAdapter(Array.from({ length: 12 }, () => textResponse('reply')))) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' } })
  const loop = await mountAgentLoopTestHarness(ctx)
  const adapterRegistration = ctx.llm.registerAdapter(['mock'], adapter)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  const readImage = vi.fn((ref: ImageAttachmentRef) => Promise.resolve({ ref, data: Uint8Array.of(1) }))
  const readFileStream = vi.fn(async function* (_ref: FileAttachmentRef) { yield Uint8Array.of(2) })
  ctx.provide('attachments', { readImage, readFileStream } as never)
  const handle = await ctx.agents.create({
    sessionId: SessionId('edit-session'), agentOptions: { provider: 'mock', model: 'mock' },
  })
  const agent = handle.agent
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: '/tmp',
  })
  const events = async (): Promise<readonly SessionEvent[]> => {
    using observed = await ctx.sessionQuery.observeSession(agent.id, { projectionMode: 'none' })
    return observed.events
  }
  const latest = async (): Promise<SessionSeq> => {
    const event = (await events()).findLast(event => event.type === 'user/message' || event.type === 'user/message-edit')
    if (event === undefined) throw new Error('missing sent input')
    return event.seq
  }
  const send = async (message: UserMessage) => { agent.followup(message); await agent.whenIdle() }
  const edit = (targetSeq: SessionSeq, text: string, requestId = 'edit-request') => controller.editMessage({
    sessionId: agent.id, targetSeq, text, requestId: requestId as SessionRequestId,
  })
  return { ctx, loop, adapter, adapterRegistration, agent, handle, controller, readImage, readFileStream, events, latest, send, edit }
}

describe('Session latest-message editing', () => {
  it('returns the durable acceptance when an overlapping retry starts from an older history observation', async () => {
    const h = await harness()
    const release = Promise.withResolvers<undefined>()
    let retry: Promise<{ accepted: true }> | undefined
    try {
      await h.send(input('A'))
      const target = await h.latest()
      const observed = Promise.withResolvers<undefined>()
      const observeSession = h.ctx.sessionQuery.observeSession.bind(h.ctx.sessionQuery)
      vi.spyOn(h.ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (...args) => {
        const snapshot = await observeSession(...args)
        observed.resolve(undefined)
        await release.promise
        return snapshot
      })
      retry = h.edit(target, 'A2')
      await Promise.race([observed.promise, retry.then(() => { throw new Error('retry returned before its observation released') })])
      await h.edit(target, 'A2')
      await h.agent.whenIdle()
      release.resolve(undefined)
      expect(await retry).toEqual({ accepted: true })
      expect((await h.events()).filter(event => event.type === 'user/message-edit')).toHaveLength(1)
      expect(h.adapter.requests).toHaveLength(2)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([retry])
      await h.ctx.fiber.dispose()
    }
  })

  it('rejects disposal after the eligibility observation before reserving an edit', async () => {
    const h = await harness()
    const release = Promise.withResolvers<undefined>()
    let pending: Promise<{ accepted: true }> | undefined
    try {
      await h.send(input('A'))
      const target = await h.latest()
      const observed = Promise.withResolvers<undefined>()
      const observeSession = h.ctx.sessionQuery.observeSession.bind(h.ctx.sessionQuery)
      let observations = 0
      vi.spyOn(h.ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
        const snapshot = await observeSession(...args)
        if (++observations === 2) {
          observed.resolve(undefined)
          await release.promise
        }
        return snapshot
      })
      pending = h.edit(target, 'A2')
      const settled = pending.then(value => ({ value }), (error: unknown) => ({ error }))
      await Promise.race([observed.promise, pending.then(() => { throw new Error('edit returned before its observation released') })])
      await h.handle.dispose()
      release.resolve(undefined)
      expect(await settled).toMatchObject({ error: { code: 'session/not-found' } })
      expect(h.adapter.requests).toHaveLength(1)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([pending])
      await h.ctx.fiber.dispose()
    }
  })

  it('rejects a chat with no sent user input', async () => {
    const h = await harness()
    try {
      await expect(h.edit(SessionSeq(0), 'new text')).rejects.toMatchObject({ code: 'session/edit-stale' })
      expect(h.adapter.requests).toHaveLength(0)
      expect((await h.events()).some(event => event.type === 'user/message-edit')).toBe(false)
    } finally { await h.ctx.fiber.dispose() }
  })

  it.each([
    { error: new SessionQueryError('session was removed', 'SESSION_QUERY_SESSION_NOT_FOUND'), code: 'session/not-found' },
    { error: new SessionQueryError('storage is unavailable', 'SESSION_QUERY_PERSISTENCE_FAILED'), code: 'gateway/internal' },
    { error: new Error('storage is offline'), code: 'gateway/internal' },
  ])('rejects unavailable edit history with $code before accepting input', async ({ error, code }) => {
    const h = await harness()
    try {
      await h.send(input('A'))
      const target = await h.latest()
      vi.spyOn(h.ctx.sessionQuery, 'observeSession').mockRejectedValue(error)
      await expect(h.edit(target, 'A2')).rejects.toMatchObject({ code })
      expect(h.adapter.requests).toHaveLength(1)
      expect(h.agent.session.deriveMessages().find(message => message.role === 'user')?.content[0])
        .toEqual({ type: 'text', text: 'A' })
    } finally { await h.ctx.fiber.dispose() }
  })

  it('rejects edits after the selected provider unregisters', async () => {
    const h = await harness()
    try {
      await h.send(input('A'))
      h.adapterRegistration.replace([])
      await expect(h.edit(await h.latest(), 'A2')).rejects.toMatchObject({ code: 'session/model-unavailable' })
      expect((await h.events()).some(event => event.type === 'user/message-edit')).toBe(false)
      expect(h.adapter.requests).toHaveLength(1)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('adds text to original attachment-only input without moving attachments', async () => {
    const h = await harness()
    try {
      await h.send(createUserMessage({ content: [{ type: 'image', attachment: image }], source: { kind: 'user' } }))
      await h.edit(await h.latest(), 'new text')
      await h.agent.whenIdle()
      expect(h.agent.session.deriveMessages().find(message => message.role === 'user')?.content)
        .toEqual([{ type: 'text', text: 'new text' }, { type: 'image', attachment: image }])
    } finally { await h.ctx.fiber.dispose() }
  })

  it.each([
    { provider: 'mock', model: 'other' },
    { provider: 'other-provider', model: 'mock' },
  ])('rejects a switch to $provider/$model while image metadata is resolving', async (selection) => {
    const h = await harness()
    const metadata = Promise.withResolvers<LlmResolvedModelInfo>()
    let pending: Promise<{ accepted: true }> | undefined
    try {
      h.ctx.llm.registerAdapter(['other-provider'], new MockAdapter([textResponse('other reply')]))
      await h.send(createUserMessage({ content: [{ type: 'text', text: 'A' }, { type: 'image', attachment: image }], source: { kind: 'user' } }))
      const resolving = Promise.withResolvers<undefined>()
      vi.spyOn(h.ctx.llm, 'resolveModelInfo').mockImplementationOnce(() => {
        resolving.resolve(undefined)
        return metadata.promise
      })
      pending = h.edit(await h.latest(), 'A2')
      const settled = pending.then(value => ({ value }), (error: unknown) => ({ error }))
      await Promise.race([resolving.promise, pending.then(() => { throw new Error('edit returned before its metadata resolved') })])
      await h.controller.selectModel({ sessionId: h.agent.id, ...selection })
      metadata.resolve({ provider: 'mock', id: 'mock', name: 'mock', inputModalities: ['text', 'image'] })
      expect(await settled).toMatchObject({ error: { code: 'session/agent-busy', details: { reason: 'model-selection-changed' } } })
      expect((await h.events()).some(event => event.type === 'user/message-edit')).toBe(false)
      expect(h.adapter.requests).toHaveLength(1)
    } finally {
      metadata.resolve({ provider: 'mock', id: 'mock', name: 'mock', inputModalities: ['text', 'image'] })
      await Promise.allSettled([pending])
      await h.ctx.fiber.dispose()
    }
  })

  it('resends only the preceding history and edited input, then supports editing that replacement', async () => {
    const h = await harness()
    try {
      await h.send(input('A'))
      await h.send(input('B'))
      const target = await h.latest()
      expect(await h.edit(target, 'B2')).toEqual({ accepted: true })
      await h.agent.whenIdle()
      expect(h.adapter.requests.at(-1)?.messages.filter(message => message.role !== 'system').map(message => [message.role, message.content])).toEqual([
        ['user', [{ type: 'text', text: 'A' }]],
        ['assistant', [{ type: 'text', text: 'reply' }]],
        ['user', [{ type: 'text', text: 'B2' }]],
      ])
      const edits = (await h.events()).filter(event => event.type === 'user/message-edit')
      expect(edits).toHaveLength(1)
      expect(edits[0]?.data).toMatchObject({ targetSeq: target, message: { source: {
        kind: 'user', rpcId: 'edit-request', clientTimeZone: 'Asia/Shanghai',
      } } })
      expect((await h.events()).filter(event => event.type === 'user/message')).toHaveLength(2)
      await h.edit(await h.latest(), 'B3', 'second-edit')
      await h.agent.whenIdle()
      expect(h.agent.session.deriveMessages().filter(message => message.role === 'user').map(message => message.content))
        .toEqual([[{ type: 'text', text: 'A' }], [{ type: 'text', text: 'B3' }]])
    } finally { await h.ctx.fiber.dispose() }
  })

  it('preserves ordered image and file references without uploads, including attachment-only edits', async () => {
    const h = await harness()
    try {
      const original = createUserMessage({ content: [
        { type: 'image', attachment: image }, { type: 'text', text: 'B' },
        { type: 'file', attachment: file }, { type: 'text', text: 'tail' },
      ], source: { kind: 'user' } })
      await h.send(original)
      const fileInput = h.adapter.requests[0]?.messages.find(message => message.role === 'user')?.content[2]
      await h.edit(await h.latest(), 'edited')
      await h.agent.whenIdle()
      expect(h.agent.session.deriveMessages().find(message => message.role === 'user')?.content).toEqual([
        original.content[0], { type: 'text', text: 'edited' }, original.content[2],
      ])
      expect(h.adapter.requests.at(-1)?.messages.find(message => message.role === 'user')?.content).toEqual([
        original.content[0], { type: 'text', text: 'edited' }, fileInput,
      ])
      expect(h.readImage).toHaveBeenCalledWith(image, expect.any(AbortSignal))
      expect(h.readFileStream).toHaveBeenCalledWith(file, expect.any(AbortSignal))
      await h.edit(await h.latest(), '', 'attachment-only')
      await h.agent.whenIdle()
      expect(h.adapter.requests.at(-1)?.messages.find(message => message.role === 'user')?.content).toEqual([original.content[0], fileInput])
    } finally { await h.ctx.fiber.dispose() }
  })

  it('rejects empty input and leaves unchanged text without another model request', async () => {
    const h = await harness()
    try {
      await h.send(input('A'))
      const target = await h.latest()
      await expect(h.edit(target, ' \n')).rejects.toMatchObject({ code: 'gateway/bad-request' })
      expect(await h.edit(target, 'A')).toEqual({ accepted: true })
      expect(h.adapter.requests).toHaveLength(1)
      expect((await h.events()).some(event => event.type === 'user/message-edit')).toBe(false)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('returns the durable acceptance on retry before rejecting stale targets or active runs', async () => {
    const h = await harness()
    const release = Promise.withResolvers<undefined>()
    try {
      await h.send(input('A'))
      const target = await h.latest()
      const preparing = Promise.withResolvers<undefined>()
      h.ctx.on('agent/request', async (_payload, next) => { preparing.resolve(undefined); await release.promise; return next() })
      await h.edit(target, 'A2')
      await preparing.promise
      expect(await h.edit(target, 'A2')).toEqual({ accepted: true })
      await expect(h.edit(target, 'other', 'another')).rejects.toMatchObject({ code: 'session/agent-busy' })
      release.resolve(undefined)
      await h.agent.whenIdle()
      await expect(h.edit(target, 'other', 'another')).rejects.toMatchObject({ code: 'session/edit-stale' })
      expect((await h.events()).filter(event => event.type === 'user/message-edit')).toHaveLength(1)
      expect(h.adapter.requests).toHaveLength(2)
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it('rejects older targets and pending inbox input without creating a response', async () => {
    const h = await harness()
    try {
      await h.send(input('A'))
      const old = await h.latest()
      await h.send(input('B'))
      await expect(h.edit(old, 'A2')).rejects.toMatchObject({ code: 'session/edit-stale' })
      h.agent.inbox.append('next-turn', input('pending'))
      await expect(h.edit(await h.latest(), 'B2')).rejects.toMatchObject({ code: 'session/agent-busy' })
      expect(h.adapter.requests).toHaveLength(2)
      expect((await h.events()).some(event => event.type === 'user/message-edit')).toBe(false)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('keeps edited input effective when request preparation fails after acceptance', async () => {
    const h = await harness()
    try {
      await h.send(input('A'))
      h.ctx.on('agent/request', async () => { throw new Error('prepare failed') })
      expect(await h.edit(await h.latest(), 'A2')).toEqual({ accepted: true })
      await h.agent.whenIdle()
      expect(h.agent.session.deriveMessages().filter(message => message.role !== 'system').map(message => message.content)).toEqual([[{ type: 'text', text: 'A2' }]])
      expect(h.adapter.requests).toHaveLength(1)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('delegates pre-step decisions and logs newly contributed input once beside a committed edit', async () => {
    const h = await harness()
    try {
      await h.send(input('A'))
      const extra = input('additional context')
      h.ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next()
        return decision.kind === 'reject' ? decision : {
          ...decision, messages: [...decision.messages, extra], startsRequestSeries: true,
        }
      })
      await h.edit(await h.latest(), 'A2')
      await h.agent.whenIdle()
      expect(h.adapter.requests.at(-1)?.messages.filter(message => message.role === 'user').map(message => message.content))
        .toEqual([[{ type: 'text', text: 'A2' }], [{ type: 'text', text: 'additional context' }]])
      expect((await h.events()).filter(event => event.type === 'user/message').map(event => event.data.id))
        .toHaveLength(2)
      expect((await h.events()).filter(event => event.type === 'user/message-edit')).toHaveLength(1)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('records same-identity pre-step text expansion without duplicating the edited input', async () => {
    const h = await harness()
    try {
      await h.send(input('A'))
      h.ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next()
        return decision.kind === 'reject' ? decision : { ...decision, messages: decision.messages.map(message => ({ ...message, content: message.content.map(block => block.type === 'text' ? { ...block, text: `prepared ${block.text}` } : block) })) }
      })
      await h.edit(await h.latest(), 'A2')
      await h.agent.whenIdle()
      expect(h.adapter.requests.at(-1)?.messages.filter(message => message.role === 'user').map(message => message.content))
        .toEqual([[{ type: 'text', text: 'prepared A2' }]])
      expect((await h.events()).filter(event => event.type === 'user/message-admit')).toHaveLength(1)
      expect((await h.events()).filter(event => event.type === 'user/message')).toHaveLength(1)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('retains accepted edited input when another pre-step listener rejects the response', async () => {
    const h = await harness()
    try {
      await h.send(input('A'))
      h.ctx.on('agent/pre-step', async (_payload, next) => { await next(); return { kind: 'reject' } })
      await h.edit(await h.latest(), 'A2')
      await h.agent.whenIdle()
      expect(h.adapter.requests).toHaveLength(1)
      expect(h.agent.session.deriveMessages().filter(message => message.role === 'user').map(message => message.content))
        .toEqual([[{ type: 'text', text: 'A2' }]])
    } finally { await h.ctx.fiber.dispose() }
  })

  it('reserves idle while attachment reads await and rejects a concurrent edit', async () => {
    const h = await harness()
    const release = Promise.withResolvers<undefined>()
    try {
      await h.send(createUserMessage({ content: [{ type: 'text', text: 'A' }, { type: 'image', attachment: image }], source: { kind: 'user' } }))
      const target = await h.latest()
      const reading = Promise.withResolvers<undefined>()
      h.readImage.mockImplementation(async (ref) => {
        reading.resolve(undefined)
        await release.promise
        return { ref, data: Uint8Array.of(1) }
      })
      const first = h.edit(target, 'A2')
      await Promise.race([reading.promise, first.then(() => { throw new Error('edit accepted before blocked attachment read') })])
      await expect(h.edit(target, 'A3', 'concurrent')).rejects.toMatchObject({ code: 'session/agent-busy' })
      release.resolve(undefined)
      await first
      await h.agent.whenIdle()
      expect((await h.events()).filter(event => event.type === 'user/message-edit')).toHaveLength(1)
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it('rejects retained images when selection changes to a text-only model during attachment reads', async () => {
    const h = await harness()
    const release = Promise.withResolvers<undefined>()
    try {
      h.ctx.llm.registerAdapter(['text-only'], new MockAdapter([textResponse('wrong model')]))
      vi.spyOn(h.ctx.llm, 'resolveModelInfo').mockImplementation((provider, model) => Promise.resolve({
        provider, id: model, name: model, inputModalities: provider === 'text-only' ? ['text'] : ['text', 'image'],
      }))
      await h.send(createUserMessage({ content: [{ type: 'text', text: 'A' }, { type: 'image', attachment: image }], source: { kind: 'user' } }))
      const reading = Promise.withResolvers<undefined>()
      h.readImage.mockImplementation(async (ref) => {
        reading.resolve(undefined)
        await release.promise
        return { ref, data: Uint8Array.of(1) }
      })
      const pending = h.edit(await h.latest(), 'A2')
      await Promise.race([reading.promise, pending.then(() => { throw new Error('edit accepted before blocked read') })])
      await h.controller.selectModel({ sessionId: h.agent.id, provider: 'text-only', model: 'plain' })
      release.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ code: 'session/attachment-invalid' })
      expect((await h.events()).some(event => event.type === 'user/message-edit')).toBe(false)
      expect(h.adapter.requests).toHaveLength(1)
      expect(h.agent.session.deriveMessages().filter(message => message.role === 'user').flatMap(message =>
        message.content.flatMap(block => block.type === 'text' ? [block.text] : []))).toEqual(['A'])
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it.each([
    { provider: 'text-only', model: 'plain' },
    { provider: 'mock', model: 'other' },
  ])('rejects a switch to $provider/$model between final metadata validation and the edit commit', async (selection) => {
    const h = await harness()
    const metadata = Promise.withResolvers<LlmResolvedModelInfo>()
    const selectedConfig = Promise.withResolvers<LlmCallConfig>()
    const finalMetadataReached = Promise.withResolvers<undefined>()
    const selectionReached = Promise.withResolvers<undefined>()
    let pending: Promise<{ accepted: true }> | undefined
    let selecting: Promise<unknown> | undefined
    try {
      h.ctx.llm.registerAdapter(['text-only'], new MockAdapter([textResponse('wrong model')]))
      await h.send(createUserMessage({
        content: [{ type: 'text', text: 'A' }, { type: 'image', attachment: image }], source: { kind: 'user' },
      }))
      let metadataCalls = 0
      vi.spyOn(h.ctx.llm, 'resolveModelInfo').mockImplementation((provider, model) => {
        metadataCalls++
        if (metadataCalls === 2) {
          finalMetadataReached.resolve(undefined)
          return metadata.promise
        }
        return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
      })
      vi.spyOn(h.ctx.llm, 'resolveCallConfig').mockImplementation(() => {
        selectionReached.resolve(undefined)
        return selectedConfig.promise
      })
      const providers = h.ctx.llm.listProviders()
      vi.spyOn(h.ctx.llm, 'listProviders').mockImplementation(() => {
        // Settling the blocked selection queues its continuation before the edit caller resumes.
        if (metadataCalls === 2) selectedConfig.resolve(selection)
        return providers
      })
      pending = h.edit(await h.latest(), 'A2')
      const settled = pending.then(value => ({ value }), (error: unknown) => ({ error }))
      await Promise.race([finalMetadataReached.promise, pending.then(() => {
        throw new Error('edit accepted before final metadata validation')
      })])
      selecting = h.controller.selectModel({ sessionId: h.agent.id, ...selection })
      await Promise.race([selectionReached.promise, selecting.then(() => {
        throw new Error('selection completed before its blocked configuration resolved')
      })])
      metadata.resolve({ provider: 'mock', id: 'mock', name: 'mock', inputModalities: ['text', 'image'] })
      expect(await settled).toMatchObject({ error: { code: 'session/agent-busy', details: { reason: 'model-selection-changed' } } })
      await selecting
      expect(metadataCalls).toBe(2)
      expect((await h.events()).some(event => event.type === 'user/message-edit')).toBe(false)
      expect(h.adapter.requests).toHaveLength(1)
      expect(h.agent.session.deriveMessages().find(message => message.role === 'user')?.content[0])
        .toEqual({ type: 'text', text: 'A' })
    } finally {
      metadata.resolve({ provider: 'mock', id: 'mock', name: 'mock', inputModalities: ['text', 'image'] })
      selectedConfig.resolve(selection)
      await Promise.allSettled([pending, selecting])
      await h.ctx.fiber.dispose()
    }
  })

  it('rejects new pending input after attachment reads without replacing original history', async () => {
    const h = await harness()
    const release = Promise.withResolvers<undefined>()
    try {
      await h.send(createUserMessage({ content: [{ type: 'text', text: 'A' }, { type: 'image', attachment: image }], source: { kind: 'user' } }))
      const reading = Promise.withResolvers<undefined>()
      h.readImage.mockImplementation(async (ref) => {
        reading.resolve(undefined)
        await release.promise
        return { ref, data: Uint8Array.of(1) }
      })
      const pending = h.edit(await h.latest(), 'A2')
      await Promise.race([reading.promise, pending.then(() => { throw new Error('edit accepted before blocked attachment read') })])
      h.agent.followup(input('B'))
      release.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ code: 'session/agent-busy' })
      await h.agent.whenIdle()
      expect((await h.events()).some(event => event.type === 'user/message-edit')).toBe(false)
      expect(h.agent.session.deriveMessages().filter(message => message.role === 'user').flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
        .toEqual(['A', 'B'])
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it('rejects unreadable original attachments before committing any edit', async () => {
    const h = await harness()
    try {
      await h.send(createUserMessage({ content: [{ type: 'text', text: 'A' }, { type: 'image', attachment: image }], source: { kind: 'user' } }))
      h.readImage.mockRejectedValue(new AttachmentError('missing original image', 'ATTACHMENT_NOT_FOUND'))
      await expect(h.edit(await h.latest(), 'A2')).rejects.toMatchObject({ code: 'session/attachment-invalid' })
      expect((await h.events()).some(event => event.type === 'user/message-edit')).toBe(false)
      expect(h.adapter.requests).toHaveLength(1)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('rejects original file integrity failures without dropping the file', async () => {
    const h = await harness()
    try {
      await h.send(createUserMessage({ content: [{ type: 'text', text: 'A' }, { type: 'file', attachment: file }], source: { kind: 'user' } }))
      h.readFileStream.mockImplementation(async function* () {
        yield Uint8Array.of(2)
        throw new AttachmentError('file integrity mismatch', 'ATTACHMENT_NOT_FOUND')
      })
      await expect(h.edit(await h.latest(), 'A2')).rejects.toMatchObject({ code: 'session/attachment-invalid' })
      expect(h.agent.session.deriveMessages().find(message => message.role === 'user')?.content)
        .toEqual([{ type: 'text', text: 'A' }, { type: 'file', attachment: file }])
      expect(h.adapter.requests).toHaveLength(1)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('rejects disposal during original attachment admission before the edit commits', async () => {
    const h = await harness()
    const release = Promise.withResolvers<undefined>()
    try {
      await h.send(createUserMessage({ content: [{ type: 'text', text: 'A' }, { type: 'image', attachment: image }], source: { kind: 'user' } }))
      const reading = Promise.withResolvers<undefined>()
      h.readImage.mockImplementation(async (ref) => {
        reading.resolve(undefined)
        await release.promise
        return { ref, data: Uint8Array.of(1) }
      })
      const pending = h.edit(await h.latest(), 'A2')
      const settled = pending.then(value => ({ value }), (error: unknown) => ({ error }))
      await Promise.race([reading.promise, pending.then(() => { throw new Error('edit accepted before blocked attachment read') })])
      const disposing = h.handle.dispose()
      release.resolve(undefined)
      expect(await settled).toMatchObject({ error: { code: 'session/agent-busy' } })
      await disposing
      expect(h.adapter.requests).toHaveLength(1)
      expect(h.agent.session.deriveMessages().find(message => message.role === 'user')?.content[0])
        .toEqual({ type: 'text', text: 'A' })
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  it('edits inherited latest input while preserving the parent', async () => {
    const h = await harness()
    try {
      await h.send(input('A'))
      const target = await h.latest()
      const original = await h.events()
      const child = await h.ctx.agents.create({
        sessionId: SessionId('edit-child'), seed: original, inheritedEventCount: SessionLogOffset(original.length),
        meta: { parentSession: h.agent.id, isSeeded: true }, agentOptions: { provider: 'mock', model: 'mock' },
      })
      await h.controller.editMessage({ sessionId: child.agent.id, targetSeq: target, text: 'child A', requestId: 'child-edit' as SessionRequestId })
      await child.agent.whenIdle()
      expect(child.agent.session.deriveMessages().filter(message => message.role === 'user').map(message => message.content))
        .toEqual([[{ type: 'text', text: 'child A' }]])
      expect(await h.events()).toEqual(original)
    } finally { await h.ctx.fiber.dispose() }
  })
})

it('rejects edits until manually stopped tool cleanup reaches idle', async () => {
  const adapter = new MockAdapter([toolCallResponse('cleanup-call', 'held-cleanup', {}), textResponse('edited answer')])
  const h = await harness(adapter)
  const entered = Promise.withResolvers<undefined>()
  const cleanupEntered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  let toolFinished = false
  try {
    h.ctx.tools.register(defineContentToolFixture({
      name: 'held-cleanup', description: 'Hold owned cleanup after manual stop', parameters: {},
      execute: async (_args, exec) => {
        const signal = exec.signal
        if (signal === undefined) throw new Error('missing execution signal')
        entered.resolve(undefined)
        await new Promise<undefined>((resolve) => {
          if (signal.aborted) resolve(undefined)
          else signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
        })
        cleanupEntered.resolve(undefined)
        await released.promise
        toolFinished = true
        return [{ type: 'text', text: 'cleanup settled' }]
      },
    }))
    h.agent.followup(input('original'))
    await entered.promise
    const target = await h.latest()
    h.controller.cancel({ sessionId: h.agent.id })
    await cleanupEntered.promise
    expect(h.agent.status).toBe('running')
    expect(toolFinished).toBe(false)
    await expect(h.edit(target, 'edited')).rejects.toMatchObject({ code: 'session/agent-busy' })
    expect((await h.events()).filter(event => event.type === 'user/message-edit')).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
    released.resolve(undefined)
    await h.agent.whenIdle()
    expect(toolFinished).toBe(true)
    expect(h.agent.status).toBe('idle')
    expect(await h.edit(target, 'edited')).toEqual({ accepted: true })
    await h.agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(h.agent.session.deriveMessages().filter(message => message.role === 'user').flatMap(message => message.content)).toEqual([{ type: 'text', text: 'edited' }])
  } finally { released.resolve(undefined); await h.ctx.fiber.dispose() }
})
