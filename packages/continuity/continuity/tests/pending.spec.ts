import { expect, it } from 'vitest'
import { ackInbox, commitToLedger, initialLedger, selectPendingBatch } from '../src/ledger.ts'
import { DEFAULT_PENDING_NOTIFICATION_LIMITS, renderPendingDecisions } from '../src/pending.ts'

function ledger(values: readonly unknown[], keys = values.map((_, index) => `acceptance.value${index}`)) {
  let state = initialLedger('main', 'branch-A')
  for (const [index, after] of values.entries()) {
    state = commitToLedger(state, { eventId: `event-${index}`, baseRev: state.rev, actor: { kind: 'agent', id: 'branch-A' },
      source: { sessionId: 'branch-A', turnId: `turn-${index}` }, patch: [{ key: keys[index]!, before: null, after }], reason: '用户确认该字段', at: index }).state
  }
  return state
}

it('renders original before/after values, reason, source branch, and proposal status instead of summaries', () => {
  let state = ledger(['通过A'], ['acceptance.alpha'])
  state = commitToLedger(state, { eventId: 'proposal', baseRev: state.rev, actor: { kind: 'agent', id: 'branch-B' },
    source: { sessionId: 'branch-B', turnId: 'confirmed' }, patch: [{ key: 'acceptance.alpha', before: '通过A', after: false }, { key: 'budget.tokens', before: null, after: 0 }],
    reason: '另一支线建议调整', proposal: true, at: 1 }).state
  const items = selectPendingBatch(state, 16).map(item => ({ ...item, summary: '这不是字段值' }))
  expect(renderPendingDecisions(state, items, DEFAULT_PENDING_NOTIFICATION_LIMITS)).toMatchInlineSnapshot(`
    {
      "inboxIds": [
        "event-0:inbox",
        "proposal:inbox",
      ],
      "text": "待带入决议（字段值：前 → 后）：
    - 决议（版本 1）；来源支线："branch-A"
      "acceptance.alpha"：null → "通过A"
      原因："用户确认该字段"
    - 提案（尚未采纳）（版本 1）；来源支线："branch-B"
      "acceptance.alpha"："通过A" → false
      "budget.tokens"：null → 0
      原因："另一支线建议调整"",
    }
  `)
})

it.each([
  ['credential field', 'secret-field-value', 'acceptance.api_key'],
  ['nested credentials', { safe: ['retained', { password: 'secret-nested-value' }], apiKey: 'secret-object-value' }, 'acceptance.payload'],
  ['text assignments', 'api_key="secret-assignment-value" status=ok', 'acceptance.payload'],
  ['authorization', 'Authorization: Bearer secret-auth-value', 'acceptance.payload'],
  ['basic auth', 'Basic secret-basic-value', 'acceptance.payload'],
  ['URL credentials', 'https://secret-user:secret-password@example.invalid/?token=secret-query-value', 'acceptance.payload'],
  ['opaque prefixes', 'sk-secret-prefix-value eyJsecret.jwt.value', 'acceptance.payload'],
  ['quoted JSON', '{"refresh_token":"secret-json-value"}', 'acceptance.payload'],
  ['escaped JSON', String.raw`{\"client_secret\":\"secret-escaped-value\"}`, 'acceptance.payload'],
])('redacts %s without changing ledger values', (_name, value, key) => {
  const state = ledger([value], [String(key)])
  const original = JSON.stringify(state)
  const { text } = renderPendingDecisions(state, selectPendingBatch(state, 16), DEFAULT_PENDING_NOTIFICATION_LIMITS)
  expect(text).toContain('[已脱敏]')
  expect(text).not.toContain('secret-')
  expect(JSON.stringify(state)).toBe(original)
})

