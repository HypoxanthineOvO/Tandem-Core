# User Interaction

English | [中文](user-questions.zh.md)

The user-questions seam of [dsh-user-questions](../../packages/interaction/user-questions). It is the provider-neutral vocabulary a tool or permission plugin uses when it needs the human to answer before the agent can continue. Agent-scoped waterfall listeners compose the available UI surfaces, including listeners relayed to a connected client.

Source: [`packages/interaction/user-questions/src/index.ts`](../../packages/interaction/user-questions/src/index.ts)

## Question options

`AskUserQuestionOption` contains one selectable choice. `label` is the user-facing option text and also the model-facing selected value; `description` is optional UI help text.

```ts type-equiv
/** One selectable answer offered to the user. */
interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}
```

## Presentation intent

`AskUserQuestionIntent` optionally declares a known decision kind. It is tagged on `kind` so intents can be added; a UI that does not recognise a tag renders the generic option list. An intent changes presentation only — a UI honouring it answers with the same option labels a generic UI would send, so the caller reads the same answer fields either way. `approve` names the affirmative option instead of relying on option order. `ask()` rejects the two assertions no type can carry: an `approve` naming none of its own question's options, and an intent on a question with no `detail`.

```ts type-equiv
/**
 * A caller-declared presentation intent: the question IS this kind of
 * decision, so a UI that recognises the tag may present it as such instead of as a
 * generic option list. Tagged so further intents can be added; a UI that does
 * not know a tag renders the generic flow, and the answer encoding is identical
 * either way — an intent changes presentation only, never the protocol.
 */
type AskUserQuestionIntent = {
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
```

## Question item

`AskUserQuestionItem` is one question in a request. The caller supplies a stable `id`, which is echoed back with the answer so batched questions remain routable. Optional `detail` carries supporting text that providers render with the question but keep out of selectable option labels.

```ts type-equiv
/** One question in a user-questions request. */
interface AskUserQuestionItem {
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
```

## Ask request

`AskUserQuestionRequest` is the cross-package request. `questions` is an array so a UI can present related prompts in one flow while preserving a stable id per answer. When present, `agent` is the exact live caller; the service always verifies its live registry identity. Without a policy only runtime roots are admitted. An optional `HumanInteractionPolicy` provider may admit selected children; `requirePolicy: true` refuses a missing provider. An installed or required policy also rejects agentless requests.

```ts type-equiv
/** Request for a human answer. */
interface AskUserQuestionRequest extends AskUserQuestionRequestEvent {}
```

## Answer

Providers return one answer item per question id. `selected` contains selected option labels, and `custom` carries a free-form "Other" answer when the user typed one. For a single-select question, `custom` overrides the selected choice and `selected` is empty. For a multi-select question, `custom` may supplement the labels in `selected`. A UI may also use an item with empty `selected` and no `custom` to preserve a skipped question in an otherwise completed batch.

```ts type-equiv
/** Answer to one question. */
interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. May accompany custom text for a multi-select question. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}
```

```ts type-equiv
/** The human's answer. */
interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[]
}
```

Timed answerers receive `wait: { callId, timed: true }`. The call id identifies the card and the foreground wait. The Client calls `attachWait` to claim the wait and obtain its remaining duration; transport forwards the original event without inspecting or rewriting these fields. A `wait` without `timed` identifies an indefinite card-keyed request. An absent `wait` identifies a blocking request without a card key.

```ts type-equiv
/** Client-safe payload declared for the user-question answerer waterfall. */
interface AskUserQuestionRequestEvent {
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
```

## Timed questions and late replies

A timed question waits for a bounded foreground window and then lets the agent continue independent work. If the user answers inside the window, the tool returns the answer batch; otherwise `TimedUserQuestionResult` is `{ pending: true, callId }`. Pending means the question is still answerable; it is not an empty answer, a refusal, a confirmation, or permission.

```ts type-equiv
/** Timed ask result returned when the foreground answer window closes. */
type TimedUserQuestionResult = AskUserQuestionAnswer | { pending: true; callId: ToolCallId }
```

A Client claim is a business Remote stream, not a Gateway delivery. `TimedQuestionWait` holds the original Host deadline and runs its timer only while no claim exists. Its `attachWait` stream yields the current remaining duration, and the Client counts down with its own clock. Focus, editing, and Take time stay local. Stream cancellation releases that claim; after the last claim leaves, the Host resumes the original deadline. An unattended timeout aborts the foreground waterfall's private signal and returns pending without cancelling the Turn. Gateway and `api-remotes` contain no question-specific timing policy.

The `userQuestions` Session projection folds tool calls/results, PTC dispatches, admitted replies, and `user-question/batch` revisions. The batch revision retains its complete questions, staged answers, acceptance and delivery facts. Native timed calls remain reconstructable from the logged tool schema and events even without batch revisions. A foreground timeout or restart makes the call continued without recreating its old Promise; local focus, countdowns and Client claims are not persisted.

