/** Client-safe question, answer, and event types. @module @deepseek-ai/dsh-user-questions/types */

import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-projection/types'

/** One selectable answer offered to the user. */
export interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}

/**
 * A caller-declared presentation intent: the question IS this kind of
 * decision, so a UI that recognises the tag may present it as such instead of as a
 * generic option list. Tagged so further intents can be added; a UI that does
 * not know a tag renders the generic flow, and the answer encoding is identical
 * either way — an intent changes presentation only, never the protocol.
 */
export type AskUserQuestionIntent = {
  /** A plan submitted for review: `detail` is the plan markdown `ask()` requires, and the decision approves or declines it. */
  kind: 'plan-review'
  /**
   * The option label that approves the plan; every other option declines it.
   * Named rather than positional so no UI infers the verdict from option order.
   * An `approve` naming no option of its own question is rejected at `ask()`.
   */
  approve: string
  /** Logged tool invocation whose arguments contain the reviewed plan. */
  callId?: ToolCallId
}

/** One question in a user-questions request. */
export interface AskUserQuestionItem {
  /** Stable caller-provided question id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional supporting detail rendered with the question but kept out of option labels. */
  detail?: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices the UI can render as a menu. */
  options?: AskUserQuestionOption[]
  /** Whether more than one option may be selected. Defaults to single-select. */
  multiSelect?: boolean
  /** Whether custom text is accepted; absence permits it. */
  allowCustom?: boolean
  /** Optional presentation intent for capable UIs; absent asks for the generic option list. */
  intent?: AskUserQuestionIntent
}

/** Answer to one question. */
export interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. May accompany custom text for a multi-select question. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}

/** The human's answer. */
export interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[]
}

/** `open` while the tool call may still return the answer; `continued` once the answer can only arrive as a new turn. */
export type UserQuestionState = 'open' | 'continued'

/** One unanswered timed `ask_user_question` call reconstructed from the Session log. */
export interface PendingUserQuestion {
  readonly callId: ToolCallId
  readonly questions: readonly AskUserQuestionItem[]
  readonly state: UserQuestionState
}

/**
 * One timed `ask_user_question` call and the answers it settled with: the
 * batch its own result carried when the user answered inside the window,
 * otherwise the batch its late reply carried, because that call's own result
 * recorded the timeout. A transcript row reads what the user finally answered
 * from here, and only a call listed here was a timed one.
 */
export interface SettledUserQuestion {
  /** The settled call. */
  readonly callId: ToolCallId
  /** The recorded batch, one entry per question; empty when the late reply carried none. */
  readonly answers: readonly AskUserQuestionAnswerItem[]
}

/** Durable batch lifecycle, independent of foreground Promise lifetime. */
export type UserQuestionBatchStatus = 'open' | 'continued' | 'partial' | 'answer-queued' | 'answered' | 'skipped' | 'cancelled'

/** One call and its staged or accepted answers, owned by the question projection. */
export interface UserQuestionBatch {
  readonly sessionId: SessionId
  readonly callId: ToolCallId
  readonly asker: SessionId
  readonly questions: readonly AskUserQuestionItem[]
  readonly createdAt: number
  readonly revision: number
  readonly status: UserQuestionBatchStatus
  readonly answers: readonly AskUserQuestionAnswerItem[]
  readonly acceptedAt?: number
  readonly deliveredAt?: number
  readonly error?: string
}

/** One question row for queue consumers; identity is (sessionId, callId, questionId). */
export interface UserQuestionEntry extends Omit<UserQuestionBatch, 'questions' | 'answers'> {
  readonly questionId: string
  readonly question: string
  readonly options: readonly AskUserQuestionOption[]
  readonly multiSelect: boolean
  readonly allowCustom: boolean
  readonly stagedAnswer?: AskUserQuestionAnswerItem
}

/** Submission compares revisions before accepting a complete batch; omitted answers use staged answers. */
export interface SubmitUserQuestionBatch {
  readonly answers?: AskUserQuestionAnswerItem[]
  readonly expectedRevision?: number
}

/** Idempotent batch receipt; accepted does not imply admission by the model. */
export interface UserQuestionSubmission {
  readonly status: 'submitted' | 'already-submitted' | 'conflict' | 'closed'
  readonly batch: UserQuestionBatch
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A committed question batch revision; readers project this without recreating foreground waits.
     * @persistenceRequired
     */
    'user-question/batch': UserQuestionBatch
  }
}

/** Answerable, settled, and revisioned batches projected from one Session log. */
export interface UserQuestionProjectionView {
  /** Durable batch revisions; absent in histories that only contain legacy tool events. */
  readonly batches?: readonly UserQuestionBatch[]
  /** Calls that can still take an answer, in ask order. */
  readonly active: readonly PendingUserQuestion[]
  /** Calls an answer settled, in settlement order. */
  readonly settled: readonly SettledUserQuestion[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Late reply to a continued `ask_user_question` call, steered into the
     * agent by `dsh-user-questions` as an answer batch. Closing a question
     * panel persists no reply. Readers preserve this message without the
     * producer; only the `userQuestions` projection reads the kind to close
     * the question and record its answers.
     * @persistenceAttribution
     */
    'user-question-reply': { kind: 'user-question-reply'; callId: ToolCallId; outcome: 'answered' }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Timed questions that remain answerable in this Session, and the ones a late reply settled. */
    userQuestions: UserQuestionProjectionView
  }
}

/** Client-safe payload declared for the user-question answerer waterfall. */
export interface AskUserQuestionRequestEvent {
  /** Questions to display. */
  questions: AskUserQuestionItem[]
  /** Agent identity projected to the corresponding Client Context in transit. */
  agent?: Agent
  /** Cancellation lifetime of the pending request. */
  signal?: AbortSignal
  /**
   * Tool call the Client card is keyed by. Timed answerers attach to the
   * business wait stream before starting their local countdown.
   */
  wait?: {
    /** Tool call the Client card is keyed by. */
    callId: ToolCallId
    /** True for a foreground wait that requires a Client claim; absent for indefinite waits. */
    timed?: boolean
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for structured user input. Return an answer to
     * claim the request or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param request - pending user-question request.
     * @mode waterfall
     */
    'user-questions/request'(
      this: Scoped<Agent>,
      request: AskUserQuestionRequestEvent,
      next: () => Promise<AskUserQuestionAnswer>,
    ): Promise<AskUserQuestionAnswer>
  }
}
