// @vitest-environment jsdom
/**
 * Real Loader composition for ui-session-mode: the row boots inside the web
 * roster, occupies the composer seat, and its injected face persists a switch
 * over the generated `sessionMode` Remote. The chip component is rendered from
 * the real registration so a click exercises the composed face.
 */
import type { ReactElement } from 'react'
import { describe, expect } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionMode } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionModeChipProps } from '../src/client/SessionModeControl.tsx'
import { zh } from '../src/client/locales.ts'

const it = createClientTest({ roster: webApp })
/** The whole roster's first boot pays the cold module transform of every plugin package. */
const COLD_BOOT_TIMEOUT_MS = 60_000
const SESSION = 'composition-mode' as SessionId
const t: SessionModeChipProps['t'] = makeTranslate(zh)

/** Resolve a session-scoped inject face the registry types as an erased factory. */
function resolveFace<T>(entry: { inject?: ((...args: never[]) => Record<string, unknown>) | undefined }): (sessionId: SessionId) => T {
  const face = entry.inject
  if (face === undefined) throw new Error('registration has no inject face')
  return face as NonNullable<typeof face> & ((sessionId: SessionId) => T)
}

describe('ui-session-mode in the assembled web client', () => {
  it('switches the mode from the composed composer chip', async ({ mock, start }) => {
    mock.unary('sessionMode/set', () => ok({ mode: 'direct' }))
    const c = await start()
    const entry = c.ctx.slots.entries('conversation.input.left')
      .find(candidate => candidate.options.id === 'session-mode')
    expect(entry).toBeDefined()
    const face = resolveFace<{ setMode: (mode: SessionMode) => Promise<void> }>(entry!)

    const Chip = entry!.component as (props: SessionModeChipProps) => ReactElement
    const props: SessionModeChipProps = {
      sessionId: SESSION,
      useSession: () => null,
      useProjection: () => ({ mode: 'work' }),
      useAccess: () => true,
      setMode: face(SESSION).setMode,
      t,
    } as never
    render(<Chip {...props} />)
    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => {
      expect(mock.log.requests('sessionMode/set')).toMatchObject([{ sessionId: SESSION, mode: 'direct' }])
    })
  }, COLD_BOOT_TIMEOUT_MS)
})
