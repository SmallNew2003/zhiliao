/** One stable process-group disclosure between visible Assistant responses. */
import {
  memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps,
} from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { processGroupTitle } from './process-group-title.ts'
import { formatRunDuration } from './message-chrome.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './ProcessGroupSeat.module.css'

type SeatProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey' | 'groupPart' | 'groupedTranscript'>

interface ProcessGroupSeatProps extends SeatProps {
  readonly groupKey: string
  readonly useChat: ChatViewSlotProps['useChat']
}

interface ScrollEdges {
  readonly up: boolean
  readonly down: boolean
}

const NO_SCROLL: ScrollEdges = { up: false, down: false }

function sameScroll(left: ScrollEdges, right: ScrollEdges): boolean {
  return left.up === right.up && left.down === right.down
}

function scrollEdges(element: HTMLElement): ScrollEdges {
  return {
    up: element.scrollTop > 1,
    down: element.scrollTop < element.scrollHeight - element.clientHeight - 1,
  }
}

function useElapsed(startTime: number | undefined, running: boolean, t: ChatViewSlotProps['t']): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || startTime === undefined) return
    const update = (): void => { setNow(Date.now()) }
    update()
    const timer = setInterval(update, 1_000)
    return () => { clearInterval(timer) }
  }, [running, startTime])
  return running && startTime !== undefined ? formatRunDuration(now - startTime, t) : ''
}



/** Render one process group and keep its member seats mounted while closed. */
export const ProcessGroupSeat = memo(function ProcessGroupSeat({
  groupKey, useChat, ...seatProps
}: ProcessGroupSeatProps) {
  const group = useChat(snapshot => snapshot.processGroups.get(groupKey))
  const storedOpen = seatProps.useStore(state => state.processGroups.find(entry => entry.key === groupKey)?.open)
  const startTime = useChat((snapshot) => {
    const currentGroup = snapshot.processGroups.get(groupKey)
    if (currentGroup?.startTime !== undefined) return currentGroup.startTime
    return currentGroup?.turn === undefined
      ? undefined
      : snapshot.legacy.turnTimings.get(currentGroup.turn)?.startTime
  })
  const [open, setOpen] = useState(() => storedOpen ?? group?.closed === false)
  const previousClosed = useRef(group?.closed)
  useEffect(() => {
    if (group === undefined) return
    if (previousClosed.current !== group.closed || storedOpen !== undefined) {
      setOpen(storedOpen ?? !group.closed)
      previousClosed.current = group.closed
    }
  }, [group, storedOpen])
  const reveal = useCallback(() => {
    setOpen(true)
    seatProps.actions.setProcessGroupOpen(groupKey, true)
  }, [groupKey, seatProps.actions])
  const bodyRef = useSearchableHidden(!open, reveal)
  const [edges, setEdges] = useState<ScrollEdges>(NO_SCROLL)
  const syncEdges = useCallback(() => {
    const body = bodyRef.current
    const next = body === null || !open ? NO_SCROLL : scrollEdges(body)
    setEdges(current => sameScroll(current, next) ? current : next)
  }, [bodyRef, open])
  useLayoutEffect(() => {
    syncEdges()
    const body = bodyRef.current
    if (body === null || !open || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncEdges)
    observer.observe(body)
    for (const child of body.children) observer.observe(child)
    return () => { observer.disconnect() }
  }, [bodyRef, group?.members.length, open, syncEdges])
  const elapsed = useElapsed(startTime, group !== undefined && !group.closed, seatProps.t)
  const title = useMemo(() => group === undefined ? '' : processGroupTitle(group, elapsed, seatProps.t), [elapsed, group, seatProps.t])
  const bodyId = useId()
  if (group === undefined) return null
  const bodyClasses = [css.body]
  if (edges.up) bodyClasses.push(css.fadeTop)
  if (edges.down) bodyClasses.push(css.fadeBottom)
  return (
    <div
      className={css.root}
      data-process-group=""
      data-process-group-key={groupKey}
      data-chat-flow-key={groupKey}
      data-chat-anchor-key={`group:${groupKey}`}
      data-chat-flow-kind="process-group"
      data-chat-turn={group.turn}
      data-running={group.closed ? undefined : ''}
      data-failed={group.summary.failed ? '' : undefined}
    >
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={(event) => {
          event.currentTarget.focus()
          setOpen((value) => {
            const next = !value
            seatProps.actions.setProcessGroupOpen(groupKey, next)
            return next
          })
        }}
      >
        <span className={css.chevronBox} aria-hidden>
          <IconChevronDownOutline14 className={css.chevron} />
        </span>
        <span className={css.label}>{title}</span>
        {group.summary.failed && (
          <span className={css.failedBadge} role="status">
            <span className={css.failedDot} aria-hidden />
            {group.summary.failedCount !== undefined && group.summary.failedCount > 1
              ? seatProps.t('message.processGroup.failedCount', { count: group.summary.failedCount })
              : seatProps.t('message.processGroup.failedSingle')}
          </span>
        )}
      </button>
      <div
        ref={bodyRef}
        id={bodyId}
        className={bodyClasses.join(' ')}
        data-process-group-body=""
        data-scroll-up={edges.up || undefined}
        data-scroll-down={edges.down || undefined}
        onScroll={syncEdges}
      >
        <div className={css.members}>
          {group.members.map(member => (
            <ChatNodeSeat
              key={`${member.nodeKey}:${member.part ?? ''}`}
              {...seatProps}
              nodeKey={member.nodeKey}
              groupedTranscript
              {...member.part === undefined ? {} : { groupPart: member.part }}
            />
          ))}
        </div>
      </div>
    </div>
  )
})
