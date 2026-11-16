# 用户交互

[English](user-questions.md) | 中文

[dsh-user-questions](../../packages/interaction/user-questions) 的用户交互 seam。它是工具或权限插件需要人类回答后 agent（智能体）才能继续时所使用的、提供方无关的词汇。Agent-scoped waterfall listener 组合可用的 UI 界面，其中包括转发到已连接 client 的 listener。

源码：[`packages/interaction/user-questions/src/index.ts`](../../packages/interaction/user-questions/src/index.ts)

## 问题选项

`AskUserQuestionOption` 包含一个可供选择的选项。`label` 是面向用户的选项文字，同时也是面向模型的选中值；`description` 是可选的 UI 帮助文本。

```ts type-equiv
/** One selectable answer offered to the user. */
interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}
```

## 呈现意图

`AskUserQuestionIntent` 可选地声明一种已知的决策类型。它以 `kind` 作为标记，以便后续加入更多意图；不认识某个标记的 UI 会渲染通用选项列表。意图只改变呈现——遵循它的 UI 回答的选项标签与通用 UI 相同，因此调用方读到的答案字段一致。`approve` 指明表示同意的选项，而不依赖选项顺序。`ask()` 拒绝两种类型无法表达的断言：`approve` 未命名该问题自己的任何选项，以及没有 `detail` 的问题声明了意图。

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

## 问题条目

`AskUserQuestionItem` 是请求中的一个问题。调用方提供稳定的 `id`，它会随答案原样返回，使批量问题仍可路由。可选的 `detail` 携带辅助文本；提供方会将其随问题渲染，但不会放入可选选项标签。

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

## 提问请求

`AskUserQuestionRequest` 是跨包请求。`questions` 是数组，这样 UI 可以在一个流程中呈现相关提示，同时保持每个回答有稳定的 id。如提供 `agent`，它必须与存活调用方是同一实例；服务始终验证它的存活注册表身份。没有策略时仅允许运行时根；可选 `HumanInteractionPolicy` 提供方可以允许指定子级。`requirePolicy: true` 会拒绝缺少策略的情况。安装或要求策略后，同样拒绝不带 agent 的请求。

```ts type-equiv
/** Request for a human answer. */
interface AskUserQuestionRequest extends AskUserQuestionRequestEvent {}
```

## 回答

提供方为每个问题 id 返回一个回答项。`selected` 包含选中的选项标签，`custom` 在用户输入自由文本时携带「其他」回答。对于单选题，`custom` 会覆盖选中的选项，且 `selected` 为空。对于多选题，`custom` 可以补充 `selected` 中的标签。UI 也可以使用 `selected` 为空且不含 `custom` 的回答项，在其余问题均已完成的批次中保留被跳过的问题。

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

计时回答器收到 `wait: { callId, timed: true }`。调用 id 标识卡片及前台等待。Client 调用 `attachWait` 接手等待并取得剩余时长；传输层转发原事件，不检查或改写这些字段。不带 `timed` 的 `wait` 表示无限期等待的具名卡片请求；没有 `wait` 则表示不带卡片 key 的阻塞请求。

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

## 计时问题与迟到回复

计时问题在有界的前台窗口内等待，然后让 agent 继续独立工作。用户在窗口内回答，工具返回整批答案；否则 `TimedUserQuestionResult` 为 `{ pending: true, callId }`。pending 表示问题仍可回答，不是空答案、拒绝、确认或授权。

```ts type-equiv
/** Timed ask result returned when the foreground answer window closes. */
type TimedUserQuestionResult = AskUserQuestionAnswer | { pending: true; callId: ToolCallId }
```

Client 接手通过业务 Remote stream 表达，不等同于 Gateway 投递。`TimedQuestionWait` 保存原 Host deadline，仅在没有接手记录时运行计时器。`attachWait` stream 发出当前剩余时长，Client 用本地时钟倒计时。聚焦、编辑和「慢慢回答」状态仍归本地所有。stream 取消释放相应接手记录；最后一个接手方离开后，Host 恢复原 deadline。无人接手时超时中止前台 waterfall 专属的 signal 并返回 pending，不取消 Turn。Gateway 与 `api-remotes` 不包含问答专属计时策略。

`userQuestions` Session projection 折叠工具调用与结果、PTC 子调用、获准的回复和 `user-question/batch` 版本。批次版本保留完整问题、暂存答案、接受与投递事实。没有批次版本时，原生 timed 调用仍可从记录的工具 schema 与事件重建。前台超时或重启会让调用成为 continued，不重建旧 Promise；本地聚焦、倒计时和 Client 接手记录不持久化。

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

`stageAnswer(agent, callId, answer, expectedRevision?)` 持久保存一题的明确答案，不投递不完整批次。`submitBatch(agent, callId, { answers?, expectedRevision? })` 验证整批 question-id 并比较可选版本；省略 answers 就提交暂存答案。过期版本返回 `conflict`；已接受批次的每次重复提交都返回 `already-submitted`，不产生第二条回复。接受记录 flush 后，服务 resolve 仍存在的前台等待，或把 `user-question-reply` 排队送给精确的提问 agent。工具结果或获准的用户消息记录送达，与接受分开。Agent 重建时会恢复尚未送达的已接受批次。旧 `answer` RPC 仍仅处理 continued；原生带 ID 卡片使用 `submitBatch`。

`query(session)` 返回批次版本，`listQuestions(session)` 返回逐题队列记录，`queryTree(rootSessionId, sessions)` 从调用方提供的 Session 中选择完整持久根树。记录包含 sessionId/callId/questionId、asker、文本、选项、multiSelect、allowCustom、createdAt、revision、状态、stagedAnswer、acceptedAt、deliveredAt 和 error。`subscribe(listener)` 观察已提交的问答投影变更，返回由调用方负责释放的取消订阅函数。提供方组合和持久化限制见[包参考](../../packages/interaction/user-questions/README.zh.md)。

关闭 Client 面板不发送任何内容。重启后，原生 RPC 解析恢复原提问 Agent 及其真实父链；Manager 的回复绝不转给 Main。

## 错误

`UserQuestionError` 继承 `HarnessError`，因此 `ctx.tools.execute()` 会保留 `{ name, code }`，用于面向模型的工具失败，如 `EMPTY_QUESTIONS`、`BAD_INTENT`、`NO_PROVIDER`、`ASK_ABORTED` 或 UI 侧取消。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md) · [Session](session.zh.md) · [SessionId](core.zh.md) · [ToolCallId](core.zh.md)

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

Types: [Agent](core.zh.md) · [Scoped](scope.zh.md)

Source: [`packages/interaction/user-questions/src/types.ts`](../../packages/interaction/user-questions/src/types.ts)
<!-- END GENERATED cordis-surface -->
