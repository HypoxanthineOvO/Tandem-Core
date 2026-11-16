/**
 * Pure continuity ledger transitions: optimistic commit, replay fold, return
 * classification, observation baselines, and managed-effect authorization.
 *
 * @module @deepseek-ai/dsh-continuity/ledger
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  CommitInput, CommitResult, ContinuityEffect, ContinuityInboxItem,
  ContinuityTransactionData, ContinuityWorkItem, EffectAuthorization,
  LedgerKey, LedgerState, ReturnMode,
} from './types.ts'

/** Key prefixes that count as main-line ledger fields. */
export const MAIN_LEDGER_KEY_PREFIXES: readonly string[] = [
  'goal', 'acceptance', 'budget', 'headcount', 'schedule', 'interface',
  'artifact', 'risk', 'failure', 'commitment', 'acceptance-pending',
]

/** Stable JSON serialization: object keys sorted at every level. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (typeof value === 'object' && value !== null) {
    const record: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      record[key] = sortValue((value as Record<string, unknown>)[key])
    }
    return record
  }
  return value
}

/** Initial ledger for one main session, optionally bound to one branch. */
export function initialLedger(mainSessionId: string, branchSessionId?: string): LedgerState {
  return {
    schemaVersion: 1,
    mainSessionId,
    ...branchSessionId === undefined ? {} : { branchSessionId },
    rev: 0,
    fieldRevs: {},
    fields: {},
    decisions: {},
    workItems: {},
    inbox: {},
    activeReadKeys: [],
    contextObservedRev: 0,
    transactionsById: {},
    effectsByEventId: {},
  }
}

/** Whether a normalized key belongs to the main-line ledger surface. */
export function isMainLedgerKey(key: LedgerKey): boolean {
  return MAIN_LEDGER_KEY_PREFIXES.some(prefix => key === prefix || key.startsWith(`${prefix}.`) || key.startsWith(`${prefix}/`))
}

/** Filter a patch to keys that change the main ledger surface. */
export function changedMainKeys(patch: readonly { key: LedgerKey }[]): LedgerKey[] {
  return [...new Set(patch.map(item => item.key).filter(isMainLedgerKey))].sort()
}

function activeView(state: LedgerState): { fields: Readonly<Record<LedgerKey, unknown>>; openWorkItemIds: string[]; pendingInboxIds: string[] } {
  return {
    fields: state.fields,
    openWorkItemIds: Object.values(state.workItems).filter(item => item.acceptedAt === undefined).map(item => item.id).sort(),
    pendingInboxIds: Object.values(state.inbox).filter(item => item.ackedAt === undefined).map(item => item.id).sort(),
  }
}

/** Classify a committed change: wake only when it intersects the active read set. */
export function classifyReturn(state: LedgerState, impactKeys: readonly LedgerKey[], proposal = false): ReturnMode {
  const changed = impactKeys.filter(isMainLedgerKey)
  if (changed.length === 0) return 'none'
  if (proposal) return 'defer'
  return changed.some(key => state.activeReadKeys.includes(key)) ? 'wake' : 'defer'
}

/**
 * Canonical idempotency request: `before` values are excluded because a retry
 * naturally reads the post-commit current value; identity is the requested
 * change, not the caller's stale snapshot.
 */
function dedupeRequest(input: CommitInput): Record<string, unknown> {
  return {
    eventId: input.eventId,
    decisionId: input.decisionId,
    actor: input.actor,
    source: input.source,
    patch: input.patch.map(item => ({ key: item.key, after: item.after })),
    reason: input.reason,
    proposal: input.proposal,
    notify: input.notify,
    proposedEventId: input.proposedEventId,
    supersedes: input.supersedes,
    workItem: input.workItem,
  }
}

/**
 * Pure optimistic commit. Identical retries are idempotent; a reused eventId
 * with different content conflicts; baseRev or `before` mismatch conflicts.
 * @param state - folded ledger state before this transaction.
 * @param input - runtime-authenticated commit request.
 * @returns outcome plus the next state and durable transaction payload.
 */
