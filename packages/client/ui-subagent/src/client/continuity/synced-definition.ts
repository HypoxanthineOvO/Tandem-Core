/**
 * Main-line "synced" marker: one Chat row per delivered pending batch, shown
 * once the Host has durably acknowledged it, at the top of the reply that took
 * the batch in. The rendered model-facing batch message never displays; the
 * row names the decisions it carried by their ledger summaries.
 */
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationNodeDefinition, ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-continuity/src/types.ts'

/** One standard or compact history event as a Definition receives it. */
type SessionEventLike = Parameters<ConversationNodeDefinition['match']>[0]

/** Renderer payload of one acknowledged batch. */
export interface ContinuitySyncedData {
  /** Carried decisions in delivery order; a summary is absent when its transaction is outside the loaded window. */
  readonly items: readonly { readonly id: string; readonly summary?: string }[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Acknowledged continuity batch at the top of the reply that consumed it. */
    'continuity-synced': ContinuitySyncedData
  }
}

/** Inbox id to summary, folded from every loaded ledger transaction. */
export interface LedgerSummaryIndex {
  readonly summaries: Readonly<Record<string, string>>
}

interface SyncedState {
  readonly seq: number
  readonly items: ContinuitySyncedData['items']
  readonly acked: boolean
}

/** Kind of the state-only ledger index Context. */
export const LEDGER_INDEX_KIND = 'continuity-ledger-index'

function indexTransaction(index: LedgerSummaryIndex, event: SessionEventLike): LedgerSummaryIndex {
  if (event.type !== 'continuity/transaction') return index
  const item = event.data.inboxItem
  if (item === undefined) return index
  return { summaries: { ...index.summaries, [item.id]: item.summary } }
}

/**
 * State-only index of inbox summaries. Every transaction joins the single
 * `ledger` Context: the earliest loaded one starts it and later ones update it.
 */
export const ledgerIndexDefinition: ConversationNodeDefinition<LedgerSummaryIndex> = {
  kind: LEDGER_INDEX_KIND,
  match: event => event.type === 'continuity/transaction' ? { id: 'ledger', role: 'start' } : null,
  start: (_context, match) => indexTransaction({ summaries: {} }, match.event),
  update: (context, match) => indexTransaction(context.state, match.event),
  publication: () => 'none',
}

/**
 * Read the batch id of a model-facing continuity message.
 * @param event - candidate event.
 * @returns the batch id, or undefined for every other event.
 */
function deliveryMessageBatch(event: SessionEventLike): string | undefined {
  if (event.type !== 'user/message') return undefined
  const source: { readonly kind?: unknown; readonly batchId?: unknown } = event.data.source
  return source.kind === 'continuity-delivery' && typeof source.batchId === 'string' ? source.batchId : undefined
}

function startState(match: ConversationStartMatch, index: LedgerSummaryIndex | undefined): SyncedState {
  const event = match.event
  if (event.type !== 'continuity/delivery') throw new Error('continuity-synced start requires continuity/delivery')
  const items = event.data.inboxIds.map((id) => {
    const summary = index?.summaries[id]
    return summary === undefined ? { id } : { id, summary }
  })
  return { seq: event.seq, items, acked: false }
}

/**
 * Delivery, acknowledgement, and the model-facing message of one batch share
 * the batch id. The message is claimed on the Chat target so its English
 * model text never renders; a trigger message without a delivery (wake or
 * process-now) stays pending and therefore also renders nothing.
 */
export const syncedDefinition: ConversationNodeDefinition<SyncedState> = {
  kind: 'continuity-synced',
  target: 'chat',
  match: (event) => {
    if (event.type === 'continuity/delivery') return { id: event.data.batchId, role: 'start' }
    if (event.type === 'continuity/ack') return { id: event.data.batchId, role: 'update' }
    const batchId = deliveryMessageBatch(event)
    return batchId === undefined ? null : { id: batchId, role: 'update', exclusive: true }
  },
  start: (_context, match, reader) =>
    startState(match, reader.previous<LedgerSummaryIndex>(LEDGER_INDEX_KIND)?.state),
  update: (context, match) => match.event.type === 'continuity/ack' && !context.state.acked
    ? { ...context.state, acked: true }
    : context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined || !state.acked) return null
    return {
      key: context.key,
      kind: 'continuity-synced',
      id: context.id,
      target: 'chat',
      anchorSeq: state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      // A Turn the batch opened (wake, process now) keeps one visible input.
      groupTree: 'input',
      data: { items: state.items },
    }
  },
}
