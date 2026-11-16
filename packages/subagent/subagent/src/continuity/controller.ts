/**
 * Session-bound continuity ledger owner: durable commits, source-level return
 * flow, pending-batch delivery, acknowledgement, and the Remote-facing status
 * surface. The pure model lives in `@deepseek-ai/dsh-continuity`.
 *
 * @module @deepseek-ai/dsh-subagent/continuity/controller
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  ackInbox, authorizeEffect, commitToLedger, foldLedgerEvents,
  registerRead, selectPendingBatch, renderPendingDecisions, DEFAULT_PENDING_NOTIFICATION_LIMITS,
} from '@deepseek-ai/dsh-continuity'

import type { PendingNotificationLimits } from '@deepseek-ai/dsh-continuity'

/** Continuity model aliases derived from the pure package's value exports. */
type LedgerState = ReturnType<typeof foldLedgerEvents>
type CommitResult = ReturnType<typeof commitToLedger>
type EffectAuthorization = ReturnType<typeof authorizeEffect>
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** Durable attribution of one rendered pending batch entering the main line. */
interface ContinuityDeliverySource {
  readonly kind: 'continuity-delivery'
  readonly batchId: string
  readonly ledgerRev: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'continuity-delivery': ContinuityDeliverySource
    'continuity-baseline': { readonly kind: 'continuity-baseline'; readonly mainSessionId: SessionId; readonly rev: number }
  }
}

/** One main line and its independently managed branches. */
interface Binding {
  readonly mainSessionId: SessionId
  readonly branchSessionId: SessionId
  readonly branches: Set<SessionId>
  mainAgent?: Agent
}

import type {
  ContinuityCommitInput, ContinuityCommitReceipt, ContinuityPendingItem, ContinuityProcessNowResult, ContinuityStatus,
} from '../continuity-types.ts'
export type {
  ContinuityCommitReceipt, ContinuityPendingItem, ContinuityProcessNowResult, ContinuityStatus,
} from '../continuity-types.ts'

/** Manager-facing source-level return integration. */
export interface ContinuityIntegration {
  /** Observe an accepted direct human prompt before the child's queued turn starts. */
  acceptedHumanPrompt?(parent: Agent, child: Agent): void
  /** Whether one settled local activation's last direct input was human-authored. */
  suppressSettlement(events: readonly SessionEvent[]): boolean
  /** Intercept a human-turn send_message(parent) before any parent wake. */
  interceptHumanSend(events: readonly SessionEvent[]): boolean
}

/**
 * Owns continuity state for the configured main session. Appends are
 * serialized per main session; every commit is flushed before it is reported.
 */
/** Test/DI service face; production reads both from the runtime Context. */
export interface ContinuityServiceFace {
  readonly sessions?: { get(id: SessionId): Session | undefined; flush(session: Session): Promise<boolean> }
  readonly agents?: { get(id: SessionId): Agent | undefined }
}

class MainContinuityController {
  private binding: Binding | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private readonly cache = new Map<SessionId, LedgerState>()
  private lastAck: { batchId: string; inboxIds: readonly string[]; ackedAt: number } | undefined
  private durabilityBlocked = false
  private readonly releasedWake = new Set<string>()
  private readonly disposePreStep: () => void

