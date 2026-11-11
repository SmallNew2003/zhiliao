/** Assistant panel with a retained conversation and scoped task history. */
import { useEffect, useId, useState } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AssistantTaskId } from '@deepseek-ai/dsh-assistant-task/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  Button, IconChevronDownOutlineRegular, IconFlatListOutlineRegular, IconFolderCloseRegular,
  IconGlobeOutlineRegular, IconRefreshOutlineRegular, Menu, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantState } from './state.ts'
import css from './Assistant.module.css'
import { NS } from './locales.ts'
import { TaskCard, taskGroup } from './TaskCard.tsx'

/** Assistant selection, task actions and selected-Session acquisition. */
export interface AssistantPageInjected {
  readonly hooks: { readonly state: HostObservable<AssistantState> }
  readonly select: (workspaceId: WorkspaceId | null) => void
  readonly refresh: () => void
  readonly loadMore: () => void
  readonly cancelTask: (id: AssistantTaskId) => void
  readonly openTask: (sessionId: string) => void
  readonly refreshCatalog: () => Promise<void>
  readonly retain: (sessionId: SessionId) => SessionReference
}

/** Framework, localization and injected props of the main panel. */
export type AssistantPageProps = PropsRuntime<'main'> & PropsRenderSlots<'assistant.conversation'>
  & PropsLocale<typeof NS> & InjectFace<AssistantPageInjected>

/**
 * Render the conversation for the Session inherited from the assistant panel.
 * @param props - factory dispatcher in the selected Session scope.
 * @returns the embedded composer and transcript.
 */
export function AssistantConversation({ renderFactorySlot }: PropsRenderFactories) {
  return renderFactorySlot('conversation.embedded', { workspaceMode: 'optional' })
}

function SelectedChat({ sessionId, retain, useSessions, refreshCatalog, SessionProvider, renderSlot, t }: Pick<AssistantPageProps,
  'retain' | 'useSessions' | 'refreshCatalog' | 'SessionProvider' | 'renderSlot' | 't'> & { sessionId: SessionId }) {
  const available = useSessions(catalog => catalog.byId[sessionId] !== undefined)
  const [reference, setReference] = useState<SessionReference>()
  const [failed, setFailed] = useState(false)
  const [attempt, retry] = useState(0)
  useEffect(() => {
    let active = true
    let owned: SessionReference | undefined
    setReference(undefined)
    setFailed(false)
    async function acquire(): Promise<void> {
      try {
        if (available) {
          owned = retain(sessionId)
          setReference(owned)
          await owned.ready
        } else {
          await refreshCatalog()
          if (active) setFailed(true)
        }
      } catch (_acquisitionFailure) {
        if (active) {
          setReference(undefined)
          setFailed(true)
        }
      }
    }
    void acquire()
    return () => { active = false; owned?.release() }
  }, [available, retain, sessionId, refreshCatalog, attempt])
  if (available && reference !== undefined) {
    return <SessionProvider session={reference}>{renderSlot('assistant.conversation', {})}</SessionProvider>
  }
  return <div role="status" className={css.notice}>
    {failed ? <>{t('selectionError')}<Button size="sm" onClick={() => { retry(value => value + 1) }}>{t('retry')}</Button></>
      : <><StateDot state="ongoing" />{t('loading')}</>}
  </div>
}

/**
 * Render the selected assistant conversation alongside its tasks.
 * @param props - framework Session and Workspace hooks, selection and task actions.
 * @returns the assistant workspace.
 */
