/**
 * Project services management panel: the global page the sidebar row opens.
 *
 * The panel is pure presentation. It reads one snapshot through the
 * framework-bound `usePanel` selector hook and calls the inject face's verbs
 * from event handlers; it holds no store, issues no Remote call, and subscribes
 * to nothing itself. Every fact it renders comes from the `projectServices`
 * Remote namespace, which `src/client/panel-source.ts` owns.
 *
 * @module
 */

import React from 'react'
import { Button, StateDot, Tag, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ApiServiceItemView,
  ApiServiceProviderView,
} from '@deepseek-ai/dsh-api-project-services-controller/types'
import type { ProjectServicesPanelProps } from './contract/slots.ts'
import type { ProjectServicesKey } from './locales.ts'
import css from './ProjectServicesPanel.module.css'
import { ServiceCardActions } from './ServiceCardActions.tsx'

/**
 * Map a service's reported state onto the state dot's vocabulary.
 * @param state - state the inventory reported for the service.
 * @returns the state dot's matching state.
 */
function mapStateDot(state: ApiServiceItemView['state']): StateDotState {
  switch (state) {
    case 'running':
      return 'done'
    case 'starting':
      return 'ongoing'
    case 'stopped':
      return 'idle'
    case 'unknown':
    default:
      return 'warning'
  }
}

/**
 * Map a provider's reported state onto the dictionary key that names it.
 * @param state - state the inventory reported for the provider.
 * @returns the copy key for that state.
 */
function mapProviderState(state: ApiServiceProviderView['state']): ProjectServicesKey {
  switch (state) {
    case 'ready':
      return 'provider.ready'
    case 'stale':
      return 'provider.stale'
    case 'unavailable':
    default:
      return 'provider.unavailable'
  }
}

/**
 * Map a provider's reported state onto a tag tone.
 * @param state - state the inventory reported for the provider.
 * @returns the tag tone for that state.
 */
function mapProviderTone(state: ApiServiceProviderView['state']): TagTone {
  switch (state) {
    case 'ready':
      return 'success'
    case 'stale':
      return 'warning'
    case 'unavailable':
    default:
      return 'danger'
  }
}

/**
 * Render the project services panel for the checkout the source has selected.
 *
 * The worktree selector switches the whole panel, so the services of the other
 * checkouts stay unmounted rather than grouped. A card's buttons are those the
 * inventory's `actions` list names for that service and its state allows, and a
 * card with an action in flight is disabled. Docker services that belong to a
 * group render inside that group's card; the rest render as ungrouped cards.
 * @param props - the `main` seat's runtime share, the declared namespace's `t` seat, and the inject face.
 * @returns the panel element.
 */
