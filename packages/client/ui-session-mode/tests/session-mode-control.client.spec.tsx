// @vitest-environment jsdom
/**
 * SessionModeChip over the `sessionMode` projection: the default work mode
 * before the first frame, a click that persists through the injected face,
 * the disabled read-only state, and the hidden subagent conversation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionMode } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionModeChip, type SessionModeChipProps, type SessionModeInjected } from '../src/client/SessionModeControl.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: SessionModeChipProps['t'] = makeTranslate(zh)
const SID = 's-mode' as SessionId

function setup(
  mode: SessionMode | undefined,
  options: {
    subagent?: SessionSnapshot['subagent']
    allowed?: boolean
    setMode?: SessionModeInjected['setMode']
  } = {},
) {
  const projection = createSnapshotStore<{ mode: SessionMode } | undefined>(
    mode === undefined ? undefined : { mode },
  )
  const session = createSnapshotStore<Pick<SessionSnapshot, 'subagent'>>({
    subagent: options.subagent === undefined ? null : options.subagent,
  })
  const setMode = options.setMode ?? vi.fn(async () => {})
  const useProjection = (_key: string, selector?: (value: unknown) => unknown) =>
    bindSnapshotSelector(projection)(value => (selector ?? (projected => projected))(value))
  const props: SessionModeChipProps = {
    sessionId: SID,
    useProjection,
    useSession: bindSnapshotSelector(session),
    useAccess: () => options.allowed !== false,
    setMode,
    t,
  } as never
  const view = render(<SessionModeChip {...props} />)
  return { projection, session, setMode, view }
}

const chip = () => screen.getByRole('button')

describe('SessionModeChip', () => {
  it('reports work mode before any projection frame arrives', () => {
    setup(undefined)
    expect(chip().textContent).toBe('工作模式')
    expect(chip().getAttribute('aria-label')).toBe('当前是工作模式，点击切换到直接模式')
  })

  it('follows the Host projection down after a recorded switch', async () => {
    const { setMode, projection } = setup('work')
    fireEvent.click(chip())
    expect(setMode).toHaveBeenCalledExactlyOnceWith('direct')
    projection.set({ mode: 'direct' })
    await waitFor(() => { expect(chip().textContent).toBe('直接模式') })
    expect(chip().getAttribute('aria-label')).toBe('当前是直接模式，点击切换到工作模式')
  })

  it('ignores a second click while the Host call is in flight', async () => {
    let settle!: () => void
    const setMode = vi.fn(() => new Promise<void>((done) => { settle = done }))
    setup('work', { setMode })
    fireEvent.click(chip())
    expect((chip() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(chip())
    expect(setMode).toHaveBeenCalledTimes(1)
    settle()
    await waitFor(() => { expect((chip() as HTMLButtonElement).disabled).toBe(false) })
  })

  it('reports a refused switch without changing the displayed mode', async () => {
    const setMode = vi.fn(async () => { throw new Error('session busy') })
    setup('work', { setMode })
    fireEvent.click(chip())
    const failure = await screen.findByText('切换模式失败')
    expect(failure.getAttribute('title')).toBe('session busy')
    expect(chip().textContent).toBe('工作模式')
  })

  it('renders nothing inside a subagent conversation', () => {
    const { view } = setup('work', {
      subagent: {
        address: {
          mode: 'continuable',
          childSessionId: SID,
          parentSessionId: 'main' as SessionId,
        },
      },
    })
    expect(view.container.innerHTML).toBe('')
  })

  it('disables the chip without access to the Remote method', () => {
    setup('work', { allowed: false })
    expect((chip() as HTMLButtonElement).disabled).toBe(true)
  })
})
