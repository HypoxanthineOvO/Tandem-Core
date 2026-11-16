/**
 * Service Definition for the user-questions capability seam (`ctx.userQuestions`): a UI-backed service for
 * pausing an agent tool call until the human answers a question. The model-
 * facing tool lives in `@deepseek-ai/dsh-tool-ask-user`; UI packages compose
 * answerers on the Agent-scoped Cordis waterfall.
 *
 * @module @deepseek-ai/dsh-user-questions
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError, type MessageId, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import { userQuestionProjectionDefinition } from './projection.ts'
import { TimedQuestionWait } from './timed-wait.ts'
export { HumanInteractionPolicy } from './policy.ts'
export type { HumanInteractionAdmission, HumanInteractionDecision } from './policy.ts'
import type {} from './policy.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    userQuestions: UserQuestionService
  }
}

import type {
  AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionRequestEvent, PendingUserQuestion,
  UserQuestionBatch, UserQuestionEntry, SubmitUserQuestionBatch, UserQuestionSubmission,
} from './types.ts'

export type {
  AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionIntent, AskUserQuestionItem,
  AskUserQuestionOption, PendingUserQuestion, SettledUserQuestion, UserQuestionProjectionView,
  UserQuestionState, UserQuestionBatch, UserQuestionEntry, UserQuestionBatchStatus, SubmitUserQuestionBatch, UserQuestionSubmission,
} from './types.ts'
export { isTimedAskUserQuestionSchema, TIMED_WAIT_PARAMETER } from './projection.ts'

/** Request for a human answer. */
export interface AskUserQuestionRequest extends AskUserQuestionRequestEvent {}

/** Timed ask result returned when the foreground answer window closes. */
export type TimedUserQuestionResult = AskUserQuestionAnswer | { pending: true; callId: ToolCallId }

/** Stable error taxonomy for user-questions failures. */
export class UserQuestionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserQuestionError'
  }
}

