/**
 * Long-term memory browser: the **Memory** entry of the sidebar and the panel
 * it opens in the main column. The panel lists the deployment's memory banks,
 * and for the selected bank shows its statistics, its memory units, its
 * knowledge pages, a search over the knowledge index, and one page's body.
 * The units section is also where a person writes: recording a finding, and
 * curating one the backend already holds. Everything comes from the Host
 * through the `memoryController` Remote; a deployment with no usable memory
 * provider says so with the reason the Host classified instead of showing an
 * empty panel, and a provider without a section says so in place of that
 * section rather than dropping it without a word.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button, IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconDatabaseOutline16, IconPlusOutline16, IconRefreshOutline16, IconSearchOutline16, IconWarningOutline16,
  Input, MarkdownText, StateDot, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MemoryBankStats, MemoryCount, MemoryUnitSummary,
} from '@deepseek-ai/dsh-host-memory-controller/types'
import { problemDetail, problemText, writtenText } from './presentation.ts'
import {
  sortBanks, type MemoryAddDraft, type MemoryBrowserFace, type MemoryBrowserState, type MemoryEditDraft,
  type MemoryPanelProblem, type MemoryWriteNote,
} from './memory-store.ts'
import css from './MemoryBrowserPage.module.css'

/** Full component props assembled by the main slot renderer. */
export type MemoryBrowserPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'memoryBrowser'>
  & InjectFace<MemoryBrowserFace>

/**
 * What the panel shows: the bank list, or one bank's detail. A knowledge page
 * opens *over* a bank's detail rather than replacing it, because a page is a
 * reading of the bank rather than a step away from it.
 */
type View =
  | { readonly kind: 'banks' }
  | { readonly kind: 'bank'; readonly bankId: string }

/** How much of a bank is in flight, as the busy dot and the disabled controls read it. */
const DOT_BY_SCOPE = {
  none: 'done',
  banks: 'ongoing',
  bank: 'ongoing',
} as const

/** The one-line failure a panel or section shows: the classified sentence and, when it adds something, the diagnostic. */
function ProblemNote({ problem, t, onRetry }: {
  readonly problem: MemoryPanelProblem
  readonly t: MemoryBrowserPageProps['t']
  readonly onRetry?: () => void
}): ReactNode {
  const detail = problemDetail(problem)
  return (
    <div className={css.problem} role="status" data-memory-problem={problem.kind === 'unavailable' ? problem.reason : 'error'}>
      <IconWarningOutline16 size={14} aria-hidden="true" />
      <div className={css.problemMain}>
        <p className={css.problemText}>{problemText(problem, t)}</p>
        {detail === null ? null : <p className={css.problemDetail}>{detail}</p>}
      </div>
      {onRetry === undefined ? null : (
        <Button variant="outline" size="sm" onClick={onRetry}>{t('retry')}</Button>
      )}
    </div>
  )
}

/**
 * What the last write did. An accepted write notes the outcome and refreshes;
 * a refused one keeps its form open, so the note says the write did not land
 * and carries the backend's own words. The Host's operation detail shows
 * beneath the sentence when there is one.
 */
function WriteNote({ note, t, onDismiss }: {
  readonly note: MemoryWriteNote
  readonly t: MemoryBrowserPageProps['t']
  readonly onDismiss: () => void
}): ReactNode {
  const sentence = note.kind === 'remembered'
    ? t('writeRemembered')
    : note.kind === 'curated' ? t('writeCurated') : t('writeRefused')
  return (
    <div className={css.writeNote} role="status" data-memory-write-note={note.kind}>
      <div className={css.writeNoteMain}>
        <p className={css.writeNoteText}>{sentence}</p>
        {note.detail.length === 0 ? null : <p className={css.writeNoteDetail}>{note.detail}</p>}
      </div>
      <button type="button" className={css.iconButton} aria-label={t('dismiss')} onClick={onDismiss}>
        <span className={css.iconWrap} aria-hidden="true"><IconCloseOutline16 size={14} /></span>
      </button>
    </div>
  )
}

