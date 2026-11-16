/** "Pending" strip above the main-line composer: decisions waiting to be brought into the main line. */
import { useState } from 'react'
import {
  Button, DockPanel, DockPanelItem, IconClockOutlineRegular, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from '../locales.ts'
import type { PendingRow, PendingSnapshot, ProcessNowState } from './pending-source.ts'
import css from './Continuity.module.css'

/** Registrant face of the pending dock. */
export interface ContinuityPendingInjected {
  hooks: { continuityPending: HostObservable<PendingSnapshot> }
  /** Ask the main line to take the pending batch now. */
  processNow: () => void
}

/** Full props of the dock entry. */
export type ContinuityPendingDockProps =
  PropsRuntime<'conversation.input.dock'> & PropsLocale<typeof NS> & InjectFace<ContinuityPendingInjected>

type Translate = ContinuityPendingDockProps['t']

const ROW_DOT: Record<PendingRow['state'], StateDotState> = {
  delivering: 'ongoing',
  wake: 'warning',
  defer: 'idle',
  proposal: 'warning',
}

function rowLabel(state: PendingRow['state'], t: Translate): string {
  switch (state) {
    case 'delivering': return t('continuity.pending.state.delivering')
    case 'wake': return t('continuity.pending.state.wake')
    case 'defer': return t('continuity.pending.state.defer')
    case 'proposal': return t('continuity.pending.state.proposal')
  }
}

function outcomeLabel(state: ProcessNowState, t: Translate): string | undefined {
  switch (state) {
    case 'idle':
    case 'sending': return undefined
    case 'queued': return t('continuity.processNow.queued')
    case 'next-step': return t('continuity.processNow.nextStep')
    case 'empty': return t('continuity.processNow.empty')
    case 'failed': return t('continuity.processNow.failed')
  }
}

/**
 * Render the pending strip for the bound main Session only. Nothing renders,
 * and no space is taken, while the Session has nothing pending.
 * @param props - Session identity, the pending source hook, and the process-now action.
 * @returns the strip, or null.
 */
export function ContinuityPendingDock({ sessionId, useContinuityPending, processNow, t }: ContinuityPendingDockProps) {
  const snapshot = useContinuityPending(value => value)
  const [open, setOpen] = useState(false)
  // The strip belongs to the addressed main line only; a managed branch shows
  // its own bring-back action instead.
  if (snapshot.role !== 'main' || snapshot.mainSessionId !== sessionId || snapshot.count === 0) return null
  const first = snapshot.rows[0]?.summary
  const outcome = outcomeLabel(snapshot.processNow, t)
  return (
    <DockPanel
      data-testid="continuity-pending"
      aria-label={t('continuity.pending.aria')}
      icon={<IconClockOutlineRegular />}
      title={t('continuity.pending.title')}
      summary={first === undefined
        ? t('continuity.pending.count', { count: snapshot.count })
        : t('continuity.pending.summary', { count: snapshot.count, first })}
      open={open}
      onToggle={() => { setOpen(value => !value) }}
      footer={(
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={snapshot.processNow === 'sending'}
            onClick={processNow}
          >
            {t('continuity.processNow')}
          </Button>
          {outcome !== undefined && <span className={css.outcome} role="status">{outcome}</span>}
        </>
      )}
    >
      {snapshot.rows.map(row => (
        <DockPanelItem
          key={row.id}
          data-state-kind={row.state}
          content={row.summary}
          trailing={rowLabel(row.state, t)}
          glyph={<span role="img" aria-label={rowLabel(row.state, t)}><StateDot state={ROW_DOT[row.state]} /></span>}
        />
      ))}
    </DockPanel>
  )
}
