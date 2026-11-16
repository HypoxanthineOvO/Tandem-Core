/**
 * Pure versioned continuity ledger model shared by runtime owners.
 * @module @deepseek-ai/dsh-continuity
 */

export type {
  ActorRef, CommitInput, CommitResult, ContinuityAckData, ContinuityDecision,
  ContinuityDeliveryData, ContinuityEffect, ContinuityEvent, ContinuityInboxItem,
  ContinuityPatch, ContinuityReadData, ContinuityTransactionData, ContinuityWorkItem,
  DecisionSource, DecisionStatus, EffectAuthorization, FixedArea, LedgerActiveView,
  LedgerKey, LedgerState, ReturnMode,
} from './types.ts'
export {
  MAIN_LEDGER_KEY_PREFIXES,
  ackInbox,
  authorizeEffect,
  changedMainKeys,
  classifyReturn,
  commitToLedger,
  foldLedgerEvent,
  foldLedgerEvents,
  initialLedger,
  isMainLedgerKey,
  markDelivered,
  markEffectApplied,
  observeContext,
  openWorkItems,
  registerRead,
  selectPendingBatch,
  stableJson,
} from './ledger.ts'
export { CHARS_PER_TOKEN, estimateTextTokens, renderFixedArea } from './render.ts'
export { DEFAULT_PENDING_NOTIFICATION_LIMITS, PendingNotificationError, renderPendingDecisions } from './pending.ts'
export type { PendingNotificationLimits } from './pending.ts'