  constructor(
    private readonly ctx: Context,
    private readonly services: ContinuityServiceFace,
    private readonly notificationLimits: () => PendingNotificationLimits,
  ) {
    this.disposePreStep = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter' || this.binding?.mainSessionId !== payload.agent.session.id) return decision
      return await this.injectPendingBatch(payload.agent, decision.messages, payload.turn, payload.step)
    })
  }

  /** Bind another branch to this main line; repeated bindings are idempotent. */
  bind(mainAgent: Agent, branchSessionId: SessionId): void {
    if (this.binding !== undefined && this.binding.mainSessionId !== mainAgent.id) {
      throw new Error('此连续性控制器已绑定到另一条主线。')
    }
    this.bindIfAbsent(mainAgent, branchSessionId)
  }

  /** Add an unbound branch; return false for a duplicate or a different main line. */
  bindIfAbsent(mainAgent: Agent, branchSessionId: SessionId): boolean {
    if (this.binding !== undefined) {
      if (this.binding.mainSessionId !== mainAgent.id || this.binding.branches.has(branchSessionId)) return false
      this.binding.branches.add(branchSessionId)
      return true
    }
    this.binding = { mainSessionId: mainAgent.id, branchSessionId, branches: new Set([branchSessionId]), mainAgent }
    return true
  }

  /** Release live references and this main line's request listener. */
  dispose(): void {
    this.binding = undefined
    this.disposePreStep()
  }

  /** Fold the authoritative ledger from the main session log. */
  state(): LedgerState {
    const binding = this.requireBinding()
    const session = this.requireMainSession()
    const state = foldLedgerEvents(binding.mainSessionId, session.snapshotEvents(), binding.branchSessionId)
    this.cache.set(binding.mainSessionId, state)
    return state
  }

  /** Model-facing explicit read; also replaces the durable active read set. */
  read(keys: readonly string[]): { values: Record<string, unknown>; rev: number } {
    const session = this.requireMainSession()
    session.append('continuity/read', { decisionContextId: 'current-decision', keys: [...keys], at: Date.now() })
    void (this.services.sessions ?? this.ctx.get('sessions'))?.flush(session)
    const state = registerRead(this.state(), 'current-decision', keys)
    const values: Record<string, unknown> = {}
    for (const key of keys) values[key] = state.fields[key] ?? null
    return { values, rev: state.rev }
  }

  /**
   * Commit one decision under the main session's serialized owner lock.
   * Identical retries return the original outcome without a second append.
   */
  async commit(input: ContinuityCommitInput & { readonly baseRev: number }): Promise<ContinuityCommitReceipt> {
    return await this.serialize(async (): Promise<ContinuityCommitReceipt> => {
      const binding = this.requireBinding()
      const session = this.requireMainSession()
      const before = foldLedgerEvents(binding.mainSessionId, session.snapshotEvents(), binding.branchSessionId)
      const result: CommitResult = commitToLedger(before, {
        ...input,
        patch: input.patch.map(item => ({ key: item.key, before: item.before ?? null, after: item.after ?? null })),
      })
      if (result.kind === 'conflict') {
        return {
          eventId: input.eventId,
          state: 'conflict',
          ...result.conflictKeys === undefined ? {} : { conflictKeys: result.conflictKeys },
          ...result.currentRev === undefined ? {} : { currentRev: result.currentRev },
        }
      }
      if (result.kind === 'duplicate') {
        const flushed = await this.durableFlush(session)
        if (!flushed) {
          this.durabilityBlocked = true
          return { eventId: input.eventId, state: 'commit-uncertain', currentRev: before.rev }
        }
        this.durabilityBlocked = false
        await this.releasePendingWake(input.eventId)
        return this.duplicateReceipt(input.eventId, before)
      }
      if (result.kind === 'no-op' || result.transaction === undefined) return { eventId: input.eventId, state: 'no-op' }
      session.append('continuity/transaction', result.transaction)
      const flushed = await this.durableFlush(session)
      if (flushed !== true) {
        // The append is durable-in-memory but unconfirmed on disk. Keep the
        // eventId answer uncertain and block wake/effects until a retry flushes.
        this.durabilityBlocked = true
        return {
          eventId: input.eventId,
          ...result.transaction.decision === undefined ? {} : { decisionId: result.transaction.decision.id },
          rev: result.transaction.rev,
          state: 'commit-uncertain',
          currentRev: result.transaction.rev,
        }
      }
      this.durabilityBlocked = false
      this.cache.delete(binding.mainSessionId)
      await this.releasePendingWake(input.eventId)
      return {
        eventId: input.eventId,
        ...result.transaction.decision === undefined ? {} : { decisionId: result.transaction.decision.id },
        rev: result.transaction.rev,
        state: result.transaction.inboxItem === undefined ? 'committed-local' : result.transaction.inboxItem.mode === 'wake' ? 'wake-queued' : 'deferred',
        ...result.transaction.inboxItem === undefined ? {} : { inboxId: result.transaction.inboxItem.id },
      }
    })
  }

  /** Confirm one cross-scope proposal using its original patch. */
  async confirmProposal(proposalEventId: string, requestId: string): Promise<ContinuityCommitReceipt> {
    const state = this.state()
    const proposal = Object.values(state.decisions).find(decision => decision.eventId === proposalEventId && decision.status === 'proposed')
    if (proposal === undefined) return { eventId: requestId, state: 'conflict', currentRev: state.rev }
    return await this.commit({
      eventId: requestId,
      baseRev: state.rev,
      actor: { kind: 'user', id: 'main' },
      source: { sessionId: this.requireBinding().mainSessionId, turnId: 'confirm' },
      patch: proposal.patch.map(item => ({ key: item.key, before: state.fields[item.key], after: item.after })),
      reason: `confirm proposal ${proposal.id}`,
      at: Date.now(),
      notify: false,
    })
  }

  /** Durably observe a fresh main-line context baseline. */
  observeMainContext(): number {
    const session = this.requireMainSession()
    const rev = foldLedgerEvents(this.requireBinding().mainSessionId, session.snapshotEvents(), this.requireBinding().branchSessionId).rev
    if (rev >= this.state().contextObservedRev) {
      session.append('continuity/observe', { rev, at: Date.now() })
      void (this.services.sessions ?? this.ctx.get('sessions'))?.flush(session)
    }
    return this.state().contextObservedRev
  }

  /** Authorize a managed effect against the caller's observation baseline. */
  authorize(observedRev: number): EffectAuthorization {
    const authorization = authorizeEffect(this.state(), observedRev)
    return this.durabilityBlocked ? { ...authorization, ok: false } : authorization
  }

  /** User-requested immediate processing; duplicates coalesce by requestId. */
  processNow(requestId: string): ContinuityProcessNowResult {
    const agent = this.requireMainAgent()
    const pending = selectPendingBatch(this.state(), 16)
    if (pending.length === 0) return { accepted: false, disposition: 'empty' }
    const batchId = `process:${requestId}`
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '请处理待带入的支线决议。' }],
      source: deliverySource(batchId, this.state().rev),
    }))
    return { accepted: true, batchId, disposition: agent.status === 'idle' ? 'queued' : 'next-safe-step' }
  }

  /** UI status projection; no model request is made. */
  status(): ContinuityStatus {
    if (this.binding === undefined) return { enabled: false, ledgerRev: 0, contextObservedRev: 0, pendingCount: 0, pendingWakeCount: 0 }
    const state = this.state()
    if (this.lastAck === undefined) {
      const acks = this.requireMainSession().snapshotEvents()
        .filter((event): event is Extract<SessionEvent, { type: 'continuity/ack' }> => event.type === 'continuity/ack')
      const latest = acks.at(-1)
      if (latest !== undefined) this.lastAck = { batchId: latest.data.batchId, inboxIds: latest.data.inboxIds, ackedAt: latest.data.at }
    }
    const pending = selectPendingBatch(state, Number.MAX_SAFE_INTEGER)
    return {
      enabled: true,
      mainSessionId: this.binding.mainSessionId,
      branchSessionId: this.binding.branchSessionId,
      ledgerRev: state.rev,
      contextObservedRev: state.contextObservedRev,
      pendingCount: pending.length,
      pendingWakeCount: pending.filter(item => item.mode === 'wake').length,
      ...this.lastAck === undefined ? {} : { lastSyncedBatch: this.lastAck },
    }
  }

  /** Pending list projection in stable event order. */
  pending(limit: number = 50): readonly ContinuityPendingItem[] {
    return this.binding === undefined ? [] : selectPendingBatch(this.state(), limit)
  }

  /** Manager integration: settlement body never reaches the parent for human turns. */
  readonly integration: ContinuityIntegration = {
    suppressSettlement: events => lastDirectHumanInput(events) !== undefined,
    interceptHumanSend: events => lastDirectHumanInput(events) !== undefined,
  }

  /** Append bounded, redacted field changes; only included inbox items can be acknowledged. */
  async injectPendingBatch(agent: Agent, messages: UserMessage[], turn: number, step: number = 1): Promise<{ kind: 'enter'; messages: UserMessage[] }> {
    const binding = this.requireBinding()
    if (binding.mainSessionId !== agent.session.id) return { kind: 'enter' as const, messages }
    let state = this.state()
    if (state.rev > state.contextObservedRev) {
      agent.session.append('continuity/observe', { rev: state.rev, at: Date.now() })
      await this.durableFlush(agent.session)
      state = this.state()
    }
    const pending = selectPendingBatch(state, 16)
    if (pending.length === 0) return { kind: 'enter' as const, messages }
    const batchId = `batch:v2:${state.rev}:${pending[0]!.eventId}`
    const priorDelivery = agent.session.snapshotEvents()
      .find(event => event.type === 'continuity/delivery' && event.data.batchId === batchId) as
      Extract<SessionEvent, { type: 'continuity/delivery' }> | undefined
    if (messages.some(message => message.source.kind === 'continuity-delivery' && message.source.batchId === batchId)) {
      return { kind: 'enter' as const, messages }
    }
    if (priorDelivery !== undefined) {
      const acked = agent.session.snapshotEvents()
        .some(event => event.type === 'continuity/ack' && event.data.batchId === batchId)
      if (acked) return { kind: 'enter' as const, messages }
      const completed = agent.session.snapshotEvents()
        .some(event => event.type === 'assistant/message'
          && event.seq > priorDelivery.seq
          && event.data.turn === priorDelivery.data.turn
          && event.data.step === priorDelivery.data.step
          && event.data.interrupted !== true)
      if (completed) {
        await this.appendAck(agent, batchId, priorDelivery.data.inboxIds)
        return { kind: 'enter' as const, messages }
      }
      const recovered = createUserMessage({
        content: [{ type: 'text', text: priorDelivery.data.text }],
        source: deliverySource(batchId, priorDelivery.data.ledgerRev),
      })
      this.scheduleAck(agent, batchId, priorDelivery.data.inboxIds, priorDelivery.data.turn, priorDelivery.data.step)
      return { kind: 'enter' as const, messages: [recovered, ...messages] }
    }
    const { text, inboxIds } = renderPendingDecisions(state, pending, this.notificationLimits())
    agent.session.append('continuity/delivery', {
      batchId,
      inboxIds,
      ledgerRev: state.rev,
      turn,
      step,
      text,
      textHash: sha256(text),
    })
    if (!await this.durableFlush(agent.session)) return { kind: 'enter' as const, messages }
    this.state()
    const rendered = createUserMessage({
      content: [{ type: 'text', text }],
      source: deliverySource(batchId, state.rev),
    })
    this.scheduleAck(agent, batchId, inboxIds, turn, step)
    return { kind: 'enter' as const, messages: [rendered, ...messages] }
  }

  private scheduleAck(agent: Agent, batchId: string, inboxIds: readonly string[], turn: number, step: number): void {
    const dispose = agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'assistant/message'
        || event.data.turn !== turn || event.data.step !== step || event.data.interrupted === true) return
      queueMicrotask(() => {
        dispose()
        void this.appendAck(agent, batchId, inboxIds, event.seq)
          .catch((error: unknown) => {
            this.ctx.logger?.warn(`continuity ack for ${batchId} failed: ${String(error)}`)
          })
      })
    })
  }

  private async appendAck(agent: Agent, batchId: string, inboxIds: readonly string[], assistantSeq?: number): Promise<void> {
    const at = Date.now()
    agent.session.append('continuity/ack', { batchId, inboxIds, ...assistantSeq === undefined ? {} : { assistantSeq }, at })
    if (!await this.durableFlush(agent.session)) return
    const state = ackInbox(this.state(), inboxIds, at)
    this.cache.set(this.requireBinding().mainSessionId, state)
    this.lastAck = { batchId, inboxIds, ackedAt: at }
  }

  /** Flush and classify both `false` and a thrown persistence failure as not durable. */
  private async durableFlush(session: Session): Promise<boolean> {
    try {
      return await (this.services.sessions ?? this.ctx.get('sessions'))?.flush(session) === true
    } catch (error: unknown) {
      this.ctx.logger?.warn(`continuity flush failed: ${String(error)}`)
      return false
    }
  }

  /**
   * Release one durable wake at most once. A `continuity/wake` marker is
   * flushed before the main agent is woken, so a crash-replayed retry sends
   * the follow-up only after the marker is durable and never twice.
   */
  private async releasePendingWake(eventId: string): Promise<void> {
    const session = this.requireMainSession()
    const transaction = session.snapshotEvents()
      .find((event): event is Extract<SessionEvent, { type: 'continuity/transaction' }> =>
        event.type === 'continuity/transaction' && event.data.eventId === eventId)
    const item = transaction?.data.inboxItem
    if (transaction === undefined || item?.mode !== 'wake' || this.releasedWake.has(eventId)) return
    const alreadyReleased = session.snapshotEvents()
      .some(event => event.type === 'continuity/wake' && event.data.eventId === eventId)
    if (!alreadyReleased) {
      session.append('continuity/wake', { eventId, at: Date.now() })
      if (!await this.durableFlush(session)) {
        this.durabilityBlocked = true
        return
      }
    }
    this.releasedWake.add(eventId)
    const agent = this.requireMainAgent()
    if (agent.status === 'idle') {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: '支线有新的待带入决议，请核对字段改动。' }],
        source: deliverySource(`wake:${eventId}`, transaction.data.rev),
      }))
    }
  }

  private duplicateReceipt(eventId: string, state: LedgerState): ContinuityCommitReceipt {
    const item = Object.values(state.inbox).find(candidate => candidate.eventId === eventId)
    return {
      eventId,
      state: item === undefined ? 'committed-local' : item.mode === 'wake' ? 'wake-queued' : 'deferred',
      rev: state.rev,
      ...item === undefined ? {} : { inboxId: item.id },
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private requireBinding(): Binding {
    if (this.binding === undefined) throw new Error('continuity is not bound to a main session')
    return this.binding
  }

  private requireMainSession(): Session {
    const binding = this.requireBinding()
    const session = (this.services.sessions ?? this.ctx.get('sessions'))?.get(binding.mainSessionId)
    if (session === undefined) throw new Error(`continuity main session "${binding.mainSessionId}" is not live`)
    return session
  }

  private requireMainAgent(): Agent {
    const agent = this.requireBinding().mainAgent
    if (agent === undefined) throw new Error(`continuity main agent "${this.requireBinding().mainSessionId}" is not bound`)
    return agent
  }
}

/** Owns independent main-line ledgers and resolves every branch to its exact main line. */
export class ContinuityController {
  private readonly mains = new Map<SessionId, MainContinuityController>()
  private readonly branches = new Map<SessionId, SessionId>()

  /**
   * @param ctx - runtime context owning the listeners and ledger lifetimes.
   * @param services - optional Session and Agent implementations for direct tests.
   * @param notificationLimits - current validated rendering limits; omission uses runtime defaults.
   */
  constructor(private readonly ctx: Context, private readonly services: ContinuityServiceFace = {}, private readonly notificationLimits: () => PendingNotificationLimits = () => DEFAULT_PENDING_NOTIFICATION_LIMITS) {
    ctx.on('agent/disposed', ({ agent }) => {
      const owner = this.mains.get(agent.id)
      if (owner === undefined) return
      owner.dispose()
      this.mains.delete(agent.id)
      for (const [branch, main] of this.branches) if (main === agent.id) this.branches.delete(branch)
    })
    ctx.effect(() => () => {
      for (const owner of this.mains.values()) owner.dispose()
      this.mains.clear()
      this.branches.clear()
    }, 'subagents.continuity.ledgers()')
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      const mainId = this.branches.get(payload.agent.id)
      if (mainId === undefined || this.observedRevision(payload.agent.id) !== undefined) return decision
      const state = this.mainOwner(mainId).state()
      const message = createUserMessage({
        content: [{ type: 'text', text: `受管支线已连接主线。当前连续性账本版本：${state.rev}。用户确认“带回主线”后再提交决议。` }],
        source: { kind: 'continuity-baseline', mainSessionId: mainId, rev: state.rev },
      })
      return { ...decision, messages: [message, ...decision.messages] }
    })
  }

  /**
   * Add a branch; duplicate bindings are idempotent and cross-main rebindings fail.
   * @param mainAgent - exact live Agent owning the ledger.
   * @param branchSessionId - direct continuable child accepting human input.
   */
  bind(mainAgent: Agent, branchSessionId: SessionId): void {
    const prior = this.branches.get(branchSessionId)
    if (prior !== undefined && prior !== mainAgent.id) throw new Error('此支线已绑定到另一条主线。')
    let owner = this.mains.get(mainAgent.id)
    if (owner === undefined) {
      owner = new MainContinuityController(this.ctx, this.services, this.notificationLimits)
      this.mains.set(mainAgent.id, owner)
    }
    owner.bind(mainAgent, branchSessionId)
    this.branches.set(branchSessionId, mainAgent.id)
  }

  /**
   * Add an unseen branch without replacing an existing binding.
   * @param mainAgent - exact live parent Agent.
   * @param branchSessionId - child Session identity to bind.
   * @returns whether a new binding was added.
   */
  bindIfAbsent(mainAgent: Agent, branchSessionId: SessionId): boolean {
    if (this.branches.has(branchSessionId)) return false
    this.bind(mainAgent, branchSessionId)
    return true
  }

  /**
   * Explain why a model-facing continuity call cannot operate in this session.
   * @param sessionId - calling Session identity.
   * @returns Chinese guidance, or undefined for a managed branch.
   */
  branchProblem(sessionId: SessionId): string | undefined {
    if (this.branches.has(sessionId)) return undefined
    return this.mains.has(sessionId)
      ? '这是主线会话。连续性提交和读取工具仅供受管支线使用；请在支线中确认决议后带回主线。'
      : '此会话尚未绑定为受管支线，不能读取或提交连续性决议。请在主线打开可续聊子代理并直接对话；测评预设不参与连续性。'
  }

  /**
   * Read the selected main ledger; caller-free reads remain available to trusted host integrations.
   * @param sessionId - main or branch identity; may be omitted for one bound main.
   * @returns the authoritative ledger folded from that main Session.
   */
  state(sessionId?: SessionId): LedgerState { return this.callerOwner(sessionId).state() }

  /**
   * Read fields and retain the caller branch's revision independently of other branches.
   * @param keys - normalized ledger fields to read.
   * @param caller - managed branch identity; omitted only by trusted host integrations.
   * @returns current field values and their ledger revision.
   */
  read(keys: readonly string[], caller?: SessionId): { values: Record<string, unknown>; rev: number } {
    if (caller !== undefined) this.requireBranch(caller)
    const result = this.callerOwner(caller).read(keys)
    if (caller !== undefined) {
      const session = (this.services.sessions ?? this.ctx.get('sessions'))?.get(caller)
      if (session === undefined) throw new Error('受管支线会话尚未加载。')
      session.append('continuity/branch-read', { rev: result.rev, mainSessionId: this.branches.get(caller)! })
      void (this.services.sessions ?? this.ctx.get('sessions'))?.flush(session)
    }
    return result
  }

  /**
   * Commit against the supplied revision or this branch's last read/injected revision.
   * @param input - decision attributed to a bound source branch.
   * @returns the durable receipt, conflict, or uncertain persistence outcome.
   */
  commit(input: ContinuityCommitInput): Promise<ContinuityCommitReceipt> {
    const caller = input.source.sessionId as SessionId
    this.requireBranch(caller)
    const baseRev = input.baseRev ?? this.observedRevision(caller)
    if (baseRev === undefined) throw new Error('尚未读取连续性账本，请先使用连续性读取工具，再提交决议。')
    return this.callerOwner(caller).commit({ ...input, baseRev })
  }

  /**
   * Confirm a proposal in the addressed main line.
   * @param eventId - proposed decision identity.
   * @param requestId - idempotency identity of the confirmation.
   * @param sessionId - addressed main or branch; optional for one main.
   * @returns the confirmation commit receipt.
   */
  confirmProposal(eventId: string, requestId: string, sessionId?: SessionId): Promise<ContinuityCommitReceipt> {
    return this.callerOwner(sessionId).confirmProposal(eventId, requestId)
  }
  /**
   * Observe the addressed main context.
   * @param sessionId - main or branch identity; optional for one main.
   * @returns the recorded main-line observation revision.
   */
  observeMainContext(sessionId?: SessionId): number { return this.callerOwner(sessionId).observeMainContext() }
  /**
   * Authorize a main-line managed effect against its observation.
   * @param rev - caller's observed ledger revision.
   * @param sessionId - main or branch identity; optional for one main.
   * @returns effect authorization and current revision.
   */
  authorize(rev: number, sessionId?: SessionId): EffectAuthorization { return this.callerOwner(sessionId).authorize(rev) }
  /**
   * Queue user-requested processing on the addressed main line.
   * @param requestId - processing request identity.
   * @param sessionId - main or branch identity; optional for one main.
   * @returns whether and where processing was queued.
   */
  processNow(requestId: string, sessionId?: SessionId): ContinuityProcessNowResult { return this.callerOwner(sessionId).processNow(requestId) }
  /**
   * Read the addressed main/branch status; an unbound session stays disabled.
   * @param sessionId - addressed Session; optional for one bound main.
   * @returns binding identity, ledger revision, and pending counts.
   */
  status(sessionId?: SessionId): ContinuityStatus {
    if (sessionId !== undefined && !this.mains.has(sessionId) && !this.branches.has(sessionId)
      || this.mains.size === 0) return { enabled: false, ledgerRev: 0, contextObservedRev: 0, pendingCount: 0, pendingWakeCount: 0 }
    const status = this.callerOwner(sessionId).status()
    return sessionId !== undefined && this.branches.has(sessionId) ? { ...status, branchSessionId: sessionId } : status
  }
  /**
   * Read pending decisions for the addressed main line.
   * @param limit - maximum items in durable event order.
   * @param sessionId - main or branch identity; optional for one main.
   * @returns unacknowledged decisions and proposals.
   */
  pending(limit: number = 50, sessionId?: SessionId): readonly ContinuityPendingItem[] {
    return this.mains.size === 0 ? [] : this.callerOwner(sessionId).pending(limit)
  }
  /** Human-origin turns remain local, including excluded evaluation sessions. */
  readonly integration: ContinuityIntegration = {
    suppressSettlement: events => lastDirectHumanInput(events) !== undefined,
    interceptHumanSend: events => lastDirectHumanInput(events) !== undefined,
  }
  /**
   * Inject pending decisions only into the addressed main line.
   * @param agent - exact main-line Agent entering a request.
   * @param messages - accepted user messages for that request.
   * @param turn - admitted turn number.
   * @param step - admitted step number, defaulting to the first.
   * @returns accepted messages with any durable pending-decision batch.
   */
  injectPendingBatch(agent: Agent, messages: UserMessage[], turn: number, step: number = 1): Promise<{ kind: 'enter'; messages: UserMessage[] }> {
    return this.mainOwner(agent.id).injectPendingBatch(agent, messages, turn, step)
  }

  private requireBranch(id: SessionId): void {
    const problem = this.branchProblem(id)
    if (problem !== undefined) throw new Error(problem)
  }
  private callerOwner(id?: SessionId): MainContinuityController {
    const mainId = id === undefined ? (this.mains.size === 1 ? this.mains.keys().next().value : undefined) : this.branches.get(id) ?? id
    if (mainId === undefined) throw new Error('请指定已绑定的主线或受管支线会话。')
    return this.mainOwner(mainId)
  }
  private mainOwner(mainId: SessionId): MainContinuityController {
    const owner = this.mains.get(mainId)
    if (owner === undefined) throw new Error('请指定已绑定的主线或受管支线会话。')
    return owner
  }
  private observedRevision(id: SessionId): number | undefined {
    const mainId = this.branches.get(id)
    const events = (this.services.sessions ?? this.ctx.get('sessions'))?.get(id)?.snapshotEvents() ?? []
    for (const event of [...events].reverse()) {
      if (event.type === 'continuity/branch-read' && event.data.mainSessionId === mainId) return event.data.rev
      if (event.type === 'user/message' && event.data.source.kind === 'continuity-baseline'
        && event.data.source.mainSessionId === mainId) return event.data.source.rev
    }
    return undefined
  }
}