function abortedQuestion(cause?: unknown): UserQuestionError {
  return new UserQuestionError(
    'ask_user_question was aborted before the user answered',
    'ASK_ABORTED',
    cause === undefined ? undefined : { cause },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function restoreUserQuestionError(reason: unknown): unknown {
  if (reason instanceof UserQuestionError) return reason
  if (isRecord(reason)
    && reason.name === 'UserQuestionError'
    && typeof reason.message === 'string'
    && typeof reason.code === 'string') {
    return new UserQuestionError(reason.message, reason.code, { cause: reason })
  }
  return reason
}

type QueuedReply = { messageId: MessageId; claimedTurn?: number }

/** Deployment admission requirements for human interactions. */
export interface Config {
  /** Reject interactions when no humanInteractionPolicy provider exists. Defaults to false. */
  readonly requirePolicy?: boolean
}

/** `ctx.userQuestions`: validation plus the scoped answerer waterfall. */
export class UserQuestionService extends TypertRemoteService {
  static Config: z<Config> = z.object({ requirePolicy: z.boolean().default(false) })
  private readonly foreground = new Map<Agent, Map<ToolCallId, (answer: AskUserQuestionAnswer) => boolean>>()
  private readonly transactions = new WeakMap<Session, Promise<unknown>>()
  private readonly waits = new Map<Agent, Map<ToolCallId, TimedQuestionWait>>()
  private readonly queuedReplies = new WeakMap<Session, Map<ToolCallId, QueuedReply>>()

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'userQuestions')
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(userQuestionProjectionDefinition)
      projectionCtx.on('agent/created', async ({ agent }) => {
        for (const batch of this.query(agent.session)) {
          if (batch.acceptedAt === undefined && batch.status !== 'cancelled') {
            await this.markContinued(agent, batch.callId)
          } else if (batch.acceptedAt !== undefined && batch.deliveredAt === undefined) {
            await this.transaction(agent.session, () => this.deliver(agent, batch))
          }
        }
      }, { global: true })
    })
    ctx.effect(() => () => {
      for (const calls of this.waits.values()) {
        for (const wait of calls.values()) wait.close(abortedQuestion())
      }
      this.waits.clear()
    }, 'userQuestions: foreground waits')
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const source = message.source
      if (source.kind !== 'user-question-reply') return
      const calls = this.queuedReplies.get(agent.session) ?? new Map<ToolCallId, QueuedReply>()
      const reply = calls.get(source.callId)
      if (reply === undefined) {
        calls.set(source.callId, { messageId: message.id, claimedTurn: turn })
        this.queuedReplies.set(agent.session, calls)
      } else if (reply.messageId === message.id) {
        reply.claimedTurn = turn
      }
    }, { global: true })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const source = message.source
      if (source.kind === 'user-question-reply') this.releaseReply(agent.session, source.callId, message.id)
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message') {
        const source = event.data.source
        if (source.kind === 'user-question-reply') {
          this.releaseReply(session, source.callId, event.data.id)
        }
      } else if (event.type === 'turn/end') {
        const calls = this.queuedReplies.get(session)
        if (calls === undefined) return
        for (const [callId, reply] of calls) {
          if (reply.claimedTurn === event.data.turn) calls.delete(callId)
        }
      }
    }, { global: true })
  }

  private releaseReply(session: Session, callId: ToolCallId, messageId: MessageId): void {
    const calls = this.queuedReplies.get(session)
    if (calls?.get(callId)?.messageId !== messageId) return
    calls.delete(callId)
  }

  private assertAdmission(agent: Agent): void {
    const agents = this.ctx.get('agents')
    if (agents === undefined || agents.get(agent.id) !== agent) {
      throw new UserQuestionError(
        'human interaction requires the exact live calling agent when an agent is supplied',
        'CALLER_NOT_LIVE')
    }
    const parentChain: Agent[] = []
    let child = agent
    for (;;) {
      const parent = agents.list().find(candidate => agents.isOwnedBy(child.id, candidate))
      if (parent === undefined) break
      parentChain.push(parent)
      child = parent
    }
    const policy = this.ctx.get('humanInteractionPolicy')
    if (policy !== undefined) {
      const decision = policy.check({ agent, session: agent.session, isSubagent: parentChain.length > 0, parentChain })
      if (!decision.allowed) throw new UserQuestionError(decision.reason, 'INTERACTION_DENIED')
      return
    }
    if (this.config.requirePolicy === true) {
      throw new UserQuestionError('human interaction requires a configured admission provider', 'POLICY_REQUIRED')
    }
    if (parentChain.length > 0) {
      throw new UserQuestionError(
        'human interaction is unavailable while the calling agent is owned by another live agent; '
        + "include the unresolved question or decision in the child agent's final result",
        'DELEGATED_CALLER')
    }
  }

  /** Read this Session's projected question batches, including pre-extension timed calls.
   * @param session - Session to query; no Agent is materialized or woken.
   * @returns Durable revisions plus legacy answerable calls.
   */
  query(session: Session): readonly UserQuestionBatch[] {
    const projections = this.ctx.get('sessionProjections')
    if (projections === undefined) throw new UserQuestionError('question projection service is unavailable', 'NO_PROJECTION')
    const state = projections.stateOf(session, 'userQuestions')
    if (state === undefined) throw new UserQuestionError('question projection is unavailable', 'NO_PROJECTION')
    const view = state.questions
    const batches = view.batches ?? []
    return [...batches, ...view.active.filter(row => !batches.some(batch => batch.callId === row.callId)).map(row => ({
      sessionId: session.id, asker: session.id, callId: row.callId, questions: row.questions,
      createdAt: state.callTimes?.[row.callId] ?? session.header.createdAt, revision: 0, status: row.state, answers: [],
    }))]
  }

  /** Aggregate a root tree from caller-supplied Sessions, including detached/cold reads.
   * @param root - Exact root Session identity.
   * @param sessions - Sessions supplied by the tree owner, including the root and complete parent chains.
   * @returns Batches whose durable parent chain reaches the named root; no cold Agent is created.
   */
  queryTree(root: Session['id'], sessions: readonly Session[]): readonly UserQuestionBatch[] {
    const byId = new Map(sessions.map(session => [session.id, session]))
    return sessions.filter((session) => {
      const visited = new Set<Session['id']>()
      let cursor: Session | undefined = session
      while (cursor !== undefined && !visited.has(cursor.id)) {
        if (cursor.id === root) return true
        visited.add(cursor.id)
        cursor = cursor.header.parentSession === undefined ? undefined : byId.get(cursor.header.parentSession)
      }
      return false
    }).flatMap(session => [...this.query(session)])
  }

  /** List individual questions for a Session decision queue.
   * @param session - Session already opened by the tree owner.
   * @returns One row per stable question identity, including staged answers and delivery facts.
   */
  listQuestions(session: Session): readonly UserQuestionEntry[] {
    return this.query(session).flatMap(({ questions, answers, ...batch }) => questions.map((question) => {
      const stagedAnswer = answers.find(answer => answer.id === question.id)
      return { ...batch, questionId: question.id, question: question.question,
        options: question.options ?? [], multiSelect: question.multiSelect === true, allowCustom: question.allowCustom !== false,
        status: batch.deliveredAt !== undefined && stagedAnswer !== undefined
          ? stagedAnswer.selected.length === 0 && !stagedAnswer.custom ? 'skipped' as const : 'answered' as const
          : batch.status,
        ...(stagedAnswer === undefined ? {} : { stagedAnswer }) }
    }))
  }

  /** Observe committed changes; callbacks do not wake models.
   * @param listener - Receives the owning Session and its projection after a relevant event.
   * @returns Idempotent unsubscription; service teardown also removes the listener.
   */
  subscribe(listener: (session: Session, batches: readonly UserQuestionBatch[]) => void): () => void {
    return this.ctx.on('session/event', (session, event) => {
      if (event.type === 'user-question/batch' || event.type === 'tool/result' || event.type === 'user/message') {
        listener(session, this.query(session))
      }
    }, { global: true })
  }

  private async commit(session: Session, batch: UserQuestionBatch): Promise<void> {
    session.append('user-question/batch', batch)
    const sessions = this.ctx.get('sessions')
    if (sessions !== undefined) await sessions.flush(session)
  }

  private transaction<T>(session: Session, action: () => Promise<T>): Promise<T> {
    const previous = this.transactions.get(session) ?? Promise.resolve()
    const result = previous.catch(() => { /* A failed transaction does not poison the next one. */ }).then(action)
    this.transactions.set(session, result)
    void result.finally(() => {
      if (this.transactions.get(session) === result) this.transactions.delete(session)
    }).catch(() => { /* The caller owns the original rejection. */ })
    return result
  }

  private batch(agent: Agent, callId: ToolCallId): UserQuestionBatch {
    const batch = this.query(agent.session).find(item => item.callId === callId)
    if (batch === undefined) throw new UserQuestionError('the question call does not exist', 'QUESTION_NOT_FOUND')
    return batch
  }

  private validateAnswers(batch: UserQuestionBatch, answers: readonly AskUserQuestionAnswerItem[], complete: boolean): void {
    const ids = new Set(answers.map(answer => answer.id))
    if (ids.size !== answers.length || (complete && answers.length !== batch.questions.length)) {
      throw new UserQuestionError('the answer batch must name each question exactly once', 'BAD_ANSWER')
    }
    for (const answer of answers) {
      const question = batch.questions.find(item => item.id === answer.id)
      if (question === undefined || (question.multiSelect !== true && answer.selected.length > 1)
        || new Set(answer.selected).size !== answer.selected.length
        || (question.options !== undefined && answer.selected.some(label => !question.options?.some(option => option.label === label)))
        || (question.allowCustom === false && answer.custom !== undefined && answer.custom.length > 0)) {
        throw new UserQuestionError('the answer does not match the offered question', 'BAD_ANSWER')
      }
    }
  }

  private async acquireSessionAgent(sessionId: SessionId, signal: AbortSignal) {
    const held = await this.ctx.get('sessionAgentAcquisition')?.acquire(sessionId, signal)
    if (held !== undefined) return held
    // Preserve the ordinary API resolver's ownership and resume policy.
    const resolved = await this.ctx.get('typert')?.lookups.get('agent')?.resolve(sessionId)
    const agent = this.ctx.get('agents')?.get(sessionId)
    if (agent === undefined || resolved !== agent) {
      throw new UserQuestionError('the question Session has no live Agent resolver', 'CALLER_NOT_LIVE')
    }
    return { agent, release() {} }
  }

  /** Stage an answer by Session identity, retaining specialized owners through commit.
   * @param sessionId - Question owner Session.
   * @param callId - Owning tool call.
   * @param answer - One answer or explicit skip.
   * @param expectedRevision - Optional projected revision comparison.
   * @param signal - Acquisition cancellation.
   * @returns Durable staging receipt, including conflicts.
   */
  @Remote({ resources: { session: sessionId => sessionId } })
  async stageSessionAnswer(sessionId: SessionId, callId: ToolCallId, answer: AskUserQuestionAnswerItem, expectedRevision: number | undefined, signal: AbortSignal): Promise<UserQuestionSubmission> {
    const held = await this.acquireSessionAgent(sessionId, signal)
    try { return await this.stageAnswer(held.agent, callId, answer, expectedRevision) }
    finally { held.release() }
  }

  /** Submit a complete batch by Session identity through the same admission and CAS checks.
   * @param sessionId - Question owner Session.
   * @param callId - Owning tool call.
   * @param submission - Complete answers and editing revision.
   * @param signal - Acquisition cancellation.
   * @returns Durable acceptance or conflict receipt.
   */
  @Remote({ resources: { session: sessionId => sessionId } })
  async submitSessionBatch(sessionId: SessionId, callId: ToolCallId, submission: SubmitUserQuestionBatch, signal: AbortSignal): Promise<UserQuestionSubmission> {
    const held = await this.acquireSessionAgent(sessionId, signal)
    try { return await this.submitBatch(held.agent, callId, submission) }
    finally { held.release() }
  }

  /** Attach a foreground wait by Session identity; stream closure releases residency.
   * @param sessionId - Question owner Session.
   * @param callId - Foreground tool call.
   * @param signal - Stream and acquisition lifetime.
   * @returns Host-computed remaining duration while the wait is live.
   */
  @Remote({ mode: 'stream', resources: { session: sessionId => sessionId } })
  async *attachSessionWait(sessionId: SessionId, callId: ToolCallId, signal: AbortSignal): AsyncIterable<{ remainingMs: number }> {
    const held = await this.acquireSessionAgent(sessionId, signal)
    try { yield* this.attachWait(held.agent, callId, signal) }
    finally { held.release() }
  }

  /** Durably stage one answer without delivering an incomplete batch.
   * @param agent - Exact live question owner.
   * @param callId - Owning call.
   * @param answer - One explicit answer or skip.
   * @param expectedRevision - Optional comparison against the projected revision.
   * @returns New batch, or conflict/already-submitted without side effects.
   */
  @Remote
  async stageAnswer(agent: Agent, callId: ToolCallId, answer: AskUserQuestionAnswerItem, expectedRevision?: number): Promise<UserQuestionSubmission> {
    this.assertAdmission(agent)
    return this.transaction(agent.session, async () => {
      const batch = this.batch(agent, callId)
      if (batch.acceptedAt !== undefined) return { status: 'already-submitted', batch }
      if (batch.status === 'cancelled') return { status: 'closed', batch }
      if (expectedRevision !== undefined && expectedRevision !== batch.revision) return { status: 'conflict', batch }
      this.validateAnswers(batch, [answer], false)
      const next = { ...batch, revision: batch.revision + 1, status: 'partial' as const,
        answers: [...batch.answers.filter(item => item.id !== answer.id), answer] }
      await this.commit(agent.session, next)
      return { status: 'submitted', batch: next }
    })
  }

  /** Accept one complete batch exactly once, resolving a live wait or queueing a late reply.
   * @param agent - Exact live question owner; RPC resolution must preserve native parent ownership.
   * @param callId - Owning call.
   * @param submission - Complete answers, or previously staged answers, and optional revision comparison.
   * @returns Durable acceptance receipt; repeated submissions never deliver a second reply.
   */
  @Remote
  async submitBatch(agent: Agent, callId: ToolCallId, submission: SubmitUserQuestionBatch): Promise<UserQuestionSubmission> {
    this.assertAdmission(agent)
    return this.transaction(agent.session, async () => {
      const batch = this.batch(agent, callId)
      if (batch.acceptedAt !== undefined) return { status: 'already-submitted', batch }
      if (batch.status === 'cancelled') return { status: 'closed', batch }
      if (submission.expectedRevision !== undefined && submission.expectedRevision !== batch.revision) return { status: 'conflict', batch }
      const answers = submission.answers ?? [...batch.answers]
      this.validateAnswers(batch, answers, true)
      const next: UserQuestionBatch = { ...batch, revision: batch.revision + 1,
        status: 'answer-queued', answers, acceptedAt: Date.now() }
      await this.commit(agent.session, next)
      const resolve = this.foreground.get(agent)?.get(callId)
      if (resolve?.({ answers }) === true) {
        return { status: 'submitted', batch: next }
      }
      await this.deliver(agent, next)
      return { status: 'submitted', batch: this.batch(agent, callId) }
    })
  }

  private async markContinued(agent: Agent, callId: ToolCallId): Promise<void> {
    await this.transaction(agent.session, async () => {
      const batch = this.query(agent.session).find(row => row.callId === callId)
      if (batch === undefined || batch.acceptedAt !== undefined || batch.status !== 'open'
        || this.continued(agent).some(question => question.callId === callId)) return
      await this.commit(agent.session, { ...batch, revision: batch.revision + 1, status: 'continued' })
    })
  }

  private async deliver(agent: Agent, batch: UserQuestionBatch): Promise<void> {
    const matches = (message: UserMessage): boolean => message.source.kind === 'user-question-reply' && message.source.callId === batch.callId
    if (this.queuedReplies.get(agent.session)?.has(batch.callId)
      || agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return
    const message = createUserMessage({
      source: { kind: 'user-question-reply', callId: batch.callId, outcome: 'answered' },
      content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question',
        callId: batch.callId, questions: batch.questions, answers: batch.answers }) }],
    })
    try {
      agent.steer(message)
      const sessions = this.ctx.get('sessions')
      if (sessions !== undefined) await sessions.flush(agent.session)
    } catch (error) {
      await this.commit(agent.session, { ...batch, revision: batch.revision + 1,
        error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  private continued(agent: Agent): readonly PendingUserQuestion[] {
    const state = this.ctx.get('sessionProjections')?.stateOf(agent.session, 'userQuestions')
    return (state?.questions.active ?? []).filter(question => question.state === 'continued')
  }

  /**
   * Answer a continued question. The reply is steered into the agent as a
   * user message whose source names the call; that message is also the
   * record that closes the question in the projection.
   * @param agent - Admitted live agent for the owning Session.
   * @param callId - Continued question identity.
   * @param answer - Complete structured answer batch, one item per question of the call.
   * @returns Whether the question is still continued; an accepted reply stays
   *   queued until the agent admits its user message.
   * @throws {UserQuestionError} `BAD_ANSWER` when the batch does not name each
   *   question of the call exactly once, or `REPLY_QUEUED` when a reply is
   *   already waiting for admission.
   */
  @Remote
  answer(agent: Agent, callId: ToolCallId, answer: AskUserQuestionAnswer): boolean {
    this.assertAdmission(agent)
    const question = this.continued(agent).find(item => item.callId === callId)
    if (question === undefined) return false
    const queued = this.queuedReplies.get(agent.session)
    const matches = (message: UserMessage): boolean =>
      message.source.kind === 'user-question-reply' && message.source.callId === callId
    if (queued?.has(callId) || agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) {
      throw new UserQuestionError('a reply is already queued for this question', 'REPLY_QUEUED')
    }
    // The gateway validated the batch's shape from the type; the model-facing
    // contract also promises one item per question, which only this owner of
    // the asked questions can check before the batch reaches the model.
    const answered = new Set(answer.answers.map(item => item.id))
    if (answered.size !== answer.answers.length
      || question.questions.length !== answer.answers.length
      || !question.questions.every(item => answered.has(item.id))) {
      throw new UserQuestionError(
        `the answer batch for ${callId} must name each of its ${String(question.questions.length)} questions exactly once`,
        'BAD_ANSWER')
    }
    const message = createUserMessage({
      source: { kind: 'user-question-reply', callId, outcome: 'answered' },
      content: [{
        type: 'text',
        text: JSON.stringify({
          kind: 'answer_to_pending_question', tool: 'ask_user_question', callId,
          questions: question.questions, answers: answer.answers,
        }),
      }],
    })
    const calls = queued ?? new Map<ToolCallId, QueuedReply>()
    calls.set(callId, { messageId: message.id })
    this.queuedReplies.set(agent.session, calls)
    try {
      agent.steer(message)
    } catch (error: unknown) {
      this.releaseReply(agent.session, callId, message.id)
      throw error
    }
    return true
  }

  /**
   * Let one answer UI hold a live timed wait. Closing the stream releases its claim.
   * @param agent - Admitted live agent owning the question.
   * @param callId - Foreground tool call to attach to.
   * @param signal - Remote stream cancellation, including Client disconnect.
   * @returns One Host-computed remaining duration, or no frames once the wait ended.
   */
  @Remote({ mode: 'stream' })
  async *attachWait(agent: Agent, callId: ToolCallId, signal: AbortSignal): AsyncIterable<{ remainingMs: number }> {
    this.assertAdmission(agent)
    const wait = this.waits.get(agent)?.get(callId)
    if (wait !== undefined) yield* wait.attach(signal)
  }

  /**
   * Foreground wait whose first settlement the Client decides: the Client
   * rejects with `ASK_TIMED_OUT` when its countdown ends, and this method maps
   * that code to the pending result.
   * @param request - Questions, live owner agent, and abort signal.
   * @param callId - Tool call identity the Client card is keyed by.
   * @param timeoutMs - Positive foreground wait in milliseconds.
   * @returns The answer when it arrives inside the window, otherwise a pending
   *   result, also when no connected Client claimed the request by the deadline.
   * @throws {UserQuestionError} `BAD_TIMEOUT` for a non-integer, non-positive,
   *   or oversized wait.
   */
  async askTimed(
    request: AskUserQuestionRequest & { agent: Agent },
    callId: ToolCallId,
    timeoutMs: number,
  ): Promise<TimedUserQuestionResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new UserQuestionError('timeout must fit a positive platform timer', 'BAD_TIMEOUT')
    }
    this.assertAdmission(request.agent)
    const calls = this.waits.get(request.agent) ?? new Map<ToolCallId, TimedQuestionWait>()
    if (calls.has(callId)) throw new UserQuestionError('the question call already has a foreground wait', 'DUPLICATE_WAIT')
    const wait = new TimedQuestionWait(Date.now() + timeoutMs, request.signal,
      new UserQuestionError('ask_user_question timed out before the user answered', 'ASK_TIMED_OUT'))
    calls.set(callId, wait)
    this.waits.set(request.agent, calls)
    try {
      try {
        return await this.ask({ ...request, signal: wait.signal, wait: { callId, timed: true } })
      } catch (error) {
        if (wait.signal.aborted) throw wait.signal.reason
        if (error instanceof UserQuestionError && error.code === 'NO_PROVIDER') {
          await wait.done
          throw wait.signal.reason
        }
        throw error
      }
    } catch (error) {
      if (error instanceof UserQuestionError && error.code === 'ASK_TIMED_OUT') {
        await this.markContinued(request.agent, callId)
        return { pending: true, callId }
      }
      if (wait.signal.aborted) throw abortedQuestion(error)
      throw error
    } finally {
      wait.close(abortedQuestion())
      calls.delete(callId)
      if (calls.size === 0) this.waits.delete(request.agent)
    }
  }

  /**
   * Ask the scoped answerer waterfall and wait for the user's answer.
   *
   * Exact live caller identity is always checked. A deployment policy may
   * admit owned children; without a policy only runtime roots are admitted.
   * requirePolicy rejects a missing policy. Agentless local answerers remain
   * available only when no policy is installed or required.
   *
   * @param request Questions, owner agent, and abort signal.
   * @returns The answer chosen or typed by the human.
   * @throws {UserQuestionError} code `ASK_ABORTED` when the supplied signal
   *   is already or becomes aborted, `CALLER_NOT_LIVE` when a supplied agent
   *   is not the registry's exact live instance, or `DELEGATED_CALLER` when
   *   that live agent is owned by another agent.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      throw abortedQuestion()
    }
    if (request.questions.length === 0) {
      throw new UserQuestionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS')
    }
    const agent = request.agent
    if (agent !== undefined) this.assertAdmission(agent)
    else if (this.config.requirePolicy === true || this.ctx.get('humanInteractionPolicy') !== undefined) {
      throw new UserQuestionError('human interaction requires an exact live caller', 'CALLER_NOT_LIVE')
    }
    // A presentation intent asserts two things the types cannot: that the
    // named approve label is one of this question's own options, and that a
    // plan-review carries the plan it is a review of. A UI honouring the
    // intent answers with that label, and shows that detail as the plan, so
    // either gap would put a choice the asker never offered — or an approval of
    // something invisible — in front of the user. Caught at the asker, where
    // the mistake is, rather than in each UI.
    for (const question of request.questions) {
      const intent = question.intent
      if (intent === undefined) continue
      if (!(question.options ?? []).some(option => option.label === intent.approve)) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} whose approve label `
          + `${JSON.stringify(intent.approve)} names none of its options`,
          'BAD_INTENT')
      }
      if (question.detail === undefined) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} without the detail it reviews`,
          'BAD_INTENT')
      }
    }
    const callId = request.wait?.callId
    let completion: ReturnType<typeof Promise.withResolvers<AskUserQuestionAnswer>> | undefined
    if (agent !== undefined && callId !== undefined) {
      this.query(agent.session)
      if (!this.ctx.get('sessionProjections')?.stateOf(agent.session, 'userQuestions')?.questions.batches?.some(batch => batch.callId === callId)) {
        await this.commit(agent.session, { sessionId: agent.id, asker: agent.id, callId,
          questions: request.questions, createdAt: Date.now(), revision: 0, status: 'open', answers: [] })
      }
      completion = Promise.withResolvers<AskUserQuestionAnswer>()
      const calls = this.foreground.get(agent) ?? new Map<ToolCallId, (answer: AskUserQuestionAnswer) => boolean>()
      const resolve = completion.resolve
      calls.set(callId, (answer) => {
        if (request.signal?.aborted) return false
        resolve(answer)
        return true
      })
      this.foreground.set(agent, calls)
    }
    const noAnswerer = () => Promise.reject(new UserQuestionError(
      'no user-questions answerer accepted the request',
      'NO_PROVIDER',
    ))
    try {
      const presentation = (agent === undefined
        ? this.ctx.waterfall('user-questions/request', request, noAnswerer)
        : this.ctx.waterfall(
          scopeTarget(agent, agent),
          'user-questions/request',
          { ...request, agent },
          noAnswerer,
        ))
      // A missing presentation must not prevent a queue consumer resolving a live wait.
      const waiting = completion
      let onAbort: (() => void) | undefined
      if (waiting !== undefined) {
        onAbort = () => { waiting.reject(request.signal?.reason ?? abortedQuestion()) }
        request.signal?.addEventListener('abort', onAbort, { once: true })
        if (request.signal?.aborted) onAbort()
      }
      try {
        const answer = waiting === undefined ? await presentation
          : await Promise.race([waiting.promise, presentation.catch((error) => {
            if (restoreUserQuestionError(error) instanceof UserQuestionError
              && (restoreUserQuestionError(error) as UserQuestionError).code === 'NO_PROVIDER'
              && request.wait?.timed === true) return waiting.promise
            throw error
          })])
        if (agent !== undefined && callId !== undefined) {
          const batch = this.batch(agent, callId)
          if (batch.acceptedAt === undefined) await this.submitBatch(agent, callId, { answers: answer.answers })
        }
        return answer
      } finally {
        if (onAbort !== undefined) request.signal?.removeEventListener('abort', onAbort)
      }
    } catch (error) {
      const restored = restoreUserQuestionError(error)
      if (restored instanceof UserQuestionError) throw restored
      if (request.signal?.aborted) {
        throw abortedQuestion(error)
      }
      throw restored
    } finally {
      if (agent !== undefined && callId !== undefined) {
        const calls = this.foreground.get(agent)
        calls?.delete(callId)
        if (calls?.size === 0) this.foreground.delete(agent)
      }
    }
  }
}

export default UserQuestionService
