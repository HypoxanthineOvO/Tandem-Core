// @vitest-environment jsdom
/**
 * Real Loader composition: the ui-subagent row boots inside the web roster and
 * registers its branch action on the conversation seat. Clicking that action
 * must send the bring-back phrase through the Session face; the unit suite
 * missed the original regression because it supplied the service directly
 * instead of exercising the plugin's declared injections.
 */
import type { ReactElement } from 'react'
import { describe, expect, onTestFinished } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ok, openStream } from '@deepseek-ai/dsh-remote-mock'
import type { ContinuityStatus } from '@deepseek-ai/dsh-subagent/continuity-types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BringBackButtonProps } from '../src/client/continuity/BringBackButton.tsx'
import { BRING_BACK_COMMAND, zh } from '../src/client/locales.ts'

const it = createClientTest({ roster: webApp })
/** The whole roster's first boot pays the cold module transform of every plugin package. */
const COLD_BOOT_TIMEOUT_MS = 60_000
const PARENT = 'composition-parent' as SessionId
const BRANCH = 'composition-branch' as SessionId
const ADDRESS = { parentSessionId: PARENT, childSessionId: BRANCH, mode: 'continuable' } as const
const t: BringBackButtonProps['t'] = makeTranslate(zh)

/** Resolve a session-scoped inject face the registry types as an erased factory. */
function resolveFace<T>(entry: { inject?: ((...args: never[]) => Record<string, unknown>) | undefined }): (sessionId: SessionId) => T {
  const face = entry.inject
  if (face === undefined) throw new Error('registration has no inject face')
  return face as NonNullable<typeof face> & ((sessionId: SessionId) => T)
}

function branchStatus(): ContinuityStatus {
  return {
    enabled: true,
    mainSessionId: PARENT,
    branchSessionId: BRANCH,
    ledgerRev: 1,
    pendingCount: 0,
    pendingWakeCount: 0,
  }
}

/** The opening follow snapshot: an empty child log with no projections yet. */
const FOLLOW_SNAPSHOT = {
  type: 'snapshot' as const,
  header: {
    version: 1,
    id: BRANCH,
    createdAt: 1,
    parentSession: PARENT,
    isSeeded: false,
    origin: 'subagent' as const,
  },
  cursor: -1,
  records: [],
  hasMore: false,
  projections: { asOfSeq: -1, values: {} },
}

describe('ui-subagent bring-back action in the assembled web client', () => {
  it('sends the phrase from the composed branch action', async ({ mock, start }) => {
    mock.unary('session/page', () => ok({ records: [], hasMore: false }))
    mock.stream('session/follow', openStream([FOLLOW_SNAPSHOT]))
    mock.unary('subagents/continuityStatus', () => ok(branchStatus()))
    mock.unary('subagents/prompt', () => ok({ messageId: 'message-1' }))

    const c = await start()
    const reference = c.ctx.sessions.retain(ADDRESS, { source: 'controllerOperation' })
    onTestFinished(() => { reference.release() })
    await waitFor(() => { expect(c.ctx.sessions.binding(BRANCH)).toBeDefined() })

    // The entry and its injected face come from the Loader-composed plugin, not a
    // hand-built registry; the old `ctx.conversation` access threw here.
    const entry = c.ctx.slots.entries('conversation.input.right')
      .find(candidate => candidate.options.id === 'continuity-bring-back')
    expect(entry).toBeDefined()
    const face = resolveFace<{
      hooks: { continuityPending: {
        getSnapshot(): { role: string }
        subscribe(listener: () => void): () => void
      } }
      bringBack: () => Promise<void>
    }>(entry!)(BRANCH)
    const unsubscribe = face.hooks.continuityPending.subscribe(() => {})
    onTestFinished(unsubscribe)
    await waitFor(() => { expect(face.hooks.continuityPending.getSnapshot().role).toBe('branch') })

    const Action = entry!.component as (props: BringBackButtonProps) => ReactElement
    const props: BringBackButtonProps = {
      sessionId: BRANCH,
      useSession: () => null,
      useProjection: () => undefined,
      useAccess: () => true,
      useContinuityPending: (selector: (value: unknown) => unknown) =>
        selector(face.hooks.continuityPending.getSnapshot()),
      bringBack: face.bringBack,
      t,
    } as never
    render(<Action {...props} />)
    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => {
      expect(mock.log.requests('subagents/prompt')).toMatchObject([{
        parentSessionId: PARENT,
        childSessionId: BRANCH,
        delivery: 'queue',
        content: [{ type: 'text', text: BRING_BACK_COMMAND }],
      }])
    })
  }, COLD_BOOT_TIMEOUT_MS)
})