/**
 * Whether the current (latest) child turn began with a human-authored
 * admitted inbox input. Host-added context has no input identity and does not
 * determine turn origin. Later queued or steering inputs in that turn do not change
 * its origin: a delegated turn keeps normal parent settlement even if a human
 * steers mid-turn, while a human branch turn stays local even if delegated
 * work is queued behind it.
 * @param events - complete child Session event history.
 * @returns the human origin of the latest turn, or undefined for delegated turns.
 */
export function lastDirectHumanInput(events: readonly SessionEvent[]): { messageId: string; turnId: string } | undefined {
  let start = 0
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.type === 'turn/start') start = index + 1
  }
  const admitted = events.slice(start).flatMap(event => event.type === 'user/message' ? [event.data] : [])
  const admittedIds = new Set(admitted.map(message => message.id))
  const inputIds = new Set<MessageId>()
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    for (const message of event.data.inserted) {
      if (admittedIds.has(message.id)) inputIds.add(message.id)
    }
  }
  for (const message of admitted) {
    // Host context appended during admission or request routing has no inbox input identity.
    if (!inputIds.has(message.id)) continue
    const source = message.source as MessageSource & { rpcId?: string }
    if (source.kind === 'agent-message' && source.summaryPermit !== undefined) {
      return { messageId: message.id, turnId: source.summaryPermit.effectId }
    }
    return source.kind === 'user' && source.rpcId !== undefined
      ? { messageId: message.id, turnId: source.rpcId }
      : undefined
  }
  return undefined
}

function deliverySource(batchId: string, ledgerRev: number): ContinuityDeliverySource {
  return { kind: 'continuity-delivery', batchId, ledgerRev }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
