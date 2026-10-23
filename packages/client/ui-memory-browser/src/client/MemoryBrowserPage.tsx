/**
 * Long-term memory browser: the **Memory** entry of the sidebar and the panel
 * it opens in the main column. The panel lists the deployment's memory banks
 * with their fact counts and last write, and for the selected bank shows its
 * statistics and composition, its knowledge pages, a search over the knowledge
 * index, and one page's body. Everything comes from the Host through the
 * `memoryController` Remote; a deployment with no usable memory provider says so
 * with the reason the Host classified rather than showing an empty panel.
 */

import { useEffect, useState, type ReactNode } from 'react'
import {
  Button, IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconDatabaseOutline16, IconRefreshOutline16, IconSearchOutline16, IconWarningOutline16, Input, StateDot, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryBankStats, MemoryCount } from '@deepseek-ai/dsh-host-memory-controller/types'
import { problemDetail, problemText, writtenText } from './presentation.ts'
import { sortBanks, type MemoryBrowserFace, type MemoryPanelProblem } from './memory-store.ts'
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

/** The one-line failure a panel shows: the classified sentence and, when it adds something, the diagnostic. */
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

/**
 * Render the memory browser: the bank list, or the selected bank's statistics,
 * knowledge pages, search, and the open page's body.
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
                    <pre className={css.pageBody} data-memory-page-body>{state.openPage.body}</pre>
                  </article>
                )}

            {stats === null ? null : <StatsBlock stats={stats} t={t} />}

            <section className={css.pages} data-memory-pages={state.pages.length}>
              <div className={css.sectionHead}>
                <h3 className={css.sectionTitle}>{t('pagesTitle')}</h3>
                <span className={css.count}>{t('pagesCount', { count: String(state.pages.length) })}</span>
              </div>
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
            </section>
          </div>
        )
        : null}
    </section>
  )
}