```ts type-equiv
/** `open` while the tool call may still return the answer; `continued` once the answer can only arrive as a new turn. */
type UserQuestionState = 'open' | 'continued'
```

```ts type-equiv
/** One unanswered timed `ask_user_question` call reconstructed from the Session log. */
interface PendingUserQuestion {
  readonly callId: ToolCallId
  readonly questions: readonly AskUserQuestionItem[]
  readonly state: UserQuestionState
}
```

```ts type-equiv
/**
 * One timed `ask_user_question` call and the answers it settled with: the
 * batch its own result carried when the user answered inside the window,
 * otherwise the batch its late reply carried, because that call's own result
 * recorded the timeout. A transcript row reads what the user finally answered
 * from here, and only a call listed here was a timed one.
 */
interface SettledUserQuestion {
  /** The settled call. */
  readonly callId: ToolCallId
  /** The recorded batch, one entry per question; empty when the late reply carried none. */
  readonly answers: readonly AskUserQuestionAnswerItem[]
}
```

```ts type-equiv
/** Answerable, settled, and revisioned batches projected from one Session log. */
interface UserQuestionProjectionView {
  /** Durable batch revisions; absent in histories that only contain legacy tool events. */
  readonly batches?: readonly UserQuestionBatch[]
  /** Calls that can still take an answer, in ask order. */
  readonly active: readonly PendingUserQuestion[]
  /** Calls an answer settled, in settlement order. */
  readonly settled: readonly SettledUserQuestion[]
}
```

`stageAnswer(agent, callId, answer, expectedRevision?)` persists one explicit answer without delivering an incomplete batch. `submitBatch(agent, callId, { answers?, expectedRevision? })` validates the complete question-id set and compares the optional revision. Omitting answers submits staged answers. A stale revision returns `conflict`; every repeat of an accepted submission returns `already-submitted` without another reply. After flushing acceptance, the service resolves an extant foreground wait or queues a `user-question-reply` for the exact asking agent. Delivery is recorded by the tool result or admitted user message, independently of acceptance. An accepted but undelivered batch is recovered when its Agent is recreated. The legacy `answer` RPC remains continued-only; native keyed cards use `submitBatch`.

`query(session)` returns batch revisions, `listQuestions(session)` returns individual queue rows, and `queryTree(rootSessionId, sessions)` selects a durable root tree from caller-supplied Sessions. A row identifies sessionId/callId/questionId and includes asker, text, options, multiSelect, allowCustom, createdAt, revision, lifecycle status, stagedAnswer, acceptedAt, deliveredAt, and error. `subscribe(listener)` observes committed question projection changes and returns an unsubscribe function owned by the caller. See the [package reference](../../packages/interaction/user-questions/README.md) for provider composition and persistence limitations.

Closing a Client panel sends nothing. After restart, native RPC resolution restores the original asking Agent and its real parent chain. A Manager reply is never redirected to its Main.

## Errors

`UserQuestionError` extends `HarnessError`, so `ctx.tools.execute()` preserves `{ name, code }` for model-facing tool failures such as `EMPTY_QUESTIONS`, `BAD_INTENT`, `NO_PROVIDER`, `ASK_ABORTED`, or UI-side cancellation.

```ts type-equiv
/** Stable error taxonomy for user-questions failures. */
class UserQuestionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserQuestionError'
  }
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhumaninteractionpolicy--humaninteractionpolicy-abstract-seam"></a>

### `ctx.humanInteractionPolicy` — `HumanInteractionPolicy` (abstract seam)

Optional provider; without one userQuestions retains runtime-root-only admission.

```ts cordis-catalog
/** Decide whether this exact live caller may interact with the human.
 * @param request - Caller and runtime ancestry.
 * @returns Admission or an explicit denial reason.
 */
abstract check(request: HumanInteractionAdmission): HumanInteractionDecision
```

Source: [`packages/interaction/user-questions/src/policy.ts`](../../packages/interaction/user-questions/src/policy.ts)

<a id="ctxuserquestions--userquestionservice"></a>

### `ctx.userQuestions` — `UserQuestionService`

`ctx.userQuestions`: validation plus the scoped answerer waterfall.

```ts cordis-catalog
/** Read this Session's projected question batches, including pre-extension timed calls.
 * @param session - Session to query; no Agent is materialized or woken.
 * @returns Durable revisions plus legacy answerable calls.
 */
query(session: Session): readonly UserQuestionBatch[]

/** Aggregate a root tree from caller-supplied Sessions, including detached/cold reads.
 * @param root - Exact root Session identity.
 * @param sessions - Sessions supplied by the tree owner, including the root and complete parent chains.
 * @returns Batches whose durable parent chain reaches the named root; no cold Agent is created.
 */
queryTree(root: Session['id'], sessions: readonly Session[]): readonly UserQuestionBatch[]

