/**
 * Continuity ledger value types. This module contains types only, as package
 * convention requires; runtime folding lives in `ledger.ts`.
 *
 * @module @deepseek-ai/dsh-continuity/types
 */

import type { SessionEvent, SessionId as ContinuitySessionId } from '@deepseek-ai/dsh-session/types'

/** Normalized main-ledger field key, e.g. `branch.schedule.deadline`. */
export type LedgerKey = string

/** Actor identity supplied by the runtime or an authenticated request. */
export interface ActorRef {
  readonly kind: 'user' | 'agent' | 'program'
  readonly id: string
}

/** Durable origin of one decision. */
export interface DecisionSource {
  readonly sessionId: string
  readonly turnId: string
}

/** One field change retained for audit and optimistic validation. */
export interface ContinuityPatch {
  readonly key: LedgerKey
  readonly before: unknown
  readonly after: unknown
}

export type DecisionStatus = 'proposed' | 'committed' | 'superseded'

/** A versioned decision; history is never overwritten. */
export interface ContinuityDecision {
  readonly id: string
  readonly eventId: string
  readonly status: DecisionStatus
  readonly baseRev: number
  readonly rev: number
  readonly actor: ActorRef
  readonly source: DecisionSource
  readonly patch: readonly ContinuityPatch[]
  readonly reason: string
  readonly at: number
  readonly supersedes?: string
}

/** A queued main-line notification derived from one committed transaction. */
export interface ContinuityInboxItem {
  readonly id: string
  readonly eventId: string
  readonly kind: 'decision' | 'proposal'
  readonly recipient: string
  readonly summary: string
  readonly impactKeys: readonly LedgerKey[]
  readonly mode: 'defer' | 'wake'
  readonly dedupeKey: string
  readonly committedAt: number
  deliveredAt?: number
  ackedAt?: number
}

/** Closeable work item; execution state is derived elsewhere, never copied. */
export interface ContinuityWorkItem {
  readonly id: string
  readonly sourceRefs: readonly string[]
  readonly owner: ActorRef
  readonly acceptance: readonly string[]
  readonly closePolicy: 'user-accept' | 'on-complete' | 'main-judge'
  readonly taskRefs: readonly string[]
  readonly dueAt?: number
  acceptedAt?: number
}

/** A managed side-effect intent recorded with its observation baseline. */
export interface ContinuityEffect {
  readonly effectId: string
  readonly observedRev: number
  readonly taskRef?: string
  readonly desiredAttempt?: string
  appliedAt?: number
}

/** Complete post-change active view carried by every transaction event. */
export interface LedgerActiveView {
  readonly fields: Readonly<Record<LedgerKey, unknown>>
  readonly openWorkItemIds: readonly string[]
  readonly pendingInboxIds: readonly string[]
}

/** Payload of the required `continuity/transaction` session event. */
export interface ContinuityTransactionData {
  readonly eventId: string
  readonly kind: 'decision' | 'proposal' | 'proposal-confirm' | 'program'
  readonly decision?: ContinuityDecision
  readonly baseRev: number
  readonly rev: number
  readonly patch: readonly ContinuityPatch[]
  readonly changedMainKeys: readonly LedgerKey[]
  readonly actor: ActorRef
  readonly source: DecisionSource
  readonly reason: string
  readonly at: number
  readonly activeView: LedgerActiveView
  /** Complete post-change work-item table, so replay restores closures and acceptance. */
  readonly workItems: Readonly<Record<string, ContinuityWorkItem>>
  readonly dedupe: string
  readonly inboxItem?: ContinuityInboxItem
  readonly effect?: ContinuityEffect
}

/** Payload of the log-only `continuity/delivery` event. */
export interface ContinuityDeliveryData {
  readonly batchId: string
  readonly inboxIds: readonly string[]
  readonly ledgerRev: number
  readonly turn: number
  readonly step: number
  readonly text: string
  readonly textHash: string
}

/** Payload of the log-only `continuity/ack` event. */
export interface ContinuityAckData {
  readonly batchId: string
  readonly inboxIds: readonly string[]
  readonly assistantSeq?: number
  readonly at: number
}

