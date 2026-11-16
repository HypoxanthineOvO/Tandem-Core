// @vitest-environment jsdom
/** Main-line "synced" marker: event assembly into one Chat row and its rendering. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { messageDefinition } from '../../ui-chat/src/client/conversation-nodes/message.ts'
import { ConversationNodeAssembler } from '../../ui-conversation/src/client/conversation/assembler.ts'
import {
  ContinuitySyncedRow, syncedSummary, type ContinuitySyncedRowProps,
} from '../src/client/continuity/ContinuitySyncedRow.tsx'
import {
  ledgerIndexDefinition, syncedDefinition, type ContinuitySyncedData,
} from '../src/client/continuity/synced-definition.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ContinuitySyncedRowProps['t'] = makeTranslate(zh)
const tEn: ContinuitySyncedRowProps['t'] = makeTranslate(en)

function transaction(seq: number, inboxId: string | undefined, summary: string) {
  return {
    type: 'event' as const,
    event: {
      type: 'continuity/transaction', seq: SessionSeq(seq), time: seq,
      data: {
        eventId: `event-${seq}`,
        ...inboxId === undefined ? {} : {
          inboxItem: {
            id: inboxId, eventId: `event-${seq}`, kind: 'decision', recipient: 'main', summary,
            impactKeys: [], mode: 'defer', dedupeKey: inboxId, committedAt: seq,
          },
        },
      },
    } as never,
  }
}

const delivery = (seq: number, batchId: string, inboxIds: readonly string[]) => ({
  type: 'event' as const,
  event: {
    type: 'continuity/delivery', seq: SessionSeq(seq), time: seq,
    data: { batchId, inboxIds, ledgerRev: 2, turn: 1, step: 1, text: 'Continuity pending review:', textHash: 'h' },
  } as never,
})

const ack = (seq: number, batchId: string) => ({
  type: 'event' as const,
  event: { type: 'continuity/ack', seq: SessionSeq(seq), time: seq, data: { batchId, inboxIds: [], at: seq } } as never,
})

const deliveryMessage = (seq: number, batchId: string, text: string) => ({
  type: 'event' as const,
  event: {
    type: 'user/message', seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
    data: {
      id: `msg-${seq}`, role: 'user',
      source: { kind: 'continuity-delivery', batchId, ledgerRev: 2 },
      content: [{ type: 'text', text }],
    },
  } as never,
})

function assemble(entries: readonly ReturnType<typeof ack>[]): readonly ConversationViewNode[] {
  let chat: readonly ConversationViewNode[] = []
  const definitions = [messageDefinition, ledgerIndexDefinition, syncedDefinition]
  const assembler = new ConversationNodeAssembler(
    { entries: () => definitions, fallbackEntry: () => undefined },
    { entries: () => [{
      target: 'chat',
      create: () => ({
        empty: chat,
        replace: ({ nodes }) => (chat = nodes),
        apply: ({ upserts }) => (chat = [...chat.filter(node => !upserts.some(up => up.key === node.key)), ...upserts]),
      }),
    }] },
  )
  assembler.activateTarget('chat')
  assembler.replaceWindow(entries, false)
  assembler.flush()
  return chat
}

describe('syncedDefinition', () => {
  it('renders one acknowledged batch with ledger summaries and hides the model-facing batch text', () => {
    const chat = assemble([
      transaction(1, 'inbox-1', '探针组改用方案 B'),
      transaction(2, undefined, 'local only'),
      transaction(3, 'inbox-2', '校准顺延约 2 小时'),
      delivery(4, 'batch:3:event-1', ['inbox-1', 'inbox-2', 'inbox-gone']),
      deliveryMessage(5, 'batch:3:event-1', 'Continuity pending review:\n- [decision] ...'),
      ack(6, 'batch:3:event-1'),
    ])
    expect(chat.map(node => node.kind)).toEqual(['continuity-synced'])
    const node = chat[0] as ConversationViewNode & { data: ContinuitySyncedData; anchorSeq: number; groupTree?: string }
    expect(node.anchorSeq).toBe(4)
    expect(node.groupTree).toBe('input')
    expect(node.data).toEqual({ items: [
      { id: 'inbox-1', summary: '探针组改用方案 B' },
      { id: 'inbox-2', summary: '校准顺延约 2 小时' },
      { id: 'inbox-gone' },
    ] })
  })

  it('shows nothing before the acknowledgement and nothing for a wake or process-now trigger', () => {
    expect(assemble([
      transaction(1, 'inbox-1', 'A'),
      delivery(2, 'batch:1', ['inbox-1']),
      deliveryMessage(3, 'batch:1', 'Continuity pending review'),
    ])).toEqual([])
    expect(assemble([deliveryMessage(1, 'wake:event-1', 'Continuity wake: A')])).toEqual([])
  })

  it('keeps ordinary user messages to the generic projection and tolerates a repeated acknowledgement', () => {
    const plain = {
      type: 'event' as const,
      event: {
        type: 'user/message', seq: SessionSeq(1), time: 1, surfaceOp: 'append',
        data: { id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
      } as never,
    }
    expect(syncedDefinition.match(plain.event)).toBeNull()
    expect(syncedDefinition.match(deliveryMessage(2, 'b', 'x').event)).toEqual({ id: 'b', role: 'update', exclusive: true })
    const chat = assemble([plain, delivery(3, 'b', ['i']), ack(4, 'b'), ack(5, 'b')])
    expect(chat.map(node => node.kind)).toEqual(['user', 'continuity-synced'])
    expect(() => syncedDefinition.start({} as never, { event: ack(1, 'b').event } as never, { previous: () => undefined }))
      .toThrow('continuity-synced start requires continuity/delivery')
    expect(ledgerIndexDefinition.match(ack(1, 'b').event)).toBeNull()
    expect(ledgerIndexDefinition.update({ state: { summaries: {} } } as never, { event: ack(1, 'b').event } as never))
      .toEqual({ summaries: {} })
    expect(ledgerIndexDefinition.publication?.({} as never)).toBe('none')
  })

  it('places the row at an unresolved Location when its start carries none', () => {
    const state = { seq: 1, items: [{ id: 'i' }], acked: true }
    const node = syncedDefinition.buildViewNode!({ state, key: 'k', id: 'b', start: undefined } as never)
    expect((node as { location?: unknown } | null)?.location).toEqual({ kind: 'unresolved' })
    expect(syncedDefinition.buildViewNode!({ state: undefined } as never)).toBeNull()
  })
})

describe('ContinuitySyncedRow', () => {
  const node = (data: ContinuitySyncedData): ContinuitySyncedRowProps => ({ node: { data }, t }) as never

  it('summarizes the first decision with the total and expands to every decision', () => {
    render(<ContinuitySyncedRow {...node({ items: [
      { id: 'a', summary: '探针组' }, { id: 'b', summary: '校准顺延约 2 小时' },
    ] })} />)
    expect(screen.getByText('已同步')).toBeTruthy()
    expect(screen.getByText('探针组等 2 项')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['探针组', '校准顺延约 2 小时'])
  })

  it('names a single decision alone and counts decisions whose summary is not loaded', () => {
    expect(syncedSummary({ items: [{ id: 'a', summary: 'Only' }] }, tEn)).toBe('Only')
    expect(syncedSummary({ items: [{ id: 'a' }, { id: 'b' }] }, t)).toBe('2 项')
    expect(syncedSummary({ items: [{ id: 'a' }, { id: 'b', summary: 'Second' }] }, tEn)).toBe('Second and 2 items in total')
    render(<ContinuitySyncedRow {...node({ items: [{ id: 'a' }] })} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('listitem').textContent).toBe('一项决议')
  })
})