/** The add-memory form: the finding, the optional context, and the two endings. */
function AddMemoryForm({ draft, writing, t, onEdit, onSubmit, onCancel }: {
  readonly draft: MemoryAddDraft
  readonly writing: boolean
  readonly t: MemoryBrowserPageProps['t']
  readonly onEdit: (field: 'text' | 'context', value: string) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
}): ReactNode {
  return (
    <form
      className={css.writeForm}
      data-memory-add-form
      onSubmit={(event) => { event.preventDefault(); onSubmit() }}
    >
      <textarea
        className={css.writeTextarea}
        aria-label={t('addTextAria')}
        placeholder={t('addTextPlaceholder')}
        value={draft.text}
        onChange={(event) => { onEdit('text', event.target.value) }}
      />
      <Input
        className={css.writeContext as string}
        aria-label={t('addContextAria')}
        placeholder={t('addContextPlaceholder')}
        value={draft.context}
        onChange={(event) => { onEdit('context', event.target.value) }}
      />
      <div className={css.writeActions}>
        <Button variant="primary" size="sm" type="submit" disabled={writing || draft.text.trim().length === 0}>
          {t('addSubmit')}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </form>
  )
}

/** The curate form over one unit: the draft is authoritative, so every field is sent. */
function CurateForm({ draft, writing, t, onEdit, onSubmit, onCancel }: {
  readonly draft: MemoryEditDraft
  readonly writing: boolean
  readonly t: MemoryBrowserPageProps['t']
  readonly onEdit: (field: 'text' | 'context' | 'factType', value: string) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
}): ReactNode {
  return (
    <form
      className={css.writeForm}
      data-memory-edit-form={draft.unitId}
      onSubmit={(event) => { event.preventDefault(); onSubmit() }}
    >
      <textarea
        className={css.writeTextarea}
        aria-label={t('editTextAria')}
        value={draft.text}
        onChange={(event) => { onEdit('text', event.target.value) }}
      />
      <div className={css.writeRow}>
        <Input
          className={css.writeContext as string}
          aria-label={t('editContextAria')}
          placeholder={t('editContextPlaceholder')}
          value={draft.context}
          onChange={(event) => { onEdit('context', event.target.value) }}
        />
        <Input
          className={css.writeContext as string}
          aria-label={t('editFactTypeAria')}
          placeholder={t('editFactTypePlaceholder')}
          value={draft.factType}
          onChange={(event) => { onEdit('factType', event.target.value) }}
        />
      </div>
      <div className={css.writeActions}>
        <Button variant="primary" size="sm" type="submit" disabled={writing || draft.text.trim().length === 0}>
          {t('editSubmit')}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </form>
  )
}

/** One statistic as a labelled number. */
function Stat({ label, value, testId }: {
  readonly label: string
  readonly value: number
  readonly testId: string
}): ReactNode {
  return (
    <div className={css.stat} data-memory-stat={testId}>
      <span className={css.statValue}>{value}</span>
      <span className={css.statLabel}>{label}</span>
    </div>
  )
}

/**
 * One counted distribution as labelled bars, largest first. An empty
 * distribution says so in words rather than drawing a row of zero-width bars,
 * which would read as "measured and empty" rather than "not reported".
 */
