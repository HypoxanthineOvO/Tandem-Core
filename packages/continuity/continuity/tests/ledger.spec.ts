import { describe, expect, it } from 'vitest'
import {
  authorizeEffect, classifyReturn, commitToLedger, foldLedgerEvents, initialLedger,
  observeContext, registerRead, renderFixedArea,
} from '../src/index.ts'
import type { CommitInput, LedgerState } from '../src/index.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session'

const base = initialLedger('main', 'branch')

function commit(state: LedgerState, eventId: string, key: string, after: unknown, extra: Partial<CommitInput> = {}): ReturnType<typeof commitToLedger> {
  return commitToLedger(state, {
    eventId,
    baseRev: state.rev,
    actor: { kind: 'agent', id: 'branch' },
    source: { sessionId: 'branch', turnId: '1' },
    patch: [{ key, before: state.fields[key], after }],
    reason: `set ${key}`,
    at: 1,
    ...extra,
  })
}

describe('continuity ledger', () => {
  it('commits once and replays idempotently from the emitted event', () => {
    const first = commit(base, 'event-1', 'schedule.deadline', '2026-10-31')
    expect(first.kind).toBe('committed')
    if (first.transaction === undefined) throw new Error('missing transaction')
    const again = commitToLedger(first.state, commitInputOf(first.state, 'event-1', 'schedule.deadline', '2026-10-31'))
    expect(again.kind).toBe('duplicate')
    const replayed = foldLedgerEvents('main', [
      { type: 'continuity/transaction', seq: SessionSeq(0), time: 1, data: first.transaction },
    ], 'branch')
    expect(replayed.rev).toBe(first.state.rev)
    expect(replayed.fields).toEqual(first.state.fields)
    expect(commitToLedger(replayed, commitInputOf(replayed, 'event-1', 'schedule.deadline', '2026-10-31')).kind).toBe('duplicate')
  })

  it('conflicts on reused event id, stale base rev, and stale before values', () => {
    const first = commit(base, 'event-1', 'budget.tokens', 100).state
    expect(commitToLedger(first, { ...commitInputOf(first, 'event-1'), patch: [{ key: 'budget.tokens', before: 0, after: 200 }] }).kind).toBe('conflict')
    const stale = commitToLedger(first, { ...commitInputOf(first, 'event-2'), baseRev: 0, patch: [{ key: 'budget.tokens', before: 100, after: 200 }] })
    expect(stale.kind).toBe('conflict')
    const wrongBefore = commitToLedger(first, { ...commitInputOf(first, 'event-2'), patch: [{ key: 'budget.tokens', before: 99, after: 200 }] })
    expect(wrongBefore.kind).toBe('conflict')
  })

  it('classifies defer, wake, and ledger-only returns', () => {
    const read = registerRead(base, 'decision-1', ['schedule.deadline'])
    expect(classifyReturn(read, ['goal.scope'])).toBe('defer')
    expect(classifyReturn(read, ['schedule.deadline'])).toBe('wake')
    expect(classifyReturn(read, ['notes.detail'])).toBe('none')
    const proposal = commit(base, 'event-p', 'interface.other', 'changed', { proposal: true })
    expect(proposal.transaction?.inboxItem?.mode).toBe('defer')
  })

  it('authorizes managed effects only while the observation baseline is current', () => {
    const observed = observeContext(base, base.rev)
    expect(authorizeEffect(observed, observed.rev).ok).toBe(true)
    const advanced = commit(observed, 'event-1', 'budget.tokens', 10).state
    expect(authorizeEffect(advanced, observed.contextObservedRev).ok).toBe(false)
    expect(authorizeEffect(advanced, advanced.rev).ok).toBe(true)
  })

  it('restores complete work-item changes and acceptance semantics from transactions', () => {
    const open = {
      id: 'work-1',
      sourceRefs: ['branch:event-1'],
      owner: { kind: 'agent' as const, id: 'branch' },
      acceptance: ['deliver report'],
      closePolicy: 'user-accept' as const,
      taskRefs: ['t1'],
    }
    const opened = commit(base, 'event-1', 'goal.scope', 'phase 1', { workItem: open })
    expect(opened.kind).toBe('committed')
    const closed = {
      ...open,
      acceptedAt: 123,
    }
    const accepted = commit(opened.state, 'event-2', 'risk.note', 'closed', { workItem: closed })
    expect(accepted.kind).toBe('committed')
    const events = [opened.transaction!, accepted.transaction!]
      .map((transaction, index) => ({ type: 'continuity/transaction' as const, seq: SessionSeq(index), time: index + 1, data: transaction }))
    const replayed = foldLedgerEvents('main', events, 'branch')
    expect(replayed.workItems['work-1']).toEqual(closed)
    expect(replayed.workItems['work-1']?.acceptedAt).toBe(123)
    expect(renderFixedArea(replayed).text).not.toContain('work-1')
  })

  it('renders deterministically and degrades oldest decision detail under budget', () => {
    let state = base
    for (let index = 0; index < 8; index += 1) state = commit(state, `event-${index}`, `risk.note.${index}`, `note-${index}-${'x'.repeat(80)}`).state
    const full = renderFixedArea(state)
    expect(renderFixedArea(state).hash).toBe(full.hash)
    const limited = renderFixedArea(state, { tokenBudget: 120 })
    expect(limited.truncated).toBe(true)
    expect(limited.text).toContain('[truncated]')
    expect(limited.text).toContain('risk.note.7')
    expect(renderFixedArea(state, { tokenBudget: 120 }).hash).toBe(limited.hash)
  })
})

function commitInputOf(state: LedgerState, eventId: string, key = 'budget.tokens', after: unknown = 100): CommitInput {
  return {
    eventId,
    baseRev: state.rev,
    actor: { kind: 'agent', id: 'branch' },
    source: { sessionId: 'branch', turnId: '1' },
    patch: [{ key, before: state.fields[key], after }],
    reason: `set ${key}`,
    at: 1,
  }
}
