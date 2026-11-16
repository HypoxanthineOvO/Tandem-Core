/**
 * Public continuity Remote boundary types, isolated on a cordis-free leaf so
 * client and wire programs can name them without loading host Context merges.
 *
 * @module @deepseek-ai/dsh-subagent/continuity-types
 */

/** JSON scalar or recursive JSON value accepted at the Remote commit boundary. */
export type ContinuityWireValue = string | number | boolean | null | readonly ContinuityWireValue[] | { readonly [key: string]: ContinuityWireValue }

/** Host-side work-item change carried in one authoritative transaction. */
export interface ContinuityWorkItemChange {
  readonly id: string
  readonly sourceRefs: readonly string[]
  readonly owner: { readonly kind: 'user' | 'agent' | 'program'; readonly id: string }
  readonly acceptance: readonly string[]
  readonly closePolicy: 'user-accept' | 'on-complete' | 'main-judge'
  readonly taskRefs: readonly string[]
  readonly dueAt?: number
  acceptedAt?: number
}

/** Host-side commit command; runtime-authenticated and unconstrained JSON values. */
export interface ContinuityCommitInput {
  readonly eventId: string
  readonly decisionId?: string
  /** Omission uses the source branch's latest observed ledger revision. */
  readonly baseRev?: number
  readonly actor: { readonly kind: 'user' | 'agent' | 'program'; readonly id: string }
  readonly source: { readonly sessionId: string; readonly turnId: string }
  readonly patch: ReadonlyArray<{ readonly key: string; readonly before?: unknown; readonly after?: unknown }>
  readonly reason: string
  readonly at?: number
  readonly proposal?: boolean
  readonly proposedEventId?: string
  readonly supersedes?: string
  readonly notify?: boolean
  readonly workItem?: ContinuityWorkItemChange
}

/** Remote-facing commit request; patch values are constrained JSON. */
export interface ContinuityCommitRequest {
  readonly eventId: string
  /** Omission uses the source branch's latest observed ledger revision. */
  readonly baseRev?: number
  readonly actorKind: 'user' | 'agent' | 'program'
  readonly actorId: string
  readonly sourceSessionId: string
  readonly sourceTurnId: string
  readonly patch: ReadonlyArray<{ key: string; before?: ContinuityWireValue; after?: ContinuityWireValue }>
  readonly reason: string
  readonly at?: number
  readonly proposal?: boolean
}

/** Outcome reported to the model-facing tool and Remote caller. */
export interface ContinuityCommitReceipt {
  readonly eventId: string
  readonly decisionId?: string
  readonly rev?: number
  readonly state: 'duplicate' | 'conflict' | 'no-op' | 'committed-local' | 'deferred' | 'wake-queued' | 'commit-uncertain'
  readonly conflictKeys?: readonly string[]
  readonly currentRev?: number
  readonly inboxId?: string
}

/** Wire-facing pending item. */
export interface ContinuityPendingItem {
  readonly id: string
  readonly eventId: string
  readonly kind: 'decision' | 'proposal'
  readonly recipient: string
  readonly summary: string
  readonly impactKeys: readonly string[]
  readonly mode: 'defer' | 'wake'
  readonly dedupeKey: string
  readonly committedAt: number
  readonly deliveredAt?: number
  readonly ackedAt?: number
}

/** Immediate-processing action result. */
export interface ContinuityProcessNowResult {
  readonly accepted: boolean
  readonly batchId?: string
  readonly disposition: 'queued' | 'next-safe-step' | 'empty'
}

/** Minimal status projection for the pending-review UI. */
export interface ContinuityStatus {
  readonly enabled: boolean
  readonly mainSessionId?: string
  readonly branchSessionId?: string
  readonly ledgerRev: number
  readonly contextObservedRev?: number
  readonly pendingCount: number
  readonly pendingWakeCount: number
  readonly lastSyncedBatch?: { batchId: string; inboxIds: readonly string[]; ackedAt: number }
}
