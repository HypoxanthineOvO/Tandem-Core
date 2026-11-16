// @vitest-environment jsdom
/** Branch receipt for `continuity_commit` calls. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  ContinuityReceiptRow, receiptArgs, receiptClauses, receiptConflictKeys, receiptState, type ContinuityReceiptRowProps,
} from '../src/client/continuity/ContinuityReceiptRow.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ContinuityReceiptRowProps['t'] = makeTranslate(zh)
const tEn: ContinuityReceiptRowProps['t'] = makeTranslate(en)

/** Stage props for one call; the fixture fills only what the view reads. */
function stage(value: object): ContinuityReceiptRowProps {
  return value as never
}

const ARGS = JSON.stringify({
  event_id: 'e1', base_rev: 2, reason: '校准顺延约 2 小时',
  patch: [
    { key: 'branch.schedule.deadline', before: '10:00', after: '12:00' },
    { key: 'branch.schedule.owner', after: null },
    { key: 'branch.schedule.steps', after: ['a'] },
    { key: 'branch.schedule.retry', after: 2 },
    'bad',
  ],
})

function result(text: string, over: Record<string, unknown> = {}, args: string | null = ARGS): ContinuityReceiptRowProps {
  return {
    phase: 'result',
    block: {
      kind: 'tool-result', callId: 'c', name: 'continuity_commit',
      call: args === null ? null : { name: 'continuity_commit', argsRaw: args },
      content: [{ type: 'text', text }, { type: 'image' }], isError: false, subCalls: [], ...over,
    },
    t,
  } as never
}

describe('ContinuityReceiptRow', () => {
  it('reads "recorded for this group | sent to the main line: reason" and expands to the changed fields', () => {
    render(<ContinuityReceiptRow {...result('continuity commit e1: wake-queued')} />)
    const row = screen.getByLabelText('决议回执')
    expect(row.getAttribute('data-state')).toBe('wake-queued')
    expect(screen.getByText('已记入本组')).toBeTruthy()
    expect(screen.getByText('已推送主线：校准顺延约 2 小时')).toBeTruthy()
    expect(screen.getByText('｜')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('改动内容')).toBeTruthy()
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'branch.schedule.deadline12:00', 'branch.schedule.owner已清除', 'branch.schedule.steps已更新', 'branch.schedule.retry2',
    ])
  })

  it('prefers structured metadata, names a conflict, and explains it when expanded', () => {
    render(<ContinuityReceiptRow {...result('unrelated', { meta: { state: 'conflict', conflictKeys: ['branch.plan', 3] } }, JSON.stringify({ reason: 'R' }))} />)
    expect(screen.getByText('版本冲突，未记入')).toBeTruthy()
    expect(screen.getByText('R')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('主线内容已更新，需要重新读取后再提交。')).toBeTruthy()
    expect(screen.getByText('需重新读取')).toBeTruthy()
    expect(screen.getByText('branch.plan')).toBeTruthy()
    expect(screen.queryByText('改动内容')).toBeNull()
  })

  it('shows a running row while the call is in flight and a failed row for an error result', () => {
    const running = render(<ContinuityReceiptRow {...stage({ phase: 'start', block: { argsRaw: '{"reason":' }, t })} />)
    expect(screen.getByText('正在提交决议')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    running.unmount()
    const preparing = render(<ContinuityReceiptRow {...stage({ phase: 'preparing', block: {}, t })} />)
    expect(screen.getByText('正在提交决议')).toBeTruthy()
    preparing.unmount()
    render(<ContinuityReceiptRow {...result('boom', { isError: true }, null)} />)
    expect(screen.getByText('提交失败，未记入')).toBeTruthy()
  })

  it('treats an unreadable result as a failed submission', () => {
    render(<ContinuityReceiptRow {...result('no state here')} />)
    expect(screen.getByText('提交失败，未记入')).toBeTruthy()
  })
})

describe('receipt helpers', () => {
  it('reads the displayed argument parts and tolerates partial JSON', () => {
    expect(receiptArgs('{"reason":"R","proposal":true,"patch":[{"key":"k","after":1}]}'))
      .toEqual({ reason: 'R', proposal: true, fields: [{ key: 'k', after: 1 }] })
    expect(receiptArgs('[1]')).toEqual({ reason: '', proposal: false, fields: [] })
    expect(receiptArgs('{"reason":2,"patch":"no"}')).toEqual({ reason: '', proposal: false, fields: [] })
  })

  it('reads conflict keys only from well-formed metadata', () => {
    expect(receiptConflictKeys({ conflictKeys: ['a', 1] })).toEqual(['a'])
    expect(receiptConflictKeys({ conflictKeys: 'a' })).toEqual([])
    expect(receiptConflictKeys(undefined)).toEqual([])
  })

  it('reads the state from metadata or the end of the rendered line', () => {
    expect(receiptState({ state: 'deferred' }, '')).toBe('deferred')
    expect(receiptState({ state: 'bogus' }, 'continuity commit e: no-op')).toBe('no-op')
    expect(receiptState(null, 'continuity commit e: bogus')).toBeUndefined()
    expect(receiptState(undefined, '')).toBeUndefined()
  })

  it.each([
    ['committed-local', false, { title: 'Recorded for this group', detail: 'Main line unchanged' }],
    ['deferred', false, { title: 'Recorded for this group', detail: 'Waiting for the main line' }],
    ['deferred', true, { title: 'Recorded for this group', detail: 'Waiting for main-line confirmation' }],
    ['wake-queued', true, { title: 'Recorded for this group', detail: 'Waiting for main-line confirmation' }],
    ['duplicate', false, { title: 'Already recorded' }],
    ['no-op', false, { title: 'No change; not recorded' }],
    ['commit-uncertain', false, { title: 'Submission not confirmed yet; check again later' }],
  ] as const)('describes %s (proposal %s)', (state, proposal, expected) => {
    expect(receiptClauses(state, proposal, tEn)).toEqual(expected)
  })
})