export function ProjectServicesPanel({
  usePanel,
  selectCheckout,
  refresh,
  control,
  stopGroup,
  openLogs,
  closeLogs,
  dismissError,
  t,
}: ProjectServicesPanelProps) {
  const snapshot = usePanel(state => state)
  const checkouts = snapshot.inventory?.checkouts ?? []
  const activeCheckoutId = snapshot.selectedCheckoutId ?? checkouts[0]?.id

  const checkoutItems = (snapshot.inventory?.items ?? []).filter(item => item.checkoutId === activeCheckoutId)
  const nativeItems = checkoutItems.filter(item => item.kind === 'native')
  const dockerItems = checkoutItems.filter(item => item.kind === 'docker')
  const groups = (snapshot.inventory?.groups ?? []).filter(group => group.checkoutId === activeCheckoutId)
  const providers = snapshot.inventory?.providers ?? []

  const activeCheckout = checkouts.find(c => c.id === activeCheckoutId)
  const logChunks = snapshot.logs?.chunks ?? []
  const pendingActions = snapshot.pendingActions

  return (
    <div className={css.panel} data-testid="project-services-panel">
      {/* Header bar */}
      <div className={css.header}>
        <div className={css.titleGroup}>
          <h2 className={css.title}>{t('title')}</h2>
          {activeCheckout && (
            <Tag tone={activeCheckout.availability === 'present' ? 'success' : 'warning'}>
              {activeCheckout.availability === 'present' ? t('worktree.present') : t('worktree.missing')}
            </Tag>
          )}
        </div>

        <div className={css.worktreeControls}>
          <label htmlFor="worktree-select" className={css.sectionTitle}>
            {t('section.worktree')}
          </label>
          <select
            id="worktree-select"
            className={css.worktreeSelect}
            value={activeCheckoutId ?? ''}
            onChange={(event) => { selectCheckout(event.target.value) }}
            data-testid="worktree-selector"
          >
            {checkouts.length === 0 && <option value="">{t('worktree.select')}</option>}
            {checkouts.map(checkout => (
              <option key={checkout.id} value={checkout.id}>
                {checkout.id} ({checkout.path})
              </option>
            ))}
          </select>

          <Button size="sm" variant="ghost" onClick={refresh} data-testid="refresh-button">
            {t('action.refresh')}
          </Button>
        </div>
      </div>

      {/* Provider status: an unreachable Docker daemon is a provider fact, not a stopped service. */}
      {providers.length > 0 && (
        <div className={css.providerRow} data-testid="provider-row">
          <span className={css.sectionTitle}>{t('section.provider')}</span>
          {providers.map(provider => (
            <span key={provider.id} className={css.providerItem}>
              {provider.kind === 'native' ? t('kind.native') : t('kind.docker')}
              <Tag tone={mapProviderTone(provider.state)}>{t(mapProviderState(provider.state))}</Tag>
            </span>
          ))}
        </div>
      )}

      {/* Error alert banner */}
      {snapshot.error !== undefined && (
        <div className={css.errorBanner} role="alert" data-testid="error-banner">
          <span>
            {t('error.prefix')}
            {snapshot.error}
          </span>
          <Button size="sm" variant="ghost" onClick={dismissError}>
            {t('error.dismiss')}
          </Button>
        </div>
      )}

      {/* Native Services Section */}
      <section className={css.section} data-testid="native-services-section">
        <div className={css.sectionHeader}>
          <h3 className={css.sectionTitle}>{t('section.native')}</h3>
        </div>
        {nativeItems.length === 0 ? (
          <div className={css.emptyNotice}>{t('empty.native')}</div>
        ) : (
          <div className={css.serviceList}>
            {nativeItems.map(item => (
              <React.Fragment key={item.id}>
                <div className={css.serviceCard} data-testid={`service-item-${item.id}`}>
                  <div className={css.cardLeft}>
                    <StateDot state={mapStateDot(item.state)} />
                    <div className={css.cardInfo}>
                      <div className={css.serviceName}>
                        {item.name}
                        <Tag tone={item.ownership === 'managed' ? 'info' : 'outline'}>
                          {item.ownership === 'managed' ? t('ownership.managed') : t('ownership.external')}
                        </Tag>
                        {item.stale === true && <Tag tone="warning">{t('provider.stale')}</Tag>}
                      </div>
                      <div className={css.serviceMeta}>
                        <span>{t(`status.${item.state}`)}</span>
                        {item.ports !== undefined && item.ports.length > 0 && (
                          <span>{t('ports')}{item.ports.join(', ')}</span>
                        )}
                        {item.detail !== undefined && <span>{item.detail}</span>}
                      </div>
                    </div>
                  </div>

                  <ServiceCardActions
                    item={item}
                    pendingActions={pendingActions}
                    control={control}
                    openLogs={openLogs}
                    t={t}
                  />
                </div>

                {/* Inline Logs Viewer */}
                {snapshot.logsTargetId === item.id && (
                  <div className={css.logsCard} data-testid={`logs-viewer-${item.id}`}>
                    <div className={css.logsHeader}>
                      <span>
                        {t('logs.title')}: {item.name} ({item.id})
                      </span>
                      <div className={css.logsHeaderActions}>
                        {snapshot.logs?.truncated === true && (
                          <span className={css.logsTruncated}>{t('logs.truncated')}</span>
                        )}
                        <Button size="sm" variant="ghost" onClick={closeLogs} data-testid="logs-close">
                          {t('logs.close')}
                        </Button>
                      </div>
                    </div>
                    <div className={css.logsBody} data-testid={`logs-body-${item.id}`}>
                      {snapshot.isLoadingLogs
                        ? t('logs.loading')
                        : logChunks.length === 0
                          ? t('logs.empty')
                          : logChunks.map((chunk, idx) => (
                            <div key={idx} className={chunk.stream === 'stderr' ? css.logStderr : undefined}>
                              {chunk.text}
                            </div>
                          ))}
                    </div>
                    {snapshot.logs?.gap === true && (
                      <div className={css.logsNotice} data-testid={`logs-gap-${item.id}`}>{t('logs.gap')}</div>
                    )}
                    {snapshot.logs?.unavailable !== undefined && (
                      <div className={css.logsNotice} data-testid={`logs-unavailable-${item.id}`}>
                        {t('logs.unavailable')}{snapshot.logs.unavailable}
                      </div>
                    )}
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </section>

      {/* Docker & Compose Services Section */}
      <section className={css.section} data-testid="docker-services-section">
        <div className={css.sectionHeader}>
          <h3 className={css.sectionTitle}>{t('section.docker')}</h3>
        </div>

        {groups.map((group) => {
          const groupMembers = dockerItems.filter(item => group.targetIds.includes(item.id))
          const anyRunning = groupMembers.some(m => m.state === 'running')
          const groupPending = groupMembers.some(m => pendingActions[m.id] !== undefined)
          return (
            <div key={group.id} className={css.groupCard} data-testid={`group-card-${group.id}`}>
              <div className={css.groupHeader}>
                <span className={css.groupTitle}>{group.name}</span>
                {anyRunning && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={groupPending}
                    onClick={() => {
                      void stopGroup(groupMembers.map(item => ({
                        targetId: item.id,
                        expectedRevision: item.revision,
                      })))
                    }}
                    data-testid={`action-stop-all-${group.id}`}
                  >
                    {t('action.stopAll')}
                  </Button>
                )}
              </div>
              <div className={css.serviceList}>
                {groupMembers.map(item => (
                  <div key={item.id} className={css.serviceCard} data-testid={`service-item-${item.id}`}>
                    <div className={css.cardLeft}>
                      <StateDot state={mapStateDot(item.state)} />
                      <div className={css.cardInfo}>
                        <div className={css.serviceName}>
                          {item.name}
                          <Tag tone="neutral">{t('kind.docker')}</Tag>
                          {item.stale === true && <Tag tone="warning">{t('provider.stale')}</Tag>}
                        </div>
                        <div className={css.serviceMeta}>
                          <span>{t(`status.${item.state}`)}</span>
                          {item.ports !== undefined && item.ports.length > 0 && (
                            <span>{t('ports')}{item.ports.join(', ')}</span>
                          )}
                          {item.detail !== undefined && <span>{item.detail}</span>}
                        </div>
                      </div>
                    </div>

                    <ServiceCardActions
                      item={item}
                      pendingActions={pendingActions}
                      control={control}
                      openLogs={openLogs}
                      t={t}
                    />
                  </div>
                ))}
              </div>
            </div>
          )
        })}

        {/* Ungrouped Docker Services */}
        {dockerItems
          .filter(item => !groups.some(g => g.targetIds.includes(item.id)))
          .map(item => (
            <div key={item.id} className={css.serviceCard} data-testid={`service-item-${item.id}`}>
              <div className={css.cardLeft}>
                <StateDot state={mapStateDot(item.state)} />
                <div className={css.cardInfo}>
                  <div className={css.serviceName}>
                    {item.name}
                    <Tag tone="neutral">{t('kind.docker')}</Tag>
                    {item.stale === true && <Tag tone="warning">{t('provider.stale')}</Tag>}
                  </div>
                  <div className={css.serviceMeta}>
                    <span>{t(`status.${item.state}`)}</span>
                    {item.ports !== undefined && item.ports.length > 0 && (
                      <span>{t('ports')}{item.ports.join(', ')}</span>
                    )}
                    {item.detail !== undefined && <span>{item.detail}</span>}
                  </div>
                </div>
              </div>

              <ServiceCardActions
                item={item}
                pendingActions={pendingActions}
                control={control}
                openLogs={openLogs}
                t={t}
              />
            </div>
          ))}

        {dockerItems.length === 0 && <div className={css.emptyNotice}>{t('empty.docker')}</div>}
      </section>
    </div>
  )
}

export default ProjectServicesPanel
