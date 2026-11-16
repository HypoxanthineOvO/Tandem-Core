/**
 * Composer chip for the durable conversational mode.
 *
 * The `sessionMode` projection is the only authority for the current mode: a
 * click asks the Host to persist the switch, and the pushed projection frame
 * repaints the chip. The chip never guesses the new mode locally, so a phrase
 * or another Peer switching the same Session stays consistent with it.
 */
import { useEffect, useRef, useState } from 'react'
import type { SessionMode } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  IconUserOutlineRegular, IconUsersOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the session standard props (sessionId, useSession, useProjection, useAccess).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { NS } from './locales.ts'
import css from './SessionModeControl.module.css'

/** Registration-side business face of the composer mode seat. */
export interface SessionModeInjected {
  /**
   * Persist one mode switch for the bound Session.
   * @param mode - target conversational mode.
   * @returns completion; a business or transport failure rejects.
   */
  setMode: (mode: SessionMode) => Promise<void>
}

/** Full props of the composer mode chip. */
export type SessionModeChipProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<SessionModeInjected>
  & PropsLocale<typeof NS>

/** The other mode a click selects; the chip is a two-state switch, not a picker. */
const NEXT_MODE: Record<SessionMode, SessionMode> = { work: 'direct', direct: 'work' }

/**
 * Render the current mode and switch it on click.
 * @param props - Session identity, the mode projection, access, and the switch callback.
 * @returns the chip, or null inside an addressed subagent conversation.
 */
export function SessionModeChip({
  useSession, useProjection, useAccess, setMode, t,
}: SessionModeChipProps) {
  // New Sessions start in work mode: the projection may precede its first frame.
  const mode = useProjection('sessionMode')?.mode ?? 'work'
  const subagent = useSession(snapshot => snapshot.subagent)
  const allowed = useAccess('sessionMode/set')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Subagent conversations run their own delegated prompt; the main-line mode does not apply.
  if (subagent !== null) return null

  const next = NEXT_MODE[mode]
  const currentLabel = t(mode === 'work' ? 'mode.work' : 'mode.direct')
  const nextLabel = t(next === 'work' ? 'mode.work' : 'mode.direct')

  const toggle = (): void => {
    if (saving) return
    setSaving(true)
    setError(null)
    void setMode(next).then(() => {
      if (aliveRef.current) setSaving(false)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setSaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={css.chip}
        aria-label={t('chip.aria', { mode: currentLabel, next: nextLabel })}
        title={t('chip.aria', { mode: currentLabel, next: nextLabel })}
        disabled={!allowed || saving}
        onClick={toggle}
      >
        <span className={css.glyph} aria-hidden>
          {mode === 'work' ? <IconUsersOutlineRegular size={14} /> : <IconUserOutlineRegular size={14} />}
        </span>
        <span className={css.label}>{currentLabel}</span>
      </button>
      {error !== null && <span className={css.error} role="status" title={error}>{t('chip.failed')}</span>}
    </span>
  )
}
