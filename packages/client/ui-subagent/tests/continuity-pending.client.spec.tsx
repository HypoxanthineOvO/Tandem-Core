// @vitest-environment jsdom
/** Continuity status source and the main-line pending strip it feeds. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContinuityPendingItem, ContinuityStatus } from '@deepseek-ai/dsh-subagent/continuity-types'
import {
  ContinuityPendingDock, type ContinuityPendingDockProps,
} from '../src/client/continuity/ContinuityPendingDock.tsx'
import {
  ContinuityPendingSource, type PendingSnapshot,
} from '../src/client/continuity/pending-source.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t: ContinuityPendingDockProps['t'] = makeTranslate(zh)
const tEn: ContinuityPendingDockProps['t'] = makeTranslate(en)
const MAIN = 'main-session' as SessionId
const BRANCH = 'branch-1' as SessionId

function item(id: string, summary: string, over: Partial<ContinuityPendingItem> = {}): ContinuityPendingItem {
  return {
    id, eventId: `event-${id}`, kind: 'decision', recipient: MAIN, summary, impactKeys: ['branch.plan'],
    mode: 'defer', dedupeKey: id, committedAt: 1, ...over,
  }
}

function status(over: Partial<ContinuityStatus> = {}): ContinuityStatus {
  return { enabled: true, mainSessionId: MAIN, ledgerRev: 3, pendingCount: 0, pendingWakeCount: 0, ...over }
}

const ok = <T,>(value: T) => ({ ok: true as const, value })
const failure = () => ({ ok: false as const, error: { code: 'remote/unavailable', message: 'offline' } })

/** A Remote whose answers each test sets; every call is recorded. */
function fakeRemote(state: { status: ContinuityStatus; items: readonly ContinuityPendingItem[] }) {
  const remote = {
    continuityStatus: vi.fn(async (_request?: { sessionId: SessionId }) => ok(state.status)),
    continuityPending: vi.fn(async (_limit?: number, _request?: { sessionId: SessionId }) => ok(state.items)),
    continuityProcessNow: vi.fn(async (_request: { requestId: string; sessionId?: SessionId }) => ok({ accepted: true, disposition: 'queued' as const })),
  }
  return remote
}