export function AssistantPage({
  useState: useAssistant, useWorkspaces, select, refresh, loadMore, cancelTask, openTask,
  retain, useSessions, refreshCatalog, SessionProvider, renderSlot, t,
}: AssistantPageProps) {
  const state = useAssistant(snapshot => snapshot)
  const workspaces = useWorkspaces(snapshot => snapshot.items)
  const [menuOpen, setMenuOpen] = useState(false)
  const id = useId()
  const project = workspaces.find(item => item.workspaceId === state.selectedWorkspace)
  const selection = state.selectedWorkspace === null ? t('global') : project?.title ?? t('project')
  const selectIcon = state.selectedWorkspace === null ? <IconGlobeOutlineRegular size={16} /> : <IconFolderCloseRegular size={16} />
  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} autoFocus portal compact
          selectedId={state.selectedWorkspace === null ? 'global' : 'project:' + state.selectedWorkspace}
          anchor={<Button variant="outline" icon={selectIcon} aria-haspopup="menu" aria-expanded={menuOpen}
            aria-label={t('selector') + ' · ' + selection} onClick={() => { setMenuOpen(!menuOpen) }}>
            <span className={css.selection}>{selection}</span><IconChevronDownOutlineRegular size={12} />
          </Button>}
          items={[
            { id: 'global', label: t('global'), icon: <IconGlobeOutlineRegular size={16} /> },
            ...(workspaces.length ? [{ type: 'label' as const, id: 'projects', text: t('project') }] : []),
            ...workspaces.map(item => ({ id: 'project:' + item.workspaceId, label: item.title, icon: <IconFolderCloseRegular size={16} /> })),
          ]}
          onSelect={(key) => {
            setMenuOpen(false)
            const next = workspaces.find(item => 'project:' + item.workspaceId === key)?.workspaceId ?? null
            if (next !== state.selectedWorkspace || state.selectionFailed) select(next)
          }}
        />
      </header>
      <div className={css.body}>
        <section aria-label={t('headerAssistant')} className={css.chat}>
          {state.selectionFailed && <div role="status" className={css.notice}>
            {t(state.selected ? 'selectionRefreshError' : 'selectionError')}
            <Button size="sm" onClick={refresh}>{t('retry')}</Button>
          </div>}
          {state.selected ? (
            <SelectedChat key={state.selected.sessionId} sessionId={state.selected.sessionId} retain={retain}
              useSessions={useSessions} refreshCatalog={refreshCatalog} SessionProvider={SessionProvider} renderSlot={renderSlot} t={t} />
          ) : !state.selectionFailed && <div role="status" className={css.notice}><StateDot state="ongoing" />{t('loading')}</div>}
        </section>
        <section aria-labelledby={id} aria-busy={!state.selectionFailed && state.phase === 'loading' || state.loadingMore} className={css.tasks}>
          <header className={css.tasksHeader}>
            <h2 id={id} className={css.sectionTitle}>{t('tasks')}</h2>
            <Button size="sm" icon={<IconRefreshOutlineRegular size={15} />} onClick={refresh}>{t('refresh')}</Button>
          </header>
          <div className={css.taskScroll}>
            {(state.phase === 'error' || state.visibility === 'error') && <div role="status" className={css.notice}>
              {state.phase === 'error' && <span>{t('loadError')}</span>}
              {state.visibility === 'error' && <span>{t('visibilityError')}</span>}
              <Button size="sm" onClick={refresh}>{t('retry')}</Button>
            </div>}
            {state.visibility === 'initial' && state.selected && <div role="status" className={css.meta}>{t('visibilityPending')}</div>}
            {state.phase === 'ready' && !state.tasks.length && <div className={css.empty}>
              <IconFlatListOutlineRegular size={24} /><strong>{t('empty')}</strong><p>{t('emptyHint')}</p>
            </div>}
            {(['waiting', 'active', 'finished'] as const).map((group) => {
              const tasks = state.tasks.filter(task => taskGroup(task.status) === group)
              return tasks.length > 0 && <section key={group} className={css.group}>
                <h3 className={css.groupTitle}>{t(group)} <span>{tasks.length}</span></h3>
                <ul className={css.list}>{tasks.map(task => <li key={task.id}>
                  <TaskCard task={task} project={task.workspaceId === undefined ? undefined :
                    workspaces.find(item => item.workspaceId === task.workspaceId)?.title}
                  cancelState={state.cancel[task.id]} openTask={openTask} cancelTask={cancelTask} t={t} />
                </li>)}</ul>
              </section>
            })}
            {state.hasMore && <Button variant="outline" disabled={state.loadingMore} onClick={loadMore}>
              {t(state.loadingMore ? 'loading' : 'loadMore')}
            </Button>}
          </div>
        </section>
      </div>
    </div>
  )
}