/** Payload of the log-only `continuity/read` event registering one active decision read set. */
export interface ContinuityReadData {
  readonly decisionContextId: string
  readonly keys: readonly LedgerKey[]
  readonly at: number
}

/** Payload of the log-only `continuity/observe` event fixing the main-line effect baseline. */
export interface ContinuityObserveData {
  readonly rev: number
  readonly at: number
}

/** Payload of the log-only `continuity/wake` event releasing one queued wake exactly once. */
export interface ContinuityWakeData {
  readonly eventId: string
  readonly at: number
}

/** Folded ledger state; plain JSON so projections can persist it. */
export interface LedgerState {
  readonly schemaVersion: 1
  readonly mainSessionId: string
  readonly branchSessionId?: string
  readonly rev: number
  readonly fieldRevs: Readonly<Record<LedgerKey, number>>
  readonly fields: Readonly<Record<LedgerKey, unknown>>
  readonly decisions: Readonly<Record<string, ContinuityDecision>>
  readonly workItems: Readonly<Record<string, ContinuityWorkItem>>
  readonly inbox: Readonly<Record<string, ContinuityInboxItem>>
  readonly activeReadKeys: readonly LedgerKey[]
  readonly contextObservedRev: number
  readonly transactionsById: Readonly<Record<string, string>>
  readonly effectsByEventId: Readonly<Record<string, ContinuityEffect>>
}

/** Input to the pure commit transition. */
export interface CommitInput {
  readonly eventId: string
  readonly decisionId?: string
  readonly baseRev: number
  readonly actor: ActorRef
  readonly source: DecisionSource
  readonly patch: readonly ContinuityPatch[]
  readonly reason: string
  readonly at?: number
  readonly proposal?: boolean
  /** Set false when this commit confirms an existing reviewed proposal and needs no new inbox item. */
  readonly notify?: boolean
  readonly proposedEventId?: string
  readonly supersedes?: string
  readonly workItem?: ContinuityWorkItem
}

/** Classification of one committed change for main-line return flow. */
export type ReturnMode = 'none' | 'defer' | 'wake'

/** Outcome of the pure commit transition. */
export interface CommitResult {
  readonly kind: 'duplicate' | 'conflict' | 'no-op' | 'committed'
  readonly state: LedgerState
  readonly transaction?: ContinuityTransactionData
  readonly previousDecisionId?: string
  readonly conflictKeys?: readonly LedgerKey[]
  readonly currentRev?: number
}

/** Result of authorizing a managed effect against an observation baseline. */
export interface EffectAuthorization {
  readonly ok: boolean
  readonly currentRev: number
  readonly observedRev: number
}

/** Deterministic fixed-area rendering output. */
export interface FixedArea {
  readonly text: string
  readonly hash: string
  readonly truncated: boolean
  readonly rendererVersion: 1
}

/** Any continuity session event, for fold consumers. */
export type ContinuityEvent = Extract<SessionEvent, { type: 'continuity/transaction' | 'continuity/delivery' | 'continuity/ack' | 'continuity/read' | 'continuity/observe' | 'continuity/wake' }>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Branch-local ledger revision last returned by an explicit read. Log-only.
     * @param data - main Session identity and observed ledger revision.
     */
    'continuity/branch-read': { readonly mainSessionId: ContinuitySessionId; readonly rev: number }
    /**
     * One atomic continuity ledger transaction: decision, optional inbox item,
     * effect intent, and the complete post-change active view. Log-only.
     */
    'continuity/transaction': ContinuityTransactionData
    /** A selected pending batch rendered into one main-line request. Log-only. */
    'continuity/delivery': ContinuityDeliveryData
    /** Durable acknowledgement of one delivered batch after a normal response. */
    'continuity/ack': ContinuityAckData
    /** One explicit current-decision read replacing the active read set. */
    'continuity/read': ContinuityReadData
    /** Durable main-line context observation baseline used by managed-effect executors. */
    'continuity/observe': ContinuityObserveData
    /** Durable single release of one queued continuity wake. */
    'continuity/wake': ContinuityWakeData
  }
}