/** Let every queued Remote promise settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index++) await Promise.resolve()
  })
}

function dockProps(snapshot: PendingSnapshot, over: Partial<ContinuityPendingDockProps> = {}): ContinuityPendingDockProps {
  return {
    sessionId: MAIN,
    useContinuityPending: (selector: (value: PendingSnapshot) => unknown) => selector(snapshot),
    processNow: vi.fn(),
    t,
    ...over,
  } as never
}

const SNAPSHOT: PendingSnapshot = {
  mainSessionId: MAIN,
  role: 'main',
  count: 3,
  rows: [
    { id: 'a', summary: '探针组改用方案 B', state: 'wake' },
    { id: 'b', summary: '校准顺延约 2 小时', state: 'delivering' },
    { id: 'c', summary: '接口字段改名', state: 'proposal' },
  ],
  processNow: 'idle',
}

const EMPTY_SNAPSHOT: PendingSnapshot = {
  mainSessionId: undefined, role: 'none', count: 0, rows: [], processNow: 'idle',
}

describe('ContinuityPendingDock', () => {
  it('takes no space without pending items or on another Session', () => {
    const empty = render(<ContinuityPendingDock {...dockProps({ ...SNAPSHOT, count: 0, rows: [] })} />)
    expect(empty.container.innerHTML).toBe('')
    empty.unmount()
    const other = render(<ContinuityPendingDock {...dockProps(SNAPSHOT, { sessionId: 'branch' } as never)} />)
    expect(other.container.innerHTML).toBe('')
    const branch = render(<ContinuityPendingDock {...dockProps({ ...SNAPSHOT, role: 'branch' })} />)
    expect(branch.container.innerHTML).toBe('')
  })

  it('shows the count and first summary collapsed, then the list and the process-now action', () => {
    const processNow = vi.fn()
    render(<ContinuityPendingDock {...dockProps(SNAPSHOT, { processNow })} />)
    const strip = screen.getByTestId('continuity-pending')
    expect(strip.getAttribute('aria-label')).toBe('待带入主线的决议')
    expect(within(strip).getByText('待带入')).toBeTruthy()
    expect(within(strip).getByText('3 项：探针组改用方案 B')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('button', { name: '立即让主线处理' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const rows = screen.getAllByRole('listitem')
    expect(rows.map(row => row.textContent)).toEqual([
      '探针组改用方案 B需尽快处理', '校准顺延约 2 小时正在带入', '接口字段改名待主线确认',
    ])
    expect(rows.map(row => row.querySelector('[data-state]')?.getAttribute('data-state'))).toEqual(['warning', 'ongoing', 'warning'])
    fireEvent.click(screen.getByRole('button', { name: '立即让主线处理' }))
    expect(processNow).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.queryByRole('list')).toBeNull()
  })

  it.each([
    ['queued', '已请求主线处理'],
    ['next-step', '主线将在当前步骤后处理'],
    ['empty', '没有需要带入的内容'],
    ['failed', '请求未送达，请重试'],
  ] as const)('reports the %s outcome under the list', (processNow, text) => {
    render(<ContinuityPendingDock {...dockProps({ ...SNAPSHOT, processNow })} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('status').textContent).toBe(text)
  })

  it('shows the count alone while the list read has not returned rows', () => {
    render(<ContinuityPendingDock {...dockProps({ ...SNAPSHOT, count: 2, rows: [] })} />)
    expect(screen.getByText('2 项')).toBeTruthy()
  })

  it('disables the action while a request is in flight and names a deferred row', () => {
    render(<ContinuityPendingDock {...dockProps({
      ...SNAPSHOT, count: 1, rows: [{ id: 'd', summary: 'Later', state: 'defer' }], processNow: 'sending',
    }, { t: tEn })} />)
    expect(screen.getByText('1: Later')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect((screen.getByRole('button', { name: 'Process now' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('img', { name: 'Next turn' })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('ContinuityPendingSource', () => {
  it('reads the addressed main line while subscribed, polls, and stops on unsubscribe', async () => {
    vi.useFakeTimers()
    const state = { status: status({ pendingCount: 2 }), items: [item('a', 'First', { mode: 'wake' }), item('b', 'Second', { deliveredAt: 5 })] }
    const remote = fakeRemote(state)
    const source = new ContinuityPendingSource(remote, MAIN)
    expect(source.state.getSnapshot()).toEqual(EMPTY_SNAPSHOT)
    expect(remote.continuityStatus).not.toHaveBeenCalled()

    const listener = vi.fn()
    const unsubscribe = source.state.subscribe(listener)
    await settle()
    expect(remote.continuityStatus).toHaveBeenCalledWith({ sessionId: MAIN })
    expect(remote.continuityPending).toHaveBeenCalledWith(20, { sessionId: MAIN })
    expect(source.state.getSnapshot()).toEqual({
      mainSessionId: MAIN,
      role: 'main',
      count: 2,
      rows: [{ id: 'a', summary: 'First', state: 'wake' }, { id: 'b', summary: 'Second', state: 'delivering' }],
      processNow: 'idle',
    })
    expect(listener).toHaveBeenCalled()

    state.status = status({ pendingCount: 1 })
    state.items = [item('c', 'Proposal', { kind: 'proposal' })]
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(source.state.getSnapshot().rows).toEqual([{ id: 'c', summary: 'Proposal', state: 'proposal' }])

    unsubscribe()
    const calls = remote.continuityStatus.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(remote.continuityStatus.mock.calls.length).toBe(calls)
  })

  it('reports a managed branch role without reading the main pending list', async () => {
    const remote = fakeRemote({ status: status({ pendingCount: 4, branchSessionId: BRANCH }), items: [item('a', 'First')] })
    const source = new ContinuityPendingSource(remote, BRANCH)
    const unsubscribe = source.state.subscribe(() => {})
    await settle()
    expect(remote.continuityStatus).toHaveBeenCalledWith({ sessionId: BRANCH })
    expect(remote.continuityPending).not.toHaveBeenCalled()
    expect(source.state.getSnapshot()).toEqual({
      mainSessionId: MAIN, role: 'branch', count: 0, rows: [], processNow: 'idle',
    })
    unsubscribe()
    source.dispose()
  })

  it('keeps the last answer through failed reads and clears rows once nothing is pending', async () => {
    const state = { status: status({ pendingCount: 1 }), items: [item('a', 'First')] }
    const remote = fakeRemote(state)
    const source = new ContinuityPendingSource(remote, MAIN)
    const unsubscribe = source.state.subscribe(() => {})
    await settle()
    expect(source.state.getSnapshot().count).toBe(1)

    remote.continuityStatus.mockResolvedValueOnce(failure() as never)
    source.reset()
    await settle()
    expect(source.state.getSnapshot()).toEqual(EMPTY_SNAPSHOT)

    remote.continuityPending.mockResolvedValueOnce(failure() as never)
    unsubscribe()
    const again = source.state.subscribe(() => {})
    await settle()
    expect(source.state.getSnapshot().count).toBe(0)

    state.status = { enabled: false, ledgerRev: 0, pendingCount: 0, pendingWakeCount: 0 }
    again()
    const third = source.state.subscribe(() => {})
    await settle()
    expect(source.state.getSnapshot()).toEqual(EMPTY_SNAPSHOT)
    third()
    source.dispose()
  })

  it.each([
    ['queued', 'queued'],
    ['next-safe-step', 'next-step'],
    ['empty', 'empty'],
  ] as const)('maps a %s process-now disposition and re-reads', async (disposition, expected) => {
    const remote = fakeRemote({ status: status({ pendingCount: 1 }), items: [item('a', 'First')] })
    remote.continuityProcessNow.mockResolvedValueOnce(ok({ accepted: disposition !== 'empty', disposition }) as never)
    const ids = ['request-1']
    const source = new ContinuityPendingSource(remote, MAIN, () => ids.shift() ?? 'unexpected')
    const pending = source.processNow()
    expect(source.state.getSnapshot().processNow).toBe('sending')
    // A second press while the first is in flight is not sent.
    await source.processNow()
    await pending
    expect(remote.continuityProcessNow).toHaveBeenCalledOnce()
    expect(remote.continuityProcessNow).toHaveBeenCalledWith({ requestId: 'request-1', sessionId: MAIN })
    expect(source.state.getSnapshot().processNow).toBe(expected)
    expect(source.state.getSnapshot().count).toBe(1)
  })

  it('reports a failed request, retires the outcome when the list empties, and ignores late answers after dispose', async () => {
    const state = { status: status({ pendingCount: 1 }), items: [item('a', 'First')] }
    const remote = fakeRemote(state)
    remote.continuityProcessNow.mockResolvedValueOnce(failure() as never)
    const source = new ContinuityPendingSource(remote, MAIN)
    await source.processNow()
    expect(source.state.getSnapshot().processNow).toBe('failed')

    state.status = status({ pendingCount: 0 })
    const unsubscribe = source.state.subscribe(() => {})
    await settle()
    expect(source.state.getSnapshot().processNow).toBe('idle')
    unsubscribe()

    let release: (value: never) => void = () => {}
    remote.continuityProcessNow.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const late = source.processNow()
    source.dispose()
    release(ok({ accepted: true, disposition: 'queued' }) as never)
    await late
    expect(source.state.getSnapshot().processNow).toBe('sending')
  })

  it('keeps sending through an emptied list and drops a read that a reset superseded', async () => {
    const state = { status: status({ pendingCount: 0 }), items: [] as ContinuityPendingItem[] }
    const remote = fakeRemote(state)
    let releaseNow: (value: never) => void = () => {}
    remote.continuityProcessNow.mockImplementationOnce(() => new Promise(resolve => { releaseNow = resolve }))
    const source = new ContinuityPendingSource(remote, MAIN)
    const request = source.processNow()
    const unsubscribe = source.state.subscribe(() => {})
    await settle()
    expect(source.state.getSnapshot().processNow).toBe('sending')

    let releaseStatus: (value: never) => void = () => {}
    remote.continuityStatus.mockImplementationOnce(() => new Promise(resolve => { releaseStatus = resolve }))
    source.reset()
    source.reset()
    releaseStatus(ok(status({ pendingCount: 4 })) as never)
    await settle()
    expect(source.state.getSnapshot().count).toBe(0)

    state.status = status({ pendingCount: 1 })
    state.items = [item('x', 'X')]
    let releasePending: (value: never) => void = () => {}
    remote.continuityPending.mockImplementationOnce(() => new Promise(resolve => { releasePending = resolve }))
    unsubscribe()
    const next = source.state.subscribe(() => {})
    await settle()
    next()
    releasePending(ok([item('y', 'Y')]) as never)
    await settle()
    expect(source.state.getSnapshot().rows).toEqual([])
    releaseNow(ok({ accepted: true, disposition: 'queued' }) as never)
    await request
    source.dispose()
  })

  it('shares one read loop among subscribers and resets without subscribers by clearing only', async () => {
    const remote = fakeRemote({ status: status({ pendingCount: 1 }), items: [item('a', 'A')] })
    const source = new ContinuityPendingSource(remote, MAIN)
    source.reset()
    expect(remote.continuityStatus).not.toHaveBeenCalled()
    const first = source.state.subscribe(() => {})
    const second = source.state.subscribe(() => {})
    await settle()
    expect(remote.continuityStatus).toHaveBeenCalledOnce()
    first()
    second()
    source.dispose()
  })
})