export function commitToLedger(state: LedgerState, input: CommitInput): CommitResult {
  const canonicalInput = stableJson(dedupeRequest(input))
  const prior = state.transactionsById[input.eventId]
  if (prior !== undefined) {
    return prior === canonicalInput
      ? { kind: 'duplicate', state }
      : { kind: 'conflict', state }
  }
  if (input.baseRev !== state.rev) {
    return { kind: 'conflict', state, currentRev: state.rev }
  }
  const patch = input.patch.map(item => ({
    key: item.key,
    before: item.before === undefined ? null : item.before,
    after: item.after === undefined ? null : item.after,
  }))
  const conflictKeys = patch
    .filter(item => stableJson(state.fields[item.key] ?? null) !== stableJson(item.before))
    .map(item => item.key)
  if (conflictKeys.length > 0) return { kind: 'conflict', state, conflictKeys, currentRev: state.rev }

  const effective = patch.filter(item => stableJson(item.before) !== stableJson(item.after))
  if (effective.length === 0) return { kind: 'no-op', state }

  const changed = changedMainKeys(effective)
  const proposal = input.proposal === true
  const nextRev = proposal ? state.rev : state.rev + 1
  const decisionId = input.decisionId ?? `decision:${input.eventId}`
  const at = input.at ?? 0
  const decision = {
    id: decisionId,
    eventId: input.eventId,
    status: proposal ? 'proposed' as const : 'committed' as const,
    baseRev: input.baseRev,
    rev: nextRev,
    actor: input.actor,
    source: input.source,
    patch: effective,
    reason: input.reason,
    at,
    ...input.supersedes === undefined ? {} : { supersedes: input.supersedes },
  }
  const fields: Record<LedgerKey, unknown> = { ...state.fields }
  const fieldRevs: Record<LedgerKey, number> = { ...state.fieldRevs }
  if (!proposal) {
    for (const item of effective) {
      fields[item.key] = item.after
      fieldRevs[item.key] = nextRev
    }
  }
  const workItems = input.workItem === undefined ? state.workItems : { ...state.workItems, [input.workItem.id]: input.workItem }
  const nextNoInbox: LedgerState = {
    ...state,
    rev: nextRev,
    fields,
    fieldRevs,
    decisions: { ...state.decisions, [decisionId]: decision },
    workItems,
  }
  const mode = classifyReturn(state, changed, proposal)
  let inbox: Record<string, ContinuityInboxItem> = Object.fromEntries(Object.entries(state.inbox)) as Record<string, ContinuityInboxItem>
  let inboxItem: ContinuityInboxItem | undefined
  if ((mode !== 'none' || proposal) && input.notify !== false) {
    const inboxMode: 'defer' | 'wake' = proposal ? 'defer' : mode === 'wake' ? 'wake' : 'defer'
    inboxItem = {
      id: `${input.eventId}:inbox`,
      eventId: input.eventId,
      kind: proposal ? 'proposal' : 'decision',
      recipient: state.mainSessionId,
      summary: input.reason.length <= 160 ? input.reason : `${input.reason.slice(0, 159)}…`,
      impactKeys: changed,
      mode: inboxMode,
      dedupeKey: input.eventId,
      committedAt: at,
    }
    inbox[inboxItem.id] = inboxItem
  }
  const nextState: LedgerState = { ...nextNoInbox, inbox }
  const transaction: ContinuityTransactionData = {
    eventId: input.eventId,
    kind: proposal ? 'proposal' : 'decision',
    decision,
    baseRev: input.baseRev,
    rev: nextRev,
    patch: effective,
    changedMainKeys: changed,
    actor: input.actor,
    source: input.source,
    reason: input.reason,
    at,
    activeView: activeView(nextState),
    workItems,
    dedupe: canonicalInput,
    ...inboxItem === undefined ? {} : { inboxItem },
  }
  return {
    kind: 'committed',
    state: { ...nextState, transactionsById: { ...nextState.transactionsById, [input.eventId]: canonicalInput } },
    transaction,
  }
}

/** Record the main session's context observation baseline. */
export function observeContext(state: LedgerState, rev: number): LedgerState {
  return rev < state.contextObservedRev ? state : { ...state, contextObservedRev: rev }
}

/** Replace the active read set for one current explicit decision context. */
export function registerRead(state: LedgerState, _decisionContextId: string, keys: readonly LedgerKey[]): LedgerState {
  return { ...state, activeReadKeys: [...new Set(keys)].sort() }
}

/** Authorize a managed effect by comparing current and observed revisions. */
export function authorizeEffect(state: LedgerState, observedRev: number): EffectAuthorization {
  return { ok: state.rev <= observedRev, currentRev: state.rev, observedRev }
}

