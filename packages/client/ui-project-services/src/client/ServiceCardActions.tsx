/**
 * One service card's action row: the lifecycle verbs the inventory's `actions`
 * list names for the service and its state allows, plus the log viewer.
 *
 * The panel's three card lists — native services, grouped Docker services, and
 * ungrouped Docker services — offer every service the same verbs under the same
 * gates, so they share this row instead of each carrying its own copy.
 *
 * @module
 */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApiServiceItemView } from '@deepseek-ai/dsh-api-project-services-controller/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ProjectServicesPanelInjected,
  ProjectServicesPanelSnapshot,
} from './contract/slots.ts'
import css from './ProjectServicesPanel.module.css'

/** What one card's action row reads. */
export interface ServiceCardActionsProps {
  /** Service whose card the row belongs to. */
  readonly item: ApiServiceItemView
  /** Verb in flight per service id; a card with a verb in flight disables its buttons. */
  readonly pendingActions: ProjectServicesPanelSnapshot['pendingActions']
  /** Run one lifecycle verb on the service at the revision the panel observed. */
  readonly control: ProjectServicesPanelInjected['control']
  /** Open the service's inline log viewer. */
  readonly openLogs: ProjectServicesPanelInjected['openLogs']
  /** Translate a key of the `projectServices` dictionary. */
  readonly t: TranslateNS<'projectServices'>
}

/**
 * Render one service card's action row.
 * @param props - the card's service, the verbs in flight, the panel's verbs, and the namespace's `t`.
 * @returns the action row element.
 */
export function ServiceCardActions({
  item,
  pendingActions,
  control,
  openLogs,
  t,
}: ServiceCardActionsProps): ReactNode {
  return (
    <div className={css.cardRight}>
      {item.actions.includes('start') && item.state !== 'running' && (
        <Button
          size="sm"
          variant="primary"
          disabled={pendingActions[item.id] !== undefined}
          onClick={() => { void control('start', item.id, item.revision) }}
          data-testid={`action-start-${item.id}`}
        >
          {t('action.start')}
        </Button>
      )}
      {item.actions.includes('stop') && item.state === 'running' && (
        <Button
          size="sm"
          variant="outline"
          disabled={pendingActions[item.id] !== undefined}
          onClick={() => { void control('stop', item.id, item.revision) }}
          data-testid={`action-stop-${item.id}`}
        >
          {t('action.stop')}
        </Button>
      )}
      {item.actions.includes('restart') && item.state === 'running' && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pendingActions[item.id] !== undefined}
          onClick={() => { void control('restart', item.id, item.revision) }}
          data-testid={`action-restart-${item.id}`}
        >
          {t('action.restart')}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => { openLogs(item.id) }}
        data-testid={`action-logs-${item.id}`}
      >
        {t('action.logs')}
      </Button>
    </div>
  )
}
