import { describe, expect, it } from 'vitest'
import { createChatStore, storedTurnProcessEntry } from '../src/client/stores.ts'

describe('createChatStore', () => {
  it('stores only manually expanded Turn-process answers', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, 3, true)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 3 }])

    store.actions.setTurnProcessOpen(2, 4, true)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 4 }])

    store.actions.setTurnProcessOpen(2, 4, false)
    expect(store.store.getSnapshot().turnProcesses).toEqual([])
  })

  it('closes only the requested Turn-process entry', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, 3, true)
    store.actions.setTurnProcessOpen(3, 4, true)

    store.actions.setTurnProcessOpen(2, 3, false)
    store.actions.setTurnProcessOpen(9, 10, false)

    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 3, answerStep: 4 }])
  })
})

describe('process group view state', () => {
  it('stores and clears explicit group expansion choices', () => {
    const store = createChatStore().create()
    store.actions.setProcessGroupOpen('group-a', true)
    expect(store.store.getSnapshot().processGroups).toEqual([{ key: 'group-a', open: true }])

    store.actions.setProcessGroupOpen('group-a', false)
    expect(store.store.getSnapshot().processGroups).toEqual([{ key: 'group-a', open: false }])

    store.actions.setProcessGroupOpen('group-a', undefined)
    store.actions.setProcessGroupOpen('missing', undefined)
    expect(store.store.getSnapshot().processGroups).toEqual([])
  })
})

describe('storedTurnProcessEntry', () => {
  it('returns only the requested Turn answer generation', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, 3, true)
    expect(storedTurnProcessEntry(store.store.getSnapshot(), 2)).toEqual({ turn: 2, answerStep: 3 })
    expect(storedTurnProcessEntry(store.store.getSnapshot(), 9)).toBeUndefined()
  })
})