/** List individual questions for a Session decision queue.
 * @param session - Session already opened by the tree owner.
 * @returns One row per stable question identity, including staged answers and delivery facts.
 */
listQuestions(session: Session): readonly UserQuestionEntry[]

/** Observe committed changes; callbacks do not wake models.
 * @param listener - Receives the owning Session and its projection after a relevant event.
 * @returns Idempotent unsubscription; service teardown also removes the listener.
 */
subscribe(listener: (session: Session, batches: readonly UserQuestionBatch[]) => void): () => void

/** Stage an answer by Session identity, retaining specialized owners through commit.
 * @param sessionId - Question owner Session.
 * @param callId - Owning tool call.
 * @param answer - One answer or explicit skip.
 * @param expectedRevision - Optional projected revision comparison.
 * @param signal - Acquisition cancellation.
 * @returns Durable staging receipt, including conflicts.
 */
@Remote({ resources: { session: sessionId => sessionId } }) async stageSessionAnswer(sessionId: SessionId, callId: ToolCallId, answer: AskUserQuestionAnswerItem, expectedRevision: number | undefined, signal: AbortSignal): Promise<UserQuestionSubmission>

/** Submit a complete batch by Session identity through the same admission and CAS checks.
 * @param sessionId - Question owner Session.
 * @param callId - Owning tool call.
 * @param submission - Complete answers and editing revision.
 * @param signal - Acquisition cancellation.
 * @returns Durable acceptance or conflict receipt.
 */
@Remote({ resources: { session: sessionId => sessionId } }) async submitSessionBatch(sessionId: SessionId, callId: ToolCallId, submission: SubmitUserQuestionBatch, signal: AbortSignal): Promise<UserQuestionSubmission>

/** Attach a foreground wait by Session identity; stream closure releases residency.
 * @param sessionId - Question owner Session.
 * @param callId - Foreground tool call.
 * @param signal - Stream and acquisition lifetime.
 * @returns Host-computed remaining duration while the wait is live.
 */
@Remote({ mode: 'stream', resources: { session: sessionId => sessionId } }) async *attachSessionWait(sessionId: SessionId, callId: ToolCallId, signal: AbortSignal): AsyncIterable<{ remainingMs: number }>

/** Durably stage one answer without delivering an incomplete batch.
 * @param agent - Exact live question owner.
 * @param callId - Owning call.
 * @param answer - One explicit answer or skip.
 * @param expectedRevision - Optional comparison against the projected revision.
 * @returns New batch, or conflict/already-submitted without side effects.
 */
@Remote async stageAnswer(agent: Agent, callId: ToolCallId, answer: AskUserQuestionAnswerItem, expectedRevision?: number): Promise<UserQuestionSubmission>

/** Accept one complete batch exactly once, resolving a live wait or queueing a late reply.
 * @param agent - Exact live question owner; RPC resolution must preserve native parent ownership.
 * @param callId - Owning call.
 * @param submission - Complete answers, or previously staged answers, and optional revision comparison.
 * @returns Durable acceptance receipt; repeated submissions never deliver a second reply.
 */
@Remote async submitBatch(agent: Agent, callId: ToolCallId, submission: SubmitUserQuestionBatch): Promise<UserQuestionSubmission>

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
@Remote answer(agent: Agent, callId: ToolCallId, answer: AskUserQuestionAnswer): boolean

/**
 * Let one answer UI hold a live timed wait. Closing the stream releases its claim.
 * @param agent - Admitted live agent owning the question.
 * @param callId - Foreground tool call to attach to.
 * @param signal - Remote stream cancellation, including Client disconnect.
 * @returns One Host-computed remaining duration, or no frames once the wait ended.
 */
@Remote({ mode: 'stream' }) async *attachWait(agent: Agent, callId: ToolCallId, signal: AbortSignal): AsyncIterable<{ remainingMs: number }>

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
async askTimed( request: AskUserQuestionRequest & { agent: Agent }, callId: ToolCallId, timeoutMs: number, ): Promise<TimedUserQuestionResult>

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
async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
```

Types: [Agent](core.md) · [Session](session.md) · [SessionId](core.md) · [ToolCallId](core.md)

Source: [`packages/interaction/user-questions/src/index.ts`](../../packages/interaction/user-questions/src/index.ts)

<a id="user-questions-events"></a>

### `user-questions/*` events

<a id="user-questionsrequest--waterfall"></a>

#### `user-questions/request` — waterfall

Ask composed answerers for structured user input. Return an answer to claim the request or call `next()` to delegate. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.

```ts cordis-catalog
/**
 * Ask composed answerers for structured user input. Return an answer to
 * claim the request or call `next()` to delegate. Scope-filtered dispatch
 * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @param request - pending user-question request.
 * @mode waterfall
 */
'user-questions/request'( this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>, ): Promise<AskUserQuestionAnswer>
```

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/interaction/user-questions/src/types.ts`](../../packages/interaction/user-questions/src/types.ts)
<!-- END GENERATED cordis-surface -->