it('redacts a long credential before clipping, including reason and source labels', () => {
  const state = ledger(['token=' + 'secret'.repeat(1000)])
  const decision = Object.values(state.decisions)[0]!
  const attributed = { ...state, decisions: { [decision.id]: { ...decision, reason: 'password=secret-reason', source: { ...decision.source, sessionId: 'branch token=secret-source' } } } }
  const { text } = renderPendingDecisions(attributed, selectPendingBatch(state, 16), { valueMaxChars: 32, maxChars: 1000 })
  expect(text).toContain('token=[已脱敏]')
  expect(text).not.toContain('secret')
  expect(text).not.toContain('已截断')
});

it('keeps non-secret token counts, recursively renders objects, and preserves string escapes', () => {
  const state = ledger([123, { status: '通过', lines: ['first\nsecond'] }], ['budget.tokens', 'acceptance.detail'])
  const { text } = renderPendingDecisions(state, selectPendingBatch(state, 16), DEFAULT_PENDING_NOTIFICATION_LIMITS)
  expect(text).toContain('"budget.tokens"：null → 123')
  expect(text).toContain('{"lines":["first\\nsecond"],"status":"通过"}')
})

it('clips multibyte values only after redaction and includes the marker in each value budget', () => {
  const state = ledger(['🙂'.repeat(1000) + ' token=secret-tail'])
  const { text } = renderPendingDecisions(state, selectPendingBatch(state, 16), { valueMaxChars: 16, maxChars: 1000 })
  const value = text.split(' → ').at(-1)!.split('\n')[0]!
  expect(value.length).toBeLessThanOrEqual(16)
  expect(value).toContain('已截断')
  expect([...value].some(character => character.length === 1 && character.charCodeAt(0) >= 0xD800 && character.charCodeAt(0) <= 0xDFFF)).toBe(false)
  expect(text).not.toContain('secret-tail')
})

it('fits whole decisions in order, reserves the remainder footer, and leaves omitted inbox items pending', () => {
  const state = ledger(['one', 'two', 'six'])
  const items = selectPendingBatch(state, 16)
  const firstSize = renderPendingDecisions(state, items.slice(0, 1), DEFAULT_PENDING_NOTIFICATION_LIMITS).text.length
  const limits = { valueMaxChars: 512, maxChars: firstSize }
  const first = renderPendingDecisions(state, items, limits)
  expect(first.inboxIds).toEqual([items[0]!.id])
  expect(first.text.length).toBe(firstSize)
  expect(first.text).toContain('还有 2 条待带入，下次继续。')
  const next = ackInbox(state, first.inboxIds, 1)
  expect(selectPendingBatch(next, 16).map(item => item.id)).toEqual(items.slice(1).map(item => item.id))
  const second = renderPendingDecisions(next, selectPendingBatch(next, 16), limits)
  expect(second.inboxIds).toEqual([items[1]!.id])
  expect(second.text).toContain('还有 1 条待带入，下次继续。')
})

it('accepts the exact complete limit and fails only when one clipped decision cannot fit', () => {
  const state = ledger(['accepted'])
  const items = selectPendingBatch(state, 16)
  const result = renderPendingDecisions(state, items, DEFAULT_PENDING_NOTIFICATION_LIMITS)
  expect(renderPendingDecisions(state, items, { valueMaxChars: 512, maxChars: result.text.length }).text).toBe(result.text)
  expect(() => renderPendingDecisions(state, items, { valueMaxChars: 512, maxChars: result.text.length - 1 })).toThrow('单条待带入决议')
  expect(() => renderPendingDecisions(state, items, { valueMaxChars: 16, maxChars: 1 })).toThrow('单条待带入决议')
  expect(selectPendingBatch(state, 16)).toHaveLength(1)
})

it('does not substitute a summary when durable decision details are missing', () => {
  const state = ledger(['accepted'])
  expect(() => renderPendingDecisions({ ...state, decisions: {} }, selectPendingBatch(state, 16), DEFAULT_PENDING_NOTIFICATION_LIMITS)).toThrow('缺少原始字段改动')
})
