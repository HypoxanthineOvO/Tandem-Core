import { describe, expect, it } from 'vitest'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createSettlementMessage, settlementModelNotice } from '../src/continuation-messages.ts'

const childId = SessionId('settled-child')
const summary = { type: 'text', text: `Background subagent ${childId} finished and will do no further work unless you send it more.` }
const reasoning: ContentBlock = { type: 'reasoning', text: 'private child reasoning' }
const toolCall: ContentBlock = { type: 'tool-call', id: ToolCallId('child-call'), name: 'read', arguments: '{}' }

describe('continuable settlement content', () => {
  it.each([
    ['reasoning before the answer', [reasoning, { type: 'text', text: 'answer' }]],
    ['a tool call after the answer', [{ type: 'text', text: 'answer' }, toolCall]],
  ] satisfies [string, ContentBlock[]][])('reports only the closing text with %s', (_label, output) => {
    const original = structuredClone(output)
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
    ])
    expect(output).toEqual(original)
  })

  it.each([
    ['empty output', []],
    ['reasoning-only output', [reasoning]],
    ['empty text', [{ type: 'text', text: '' }]],
  ] satisfies [string, ContentBlock[]][])('reports no closing message for %s', (_label, output) => {
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('preserves text block order and bytes around omitted reasoning and tool calls', () => {
    const first: ContentBlock = { type: 'text', text: '  first\n' }
    const second: ContentBlock = { type: 'text', text: '\n第二段  ' }
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [reasoning, first, toolCall, second],
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })
})

it('pins verified, fallback, and unavailable model identity lines after the result', () => {
  const session = Session.create(childId)
  const child = { session, options: { provider: 'primary', model: 'preferred' } } as Agent
  expect(settlementModelNotice(child)).toMatchInlineSnapshot(`"实际模型：未核验（子会话没有实际请求记录）。"`)
  session.append('request/context', { provider: 'primary', model: 'preferred' })
  expect(settlementModelNotice(child)).toMatchInlineSnapshot(`"实际模型：primary/preferred。"`)
  session.append('request/context', { provider: 'backup', model: 'actual' })
  const notice = settlementModelNotice(child)
  expect(notice).toMatchInlineSnapshot(`"实际模型：backup/actual（备用；选定模型：primary/preferred）。"`)
  const message = createSettlementMessage(childId, { stopReason: 'completed', output: [{ type: 'text', text: 'answer' }] }, true, notice)
  expect(message.content.at(-1)).toEqual({ type: 'text', text: notice })
  expect(settlementModelNotice()).toMatchInlineSnapshot(`"实际模型：未核验（外部子代理未提供实际请求记录）。"`)
})

it('keeps physical route text while an optional policy controls fallback attribution', () => {
  const session = Session.create(childId)
  const child = { session, options: { provider: 'anthropic', model: 'claude-opus-5-5' } } as Agent
  const equivalence = {
    isSameRoute: (selected: { provider: string; model: string }, actual: { provider: string; model: string }) =>
      selected.provider === actual.provider && selected.model === actual.model.replace(/^cpa[1-5]\//, ''),
  }
  session.append('request/context', { provider: 'anthropic', model: 'cpa1/claude-opus-5-5' })
  expect(settlementModelNotice(child, equivalence)).toMatchInlineSnapshot(`"实际模型：anthropic/cpa1/claude-opus-5-5。"`)
  expect(settlementModelNotice(child)).toMatchInlineSnapshot(`"实际模型：anthropic/cpa1/claude-opus-5-5（备用；选定模型：anthropic/claude-opus-5-5）。"`)
  session.append('request/context', { provider: 'example-provider', model: 'example-model' })
  expect(settlementModelNotice(child, equivalence)).toMatchInlineSnapshot(`"实际模型：example-provider/example-model（备用；选定模型：anthropic/claude-opus-5-5）。"`)
})

it('includes closing text alongside structured results and diagnostics', () => {
  expect(createSettlementMessage(childId, {
    stopReason: 'completed', output: [{ type: 'text', text: 'final answer' }],
    structured: { answer: 42 }, diagnostic: 'safe diagnostic',
  }).content).toEqual([
    summary,
    { type: 'text', text: 'Its closing message:' },
    { type: 'text', text: 'final answer' },
    { type: 'text', text: 'Structured result: {"answer":42}' },
    { type: 'text', text: 'safe diagnostic' },
  ])
})