function Distribution({ title, counts, testId, t }: {
  readonly title: string
  readonly counts: readonly MemoryCount[]
  readonly testId: string
  readonly t: MemoryBrowserPageProps['t']
}): ReactNode {
  const largest = Math.max(1, ...counts.map(entry => entry.count))
  return (
    <section className={css.distribution} data-memory-distribution={testId}>
      <h4 className={css.distributionTitle}>{title}</h4>
      {counts.length === 0
        ? <p className={css.status}>{t('distributionEmpty')}</p>
        : (
          <ul className={css.bars}>
            {counts.map(entry => (
              <li key={entry.label} className={css.bar} data-memory-bar={entry.label}>
                <span className={css.barLabel}>{entry.label}</span>
                <span className={css.barTrack}>
                  <span className={css.barFill} style={{ width: `${Math.round((entry.count / largest) * 100)}%` }} />
                </span>
                <span className={css.barCount}>{entry.count}</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

/** The selected bank's statistics: five totals and the two backend distributions. */
function StatsBlock({ stats, t }: {
  readonly stats: MemoryBankStats
  readonly t: MemoryBrowserPageProps['t']
}): ReactNode {
  return (
    <section className={css.stats} data-memory-stats={stats.bankId}>
      <h3 className={css.sectionTitle}>{t('statsTitle')}</h3>
      <div className={css.statRow}>
        <Stat label={t('statNodes')} value={stats.totalNodes} testId="nodes" />
        <Stat label={t('statLinks')} value={stats.totalLinks} testId="links" />
        <Stat label={t('statDocuments')} value={stats.totalDocuments} testId="documents" />
        <Stat label={t('statPending')} value={stats.pendingOperations} testId="pending" />
        <Stat label={t('statFailed')} value={stats.failedOperations} testId="failed" />
      </div>
      <div className={css.distributions}>
        <Distribution title={t('factTypes')} counts={stats.nodesByFactType} testId="fact-types" t={t} />
        <Distribution title={t('linkTypes')} counts={stats.linksByLinkType} testId="link-types" t={t} />
      </div>
    </section>
  )
}

/** The page's crumb: back to the bank list, then the bank it came from. */
function Crumb({ label, text, onBack }: {
  readonly label: string
  readonly text: string
  readonly onBack: () => void
}): ReactNode {
  return (
    <button type="button" className={css.crumb} aria-label={label} onClick={onBack}>
      <IconChevronLeftOutline14 className={css.crumbIcon} aria-hidden="true" />
      <span>{text}</span>
    </button>
  )
}

/** One memory unit row, with the curate form open over it while it is edited. */
function UnitRow({ unit, draft, writing, now, t, onStartEdit, onEdit, onSubmitEdit, onCancelEdit }: {
  readonly unit: MemoryUnitSummary
  readonly draft: MemoryEditDraft | null
  readonly writing: boolean
  readonly now: number
  readonly t: MemoryBrowserPageProps['t']
  readonly onStartEdit: (unit: MemoryUnitSummary) => void
  readonly onEdit: (field: 'text' | 'context' | 'factType', value: string) => void
  readonly onSubmitEdit: () => void
  readonly onCancelEdit: () => void
}): ReactNode {
  const mentionedAt = unit.mentionedAt ?? unit.updatedAt
  return (
    <li className={css.unit} data-memory-unit={unit.id}>
      {draft === null
        ? (
          <>
            <p className={css.unitText}>{unit.text}</p>
            <div className={css.unitMeta}>
              {unit.factType === undefined ? null : <Tag tone="neutral">{unit.factType}</Tag>}
              {mentionedAt === undefined ? null : <span>{writtenText(mentionedAt, now, t)}</span>}
              <Button variant="outline" size="sm" onClick={() => { onStartEdit(unit) }}>
                {t('edit')}
              </Button>
            </div>
          </>
        )
        : (
          <CurateForm
            draft={draft}
            writing={writing}
            t={t}
            onEdit={onEdit}
            onSubmit={onSubmitEdit}
            onCancel={onCancelEdit}
          />
        )}
    </li>
  )
}

/**
 * The bank's memory units: the filter, the write entry, the unit list, and the
 * pagination. Every browsable provider serves units, so this section renders
 * for any of them; a provider whose read fails says so here while the rest of
 * the bank keeps rendering.
 */
function UnitsSection({ props, state, now }: {
  readonly props: MemoryBrowserPageProps
  readonly state: MemoryBrowserState
  readonly now: number
}): ReactNode {
  const { t } = props
  const lastOnPage = state.unitsOffset + state.units.length
  return (
    <section className={css.units} data-memory-units={state.units.length}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('unitsTitle')}</h3>
        <span className={css.count}>{t('unitsCount', { count: String(state.unitsTotal) })}</span>
        <Button
          variant="primary"
          size="sm"
          icon={<IconPlusOutline16 size={13} />}
          disabled={state.addDraft !== null}
          onClick={props.startAdd}
        >
          {t('add')}
        </Button>
      </div>

      {state.writeNote === null ? null : (
        <WriteNote note={state.writeNote} t={t} onDismiss={props.dismissWriteNote} />
      )}
      {state.writeProblem === null ? null : <ProblemNote problem={state.writeProblem} t={t} />}
      {state.addDraft === null ? null : (
        <AddMemoryForm
          draft={state.addDraft}
          writing={state.writing}
          t={t}
          onEdit={props.editAdd}
          onSubmit={props.submitAdd}
          onCancel={props.cancelAdd}
        />
      )}

      <form
        className={css.search}
        onSubmit={(event) => { event.preventDefault(); props.runUnitFilter() }}
      >
        <Input
          type="search"
          className={css.searchInput as string}
          placeholder={t('unitsFilterPlaceholder')}
          aria-label={t('unitsFilterAria')}
          value={state.unitQueryDraft}
          onChange={(event) => { props.editUnitQuery(event.target.value) }}
        />
        <Button
          variant="outline"
          size="sm"
          icon={<IconSearchOutline16 size={13} />}
          disabled={state.unitsLoading || state.unitQueryDraft.trim().length === 0}
          onClick={() => { props.runUnitFilter() }}
        >
          {t('unitsFilterRun')}
        </Button>
      </form>

      {state.unitsProblem === null ? null : <ProblemNote problem={state.unitsProblem} t={t} />}
      {state.unitsLoading ? <p className={css.status} role="status">{t('loading')}</p> : null}
      {!state.unitsLoading && state.units.length === 0 && state.unitsProblem === null
        ? <p className={css.empty} data-memory-units-empty>
          {state.unitQuery.length === 0 ? t('unitsEmpty') : t('unitsFilterEmpty')}
        </p>
        : (
          <ul className={css.unitList} data-memory-unit-list>
            {state.units.map(unit => (
              <UnitRow
                key={unit.id}
                unit={unit}
                draft={state.editDraft?.unitId === unit.id ? state.editDraft : null}
                writing={state.writing}
                now={now}
                t={t}
                onStartEdit={props.startEdit}
                onEdit={props.editCurate}
                onSubmitEdit={props.submitEdit}
                onCancelEdit={props.cancelEdit}
              />
            ))}
          </ul>
        )}

      {state.unitsTotal > state.unitsLimit && state.unitsLimit > 0
        ? (
          <div className={css.pagination}>
            <span className={css.count} data-memory-units-range>
              {t('unitsRange', {
                first: String(state.unitsOffset + 1),
                last: String(Math.max(lastOnPage, state.unitsOffset + 1)),
                total: String(state.unitsTotal),
              })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={state.unitsOffset === 0}
              onClick={() => { props.pageUnits(Math.max(0, state.unitsOffset - state.unitsLimit)) }}
            >
              {t('prevPage')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={lastOnPage >= state.unitsTotal}
              onClick={() => { props.pageUnits(state.unitsOffset + state.unitsLimit) }}
            >
              {t('nextPage')}
            </Button>
          </div>
        )
        : null}
    </section>
  )
}

/**
 * Render the memory browser: the bank list, or the selected bank's statistics,
 * memory units, knowledge pages, search, and the open page's body.
 * @param props - composed slot props (see {@link MemoryBrowserPageProps}).
 * @returns the panel element tree.
 */
export function MemoryBrowserPage(props: MemoryBrowserPageProps): ReactNode {
  const { t, ensure, refresh, selectBank, editQuery, runSearch, openPage, closePage, dismissProblem } = props
  const state = props.useMemoryBrowser(snapshot => snapshot)
  // What is open; a bank that leaves the list drops back to the list.
  const [view, setView] = useState<View>({ kind: 'banks' })
  useEffect(() => { ensure() }, [ensure])
  // One clock for the whole render, so two banks' trailing labels agree.
  const now = Date.now()
  // Stable per locale revision: a fresh object per render would rebuild
  // MarkdownText's component table on every state change.
  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('footnotes'),
  }), [t])

  const loaded = state.status === 'ready' || state.status === 'unavailable' || state.status === 'error'
  const banks = sortBanks(state.banks)
  const openBank = view.kind === 'bank' ? banks.find(bank => bank.bankId === view.bankId) : undefined
  const showsList = openBank === undefined
  const stats = state.bankId === openBank?.bankId ? state.stats : null
  const bankList = (
    <ul className={css.banks} data-memory-banks={banks.length}>
      {banks.map(bank => (
        <li key={bank.bankId}>
          <button
            type="button"
            className={css.bank}
            data-memory-bank={bank.bankId}
            aria-current={bank.bankId === state.bankId}
            {...bank.bankId === state.bankId ? { 'data-selected': '' } : {}}
            onClick={() => { selectBank(bank.bankId); setView({ kind: 'bank', bankId: bank.bankId }) }}
          >
            <span className={css.bankIcon} aria-hidden="true"><IconDatabaseOutline16 /></span>
            <span className={css.bankMain}>
              <span className={css.bankName}>{bank.name}</span>
              <span className={css.bankMeta}>
                {t('facts', { count: String(bank.factCount) })}
                <span className={css.bankDot} aria-hidden="true">·</span>
                {writtenText(bank.lastWriteAt, now, t)}
              </span>
            </span>
            <IconChevronRightOutline14 className={css.bankChevron} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  )

  return (
    <section className={css.page} data-memory-panel aria-busy={state.loading !== 'none'}>
      <header className={css.pageHead}>
        <div>
          {showsList ? null : (
            <Crumb
              label={t('backToBanks')}
              text={t('backToBanks')}
              onBack={() => { setView({ kind: 'banks' }); closePage() }}
            />
          )}
          {/* A bank that left the list drops back to the list view, so the title never names a bank that is gone. */}
          <h1 className={css.pageTitle}>{openBank === undefined ? t('title') : openBank.name}</h1>
          {showsList ? <p className={css.pageIntro}>{t('intro')}</p> : null}
        </div>
        <div className={css.toolbar}>
          <span className={css.busy} aria-hidden="true">
            <StateDot state={DOT_BY_SCOPE[state.loading]} size={8} />
          </span>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('refresh')}
            title={t('refresh')}
            disabled={!loaded}
            onClick={refresh}
          >
            <span className={css.iconWrap} aria-hidden="true"><IconRefreshOutline16 /></span>
          </button>
        </div>
      </header>

      {state.status === 'loading' && banks.length === 0 ? <p className={css.status}>{t('loading')}</p> : null}
      {state.problem === null ? null : (
        <ProblemNote
          problem={state.problem}
          t={t}
          {...state.problem.kind === 'error' ? { onRetry: () => { dismissProblem(); refresh() } } : {}}
        />
      )}

      {loaded && showsList
        ? banks.length === 0
          ? <p className={css.empty}>{t('empty')}</p>
          : (
            <>
              <p className={css.count} data-memory-bank-count={banks.length}>
                {t('bankCount', { count: String(banks.length) })}
              </p>
              {bankList}
            </>
          )
        : null}

      {loaded && openBank !== undefined
        ? (
          <div className={css.detail} data-memory-bank-detail={openBank.bankId}>
            {state.openPage === null && state.pageLoading
              ? <p className={css.status}>{t('loading')}</p>
              : state.openPage === null
                ? null
                : (
                  <article className={css.pageCard} data-memory-page={state.openPage.pageId}>
                    <div className={css.pageCardHead}>
                      <h2 className={css.pageCardTitle}>{state.openPage.name}</h2>
                      <button type="button" className={css.iconButton} aria-label={t('pageTitle')} onClick={closePage}>
                        <span className={css.iconWrap} aria-hidden="true"><IconCloseOutline16 size={14} /></span>
                      </button>
                    </div>
                    <div className={css.pageBody} data-memory-page-body>
                      <MarkdownText text={state.openPage.body} labels={markdownLabels} />
                    </div>
                  </article>
                )}

            {stats === null
              ? state.statsProblem === null
                ? null
                : <ProblemNote problem={state.statsProblem} t={t} />
              : <StatsBlock stats={stats} t={t} />}

            <UnitsSection props={props} state={state} now={now} />

            <section className={css.pages} data-memory-pages={state.pages.length}>
              <div className={css.sectionHead}>
                <h3 className={css.sectionTitle}>{t('pagesTitle')}</h3>
                <span className={css.count}>{t('pagesCount', { count: String(state.pages.length) })}</span>
              </div>
              {state.pagesProblem === null
                ? (
                  <>
                    <form
                      className={css.search}
                      onSubmit={(event) => { event.preventDefault(); runSearch() }}
                    >
                      <Input
                        type="search"
                        className={css.searchInput as string}
                        placeholder={t('searchPlaceholder')}
                        aria-label={t('searchAria')}
                        value={state.query}
                        onChange={(event) => { editQuery(event.target.value) }}
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<IconSearchOutline16 size={13} />}
                        disabled={state.searching || state.query.trim().length === 0}
                        onClick={() => { runSearch() }}
                      >
                        {t('searchRun')}
                      </Button>
                    </form>
                    {state.searching ? <p className={css.status} role="status">{t('loading')}</p> : null}
                    {state.searchProblem === null ? null : <ProblemNote problem={state.searchProblem} t={t} />}
                    {state.searchProblem === null && !state.searching
                      ? state.hits.length === 0
                        ? <p className={css.status} data-memory-search-idle>
                          {state.query.trim().length === 0 ? t('searchIdle') : t('searchEmpty')}
                        </p>
                        : (
                          <>
                            <p className={css.count} data-memory-hit-count={state.total}>
                              {t('searchCount', { count: String(state.total) })}
                            </p>
                            <ul className={css.hits} data-memory-hits={state.hits.length}>
                              {state.hits.map(hit => (
                                <li key={hit.pageId}>
                                  <button
                                    type="button"
                                    className={css.hit}
                                    data-memory-hit={hit.pageId}
                                    aria-label={t('openHit', { name: hit.name })}
                                    onClick={() => { openPage(hit.pageId) }}
                                  >
                                    <span className={css.hitName}>{hit.name}</span>
                                    <span className={css.hitSnippet}>{hit.snippet}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </>
                        )
                      : null}
                    {state.pages.length === 0
                      ? <p className={css.empty}>{t('pagesEmpty')}</p>
                      : (
                        <ul className={css.pageList}>
                          {state.pages.map(page => (
                            <li key={page.pageId}>
                              <button
                                type="button"
                                className={css.pageRow}
                                data-memory-page-row={page.pageId}
                                aria-label={t('openPage', { name: page.name })}
                                onClick={() => { openPage(page.pageId) }}
                              >
                                <span className={css.pageRowMain}>
                                  <span className={css.pageRowName}>{page.name}</span>
                                  {page.description === undefined
                                    ? null
                                    : <span className={css.pageRowDesc}>{page.description}</span>}
                                </span>
                                {page.stale ? <Tag tone="neutral">{t('pageStale')}</Tag> : null}
                                {page.updatedAt === undefined
                                  ? null
                                  : <span className={css.pageRowTime}>{writtenText(page.updatedAt, now, t)}</span>}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                  </>
                )
                : <ProblemNote problem={state.pagesProblem} t={t} />}
            </section>
          </div>
        )
        : null}
    </section>
  )
}
