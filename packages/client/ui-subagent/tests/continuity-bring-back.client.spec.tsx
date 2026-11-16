// @vitest-environment jsdom
/** Branch bring-back action: managed-branch visibility, send, and failure copy. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { BringBackButton, type BringBackButtonProps } from '../src/client/continuity/BringBackButton.tsx'
import type { PendingSnapshot } from '../src/client/continuity/pending-source.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: BringBackButtonProps['t'] = makeTranslate(zh)
const tEn: BringBackButtonProps['t'] = makeTranslate(en)

const MAIN: PendingSnapshot = {
  mainSessionId: 'main', role: 'main', count: 0, rows: [], processNow: 'idle',
}
const BRANCH: PendingSnapshot = {
  mainSessionId: 'main', role: 'branch', count: 0, rows: [], processNow: 'idle',
}
const NONE: PendingSnapshot = {
  mainSessionId: undefined, role: 'none', count: 0, rows: [], processNow: 'idle',
}

function setup(
  snapshot: PendingSnapshot,
  options: { bringBack?: BringBackButtonProps['bringBack']; t?: BringBackButtonProps['t'] } = {},
) {
  const store = createSnapshotStore<PendingSnapshot>(snapshot)
  const bringBack = options.bringBack ?? vi.fn(async () => {})
  const props: BringBackButtonProps = {
    useContinuityPending: bindSnapshotSelector(store),
    bringBack,
    t: options.t ?? t,
  } as never
  const view = render(<BringBackButton {...props} />)
  return { store, bringBack, view }
}

const button = () => screen.getByRole('button', { name: '请支线把已确认的结论整理成决议带回主线' })

describe('BringBackButton', () => {
  it.each([['main', MAIN], ['unbound', NONE]] as const)('renders nothing on a %s Session', (_kind, snapshot) => {
    const { view } = setup(snapshot)
    expect(view.container.innerHTML).toBe('')
  })

  it('sends the bring-back phrase from a managed branch', () => {
    const { bringBack } = setup(BRANCH)
    expect(button().textContent).toBe('带回主线')
    fireEvent.click(button())
    expect(bringBack).toHaveBeenCalledOnce()
  })

  it('disables the action while the phrase is being sent', async () => {
    let settle!: () => void
    const bringBack = vi.fn(() => new Promise<void>((done) => { settle = done }))
    setup(BRANCH, { bringBack })
    fireEvent.click(button())
    expect((button() as HTMLButtonElement).disabled).toBe(true)
    expect(button().textContent).toBe('正在发送')
    fireEvent.click(button())
    expect(bringBack).toHaveBeenCalledOnce()
    settle()
    await waitFor(() => { expect((button() as HTMLButtonElement).disabled).toBe(false) })
  })

  it('keeps the action available and names the failure', async () => {
    const bringBack = vi.fn(async () => { throw new Error('socket closed') })
    setup(BRANCH, { bringBack })
    fireEvent.click(button())
    const failure = await screen.findByText('发送失败，请重试')
    expect(failure.getAttribute('title')).toBe('socket closed')
    expect((button() as HTMLButtonElement).disabled).toBe(false)
  })

  it('follows the localized label and becomes the action when the binding appears', async () => {
    const store = createSnapshotStore<PendingSnapshot>(NONE)
    const props: BringBackButtonProps = {
      useContinuityPending: bindSnapshotSelector(store),
      bringBack: vi.fn(async () => {}),
      t: tEn,
    } as never
    render(<BringBackButton {...props} />)
    expect(screen.queryByRole('button')).toBeNull()
    store.set({ ...BRANCH, role: 'branch' })
    const label = await screen.findByRole('button', { name: 'Ask this branch to turn confirmed conclusions into decisions for the main line' })
    expect(label.textContent).toBe('Bring back to main')
  })
})