/** Mark inbox items delivered, preserving immutable optional-field shape. */
export function markDelivered(state: LedgerState, inboxIds: readonly string[], at: number): LedgerState {
  return mutateInbox(state, inboxIds, item => item.deliveredAt === undefined ? { ...item, deliveredAt: at } : item)
}

/** Mark inbox items acknowledged after a normal main-line response. */
export function ackInbox(state: LedgerState, inboxIds: readonly string[], at: number): LedgerState {
  return mutateInbox(state, inboxIds, item => item.ackedAt === undefined ? { ...item, ackedAt: at } : item)
}

function mutateInbox(state: LedgerState, inboxIds: readonly string[], mutate: (item: ContinuityInboxItem) => ContinuityInboxItem): LedgerState {
  const ids = new Set(inboxIds)
  let changed = false
  const inbox: Record<string, ContinuityInboxItem> = {}
  for (const [id, item] of Object.entries(state.inbox)) {
    const next = ids.has(id) ? mutate(item) : item
    if (next !== item) changed = true
    inbox[id] = next
  }
  return changed ? { ...state, inbox } : state
}

/** Mark an effect applied after its durable child admission. */
export function markEffectApplied(state: LedgerState, effectId: string, at: number): LedgerState {
  const effect = state.effectsByEventId[effectId]
  if (effect === undefined || effect.appliedAt !== undefined) return state
  const next: ContinuityEffect = { ...effect, appliedAt: at }
  return { ...state, effectsByEventId: { ...state.effectsByEventId, [effectId]: next } }
}

/** Select unacknowledged inbox items in stable event order. */
export function selectPendingBatch(state: LedgerState, limit: number): ContinuityInboxItem[] {
  return Object.values(state.inbox)
    .filter(item => item.ackedAt === undefined)
    .sort((a, b) => a.committedAt - b.committedAt || (a.eventId < b.eventId ? -1 : 1))
    .slice(0, Math.max(0, limit))
}

/**
 * Fold one committed session event. Continuity events not recognized by this
 * package leave the state reference unchanged.
 * @param state - folded state covering all prior events.
 * @param event - next committed session event.
 * @returns next state, or the same reference when the event is not ledger-owned.
 */
export function foldLedgerEvent(state: LedgerState, event: SessionEvent): LedgerState {
  if (event.type === 'continuity/observe') {
    return event.data.rev >= state.contextObservedRev
      ? { ...state, contextObservedRev: event.data.rev }
      : state
  }
  if (event.type === 'continuity/read') {
    return { ...state, activeReadKeys: [...new Set(event.data.keys)].sort() }
  }
  if (event.type === 'continuity/delivery') {
    return markDelivered(state, event.data.inboxIds, event.time)
  }
  if (event.type === 'continuity/ack') {
    return ackInbox(state, event.data.inboxIds, event.data.at)
  }
  if (event.type !== 'continuity/transaction') return state
  const data = event.data
  const prior = state.transactionsById[data.eventId]
  if (prior !== undefined) return state
  let next: LedgerState = {
    ...state,
    rev: data.rev,
    fields: data.activeView.fields,
    workItems: data.workItems,
    decisions: data.decision === undefined ? state.decisions : { ...state.decisions, [data.decision.id]: data.decision },
    transactionsById: { ...state.transactionsById, [data.eventId]: data.dedupe },
  }
  if (data.inboxItem !== undefined) next = { ...next, inbox: { ...next.inbox, [data.inboxItem.id]: data.inboxItem } }
  if (data.effect !== undefined) next = { ...next, effectsByEventId: { ...next.effectsByEventId, [data.effect.effectId]: data.effect } }
  for (const item of data.patch) {
    if (data.kind !== 'proposal') next = { ...next, fieldRevs: { ...next.fieldRevs, [item.key]: data.rev } }
  }
  return next
}

/** Fold a complete ordered event log into a ledger state. */
export function foldLedgerEvents(mainSessionId: string, events: readonly SessionEvent[], branchSessionId?: string): LedgerState {
  let state = initialLedger(mainSessionId, branchSessionId)
  for (const event of events) state = foldLedgerEvent(state, event)
  return state
}

/** Derive the stable pending-work summary used by render and projections. */
export function openWorkItems(state: LedgerState): ContinuityWorkItem[] {
  return Object.values(state.workItems).filter(item => item.acceptedAt === undefined).sort((a, b) => a.id.localeCompare(b.id))
}
