---
description: "Waterfall-based question and answer service for tools, permission plugins, local answerers, and Agent-scoped Web interactions."
kind: "package-reference"
---

# @deepseek-ai/dsh-user-questions

English | [中文](README.zh.md)

## Summary

Use `ctx.userQuestions` when a tool or permission flow needs a structured answer from the user. `ask()` waits for that answer; `askTimed()` may release the agent to continue independent work while the question remains answerable in the Session.

## Table of Contents

- [Ask a question](#service-userquestionservice-ctx-key-userquestions)
- [Role](#role)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service-userquestionservice-ctx-key-userquestions"></a>
## Ask a question

`attachSessionWait(sessionId, callId, signal)`, `stageSessionAnswer(sessionId, callId, answer, expectedRevision, signal)`, and `submitSessionBatch(sessionId, callId, submission, signal)` address browser operations without the generic Agent lookup. They retain specialized owners through the optional `sessionAgentAcquisition` service; ordinary roots still use the configured Agent resolver. All paths apply the same live-caller admission and submission checks. A stream holds residency until closure; unary calls release it in `finally`. The subagent provider restores the real parent chain without granting worker interaction permission.

Call `ask()` when work cannot continue without the answer. Call `askTimed()` when the agent may continue independent work after a foreground wait. An answer UI claims that wait through `attachWait`, receives the Host-computed remaining duration, and counts down on its own clock. Without a claim, including after the last Client disconnects, the service releases the model at the original deadline. The `userQuestions` projection derives durable questions from the tool call, its result, and the eventual reply; Client claims are not persisted.

For a single-select question, `custom` overrides the selected choice and `selected` is empty. For a multi-select question, `custom` may supplement the labels in `selected`. A UI may preserve a skipped item as `{ id, selected: [] }`, keeping the existing answer shape while retaining other answers in the batch.

A question may carry a presentation `intent`, which declares that it IS a known kind of decision so a UI that recognises the tag may present it as such; the one tag is `plan-review`, whose `detail` is the plan under review and whose `approve` names the affirmative option. An intent changes presentation only: a UI honouring it answers with the same option labels a generic UI would send, and a UI that does not know the tag renders the generic option list. `ask()` rejects with `BAD_INTENT` the two assertions no type can carry: an `approve` naming none of that question's own options, and an intent on a question with no `detail`. `dsh-plan-mode` sets it on the `exit_plan_mode` review question.

When a request carries an agent, every ask, answer, wait attachment, staging, and submission authenticates its exact live identity. Without `humanInteractionPolicy`, only runtime roots are admitted. An optional provider extending `HumanInteractionPolicy` decides from `{ agent, session, isSubagent, parentChain }`; `check()` returns `{ allowed: true }` or `{ allowed: false, reason }`. `parentChain` lists live owners from nearest parent to root. Set `userQuestions.config.requirePolicy: true` to reject a missing provider. Agentless local requests are available only without an installed or required policy.

A call with a `wait.callId` uses `stageAnswer(agent, callId, answer, expectedRevision?)` for durable per-question answers and `submitBatch(agent, callId, { answers?, expectedRevision? })` to submit exactly one complete batch. Omitting answers submits the staged batch; an empty selected list without custom text explicitly skips that question. A stale revision returns `conflict`; an accepted batch returns `already-submitted` on repetition, even from another panel. The service flushes acceptance before resolving a foreground wait or steering a `user-question-reply` into the exact asking agent. After timeout or restart, no Promise is recreated: submission uses that same agent’s inbox. Native RPC resolution must restore its real parent chain, never create an unrelated root. `acceptedAt` records acceptance; `deliveredAt` comes from the logged tool result or admitted user message. A delivery error remains visible and recovery retries an undelivered accepted batch when the Agent is recreated. Reactivation preserves `continued` and `partial` revisions and staged answers; only an open foreground wait records one transition to `continued`.

<a id="role"></a>
## Role

The `userQuestions` projection folds tool calls/results, PTC dispatches, admitted replies, and `user-question/batch` revisions; no second question store exists. `query(session)` returns batches; `listQuestions(session)` returns rows keyed by sessionId/callId/questionId, with question text, options, multi-select/custom flags, staged answers and delivery facts. `queryTree(rootSessionId, sessions)` filters caller-supplied Sessions by their complete durable parent chains, including detached reads without waking models. `subscribe(listener)` observes committed projection changes and returns an unsubscribe function; callers own that disposer. The deprecated `answer` RPC retains its continued-only boolean behavior for older consumers; new browser panels use `submitSessionBatch` for both foreground and continued calls.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-ask-user`, which retains a successful answer as compact JSON or one of these failures: `Error: ask_user_question was aborted before the user answered`, `Error: ask_user_question requires at least one question`, `Error: human interaction requires the exact live calling agent when an agent is supplied`, `Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result`, `Error: no user-questions answerer accepted the request`, or `Error: <message>`. Waiting for the human adds no tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Agent-scoped Web answering** — Remote Events route the shipped Web answerer only when the request carries a live Agent scope; agentless callers need an unscoped local waterfall listener.
- **The vocabulary is the question-form shape only** — selectable options plus optional custom text; richer interaction shapes (file pickers, diff-preview confirmations) have no seam vocabulary yet.
- **Unsaved typing stays local** — `stageAnswer` persists explicit per-question answers across restart and clients; keystrokes not staged by a consumer remain browser-local. Detached Sessions without a persistence service have only in-memory acceptance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** one projection derives every question from the Session log. Repeated accepted submissions never produce another reply. A continued answer may create a new turn, but never rewrites a finished tool result.
