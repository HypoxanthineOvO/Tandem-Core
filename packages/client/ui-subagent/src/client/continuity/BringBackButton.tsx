/**
 * "Bring back to main" action for a managed branch conversation: it sends the
 * same user phrase the person could type, so the branch lays out its confirmed
 * decisions and the user confirms them before anything is submitted.
 *
 * The button renders only while the addressed Session is a managed branch; the
 * continuity source polls the Host status, and the binding can appear after
 * the conversation was opened.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.right seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NS } from '../locales.ts'
import type { PendingSnapshot } from './pending-source.ts'
import css from './Continuity.module.css'

/** Registrant face of the branch bring-back action. */
export interface BringBackInjected {
  hooks: { continuityPending: HostObservable<PendingSnapshot> }
  /** Send the bring-back phrase into this branch. */
  bringBack: () => Promise<void>
}

/** Full props of the branch bring-back action. */
export type BringBackButtonProps =
  PropsRuntime<'conversation.input.right'> & InjectFace<BringBackInjected> & PropsLocale<typeof NS>

/**
 * Render the bring-back action for a managed branch only.
 * @param props - the addressed Session's continuity snapshot and the send action.
 * @returns the button, or null on a main line or an unbound Session.
 */
export function BringBackButton({ useContinuityPending, bringBack, t }: BringBackButtonProps) {
  const snapshot = useContinuityPending(value => value)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  if (snapshot.role !== 'branch') return null

  const run = (): void => {
    if (sending) return
    setSending(true)
    setError(null)
    void bringBack().then(() => {
      if (aliveRef.current) setSending(false)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setSending(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.bringBackWrap}>
      <Button
        variant="outline"
        size="sm"
        icon={<IconBranchOutlineRegular />}
        aria-label={t('continuity.bringBack.aria')}
        title={t('continuity.bringBack.aria')}
        disabled={sending}
        onClick={run}
      >
        {t(sending ? 'continuity.bringBack.sending' : 'continuity.bringBack')}
      </Button>
      {error !== null && (
        <span className={css.bringBackOutcome} role="status" title={error}>
          {t('continuity.bringBack.failed')}
        </span>
      )}
    </span>
  )
}
