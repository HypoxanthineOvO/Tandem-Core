---
description: "The subagent delegation seam for users and maintainers choosing a provider backend, composing delegation tools, or debugging child-agent runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent

English | [中文](README.zh.md)

## Summary

Use `dsh-subagent` to delegate work through named providers and collect managed activation results. Local spawn and fork children retain durable sessions for later messages; ACP, DSH SDK, Codex, and Claude Code execute once. Every child shares admission, cancellation, ownership, and discovery. Compose the service with a provider and a delegation tool. A continuity controller can additionally bind multiple branches to each main line: human-authored branch turns stop returning bodies to the parent, commit versioned ledger decisions, and expose pending review through the `continuity*` Remote methods.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Each start accepts an optional `cwd`; relative paths resolve against the parent's current working directory, and omission captures that current directory. The child keeps its parent's origin metadata and permission roots. A child-owned directory value follows any inherited history, survives continuation and restart, and is independent of later parent changes.

This package is the contract every delegation setup shares. You enable it by mounting the service together with one or more provider backends and the model-facing delegation tool; from then on, an agent can delegate work and the service routes each request to the named provider.

### Enabling delegation

Mount the service with a provider and the delegation tool. The provider registers under its configured name; each tool row selects one provider. A minimal setup:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

The tool returns a child session id immediately. The parent receives a completion notice when the background activation settles. Mounting the service alone enables no delegation.

### Delegation settings

The limits section on the **Plugins → Subagent** page edits the Host’s `subagent` settings section. User values override this plugin's composition; reset removes the user override. `maxDepth` defaults to `1` and supplies the delegation tools' depth when their own configuration omits it. An explicit tool depth, including `provider-managed`, takes precedence. Depth `0` disables delegation through tools inheriting this setting; depth `1` permits direct children only. Changes apply on the next delegation attempt. Direct service callers continue to supply their own optional request depth.

### Activation capacity

Set `maxActiveSubagents` on the host plugin to limit live and materializing children in each activation tree. It defaults to `8` and accepts positive safe integers. A top-level parent starts a pool shared by its local and external descendants; the root parent consumes no slot. Creation and cold resume reserve before yielding, and disposal returns the slot only after cleanup. Waiting parents, pending inbox work, and stopping activations remain counted. Sending to a resident child reuses its slot. Delegation depth is a separate policy.

The current `maxActiveSubagents` value is sampled before every new or cold-resumed Activation. Raising it admits more children in existing trees; lowering it leaves resident children running and refuses further admissions until usage is below the limit.

At capacity, creation or cold resume rejects with `ACTIVATION_LIMIT_REACHED` (browser prompts receive `subagent/delivery-unavailable`): wait for a child to finish or continue using the existing agents. Admission does not queue, because a parent waiting for descendants must not wait for its own occupied slot. Slots are process-local and do not constrain cumulative Session history or token usage.

### Execution admission and turn reports

A deployment can provide the optional `SubagentAdmissionPolicy` service (`subagentAdmissionPolicy`). Its synchronous, effect-free `check({ parent, childId, preset, label, depth, source, resuming })` returns `{ allow: false, reason }` or `{ allow: true, quotaGroup?: { id, max } }`. The manager checks fresh starts before provider preparation and again at materialization; cold resume uses the same execution check. `SubagentActivationSpec.source` identifies `tool`, `workflow`, `remote`, or `service` (the default). A policy rejection is `ADMISSION_DENIED` and starts no child.

Policy groups share the total activation pool. Alternatively configure `quotaGroups: { coordinators: { max: 4 } }` and `presetQuotaGroups: { coordinator: coordinators }`; a policy-supplied group takes precedence. Group and total slots are reserved together before asynchronous creation or resume, remain occupied during waiting and teardown, and are released idempotently after cleanup or rollback. Group exhaustion is `ACTIVATION_GROUP_LIMIT_REACHED`. The configured total limit is unchanged by groups.

The optional `SubagentHumanTurnObserver` service (`subagentHumanTurnObserver`) receives `onTurnEnded({ parent, child, effectId, turn, queueReminder })` after a normally completed turn containing admitted browser input and driver quiescence. Interrupted or failed turns do not restart themselves with a reminder. Delegation, agent messages, answer receipts, and system reminders do not count. The stable effect id identifies the child and human turn. During this synchronous callback, `queueReminder(content)` queues one durable reminder and returns its message id; repeated calls return that id. The core adds report-only instructions. A child may send exactly one deduplicated report to its direct parent with `kind: 'report'`, `reportKind: 'human-summary'`, and `replyTo` equal to that reminder id. Ordinary free-text returns remain blocked during human and reminder turns; this permission never confirms or submits a continuity decision. Callback failures are contained and reported; no observer means no reminder.

### Local and external children

`startActivation({ provider, label, request, signal, delivery })` returns `{ childId, messageId?, result, dispose }`. Supplying `childId` selects a local backend and guarantees `messageId`. Local children accept later messages and can cold-resume; external children expose one execution and reject continuation. `request.agentOptions` overrides supported child model settings. `delivery: 'parent'` supplies the model-facing completion notice; `delivery: 'caller'` lets workflows await the result without a parent notice or initial return guidance. Local parent delivery requires persistence; caller delivery can use an ephemeral local session. Cold resume requires persistence and Session query.

<a id="settlement-route-comparison"></a>
### Settlement route comparison

The optional `subagentRouteEquivalence` service compares complete selected and actual `{ provider, model }` routes through synchronous, side-effect-free `isSameRoute(selected, actual): boolean`. Its [Service Definition](src/route-equivalence.ts) lives here because subagent settlement is its current consumer; routing plugins supply the Service Provider, keeping provider-specific aliases outside this package. The manager reads it with `ctx.get('subagentRouteEquivalence')` at settlement. Without a provider, comparison remains literal provider/model equality. The comparison changes only fallback attribution, never the recorded or displayed actual route. Providers register effect-scoped services so unloading restores literal comparison.

### Child presets

In-process spawn and fork accept an independent `agentPreset` when the provider declares that capability; inheriting completed context does not grant or prohibit preset selection. Without a selection, a local child joins the parent's current preset revision. An explicit id mounts the currently available revision, even when that id matches the parent's. Configure model choices through [`dsh-tool-subagent`](../tool-subagent/README.md#selecting-a-child-preset) and persona and tools in the [preset composition](../../preset/agent-preset-registry/README.md). Cold resume preserves persona and tool restrictions recorded in historical child descriptors.

<a id="managed-continuity-branches"></a>
### Managed continuity branches

`continuityAutoBind: true` binds every accepted direct human prompt to its exact parent main line, after child ownership and input admission succeed. Configure `continuityExcludedPresets` with preset ids such as evaluation modes to skip automatic binding; the default list is empty. Each main line owns one serialized ledger shared by all its branches, while unrelated main lines remain independent. Human-origin turns remain local and do not send settlement bodies or free-text messages to the parent, including evaluation conversations. Origin follows the first inbox input actually admitted in that turn; host-added mode, baseline, or fallback context does not count, and human steering later in a delegated turn does not change its origin.

A new branch receives a logged user-role baseline from its direct parent's ledger. In a nested A → B → C tree, B can be A's branch and own C's main ledger independently; C's baseline and commits both address B's ledger. `continuity_commit` may omit `base_rev`, using that branch's latest explicit read or injected revision, not another branch's read or the current ledger revision. A stale branch must read again after a conflict. Main-line and unbound model tool calls return Chinese guidance without removing either tool from the catalog. Bindings remain process-local; after restart, a direct human prompt re-establishes them.

Main-line requests append the [pending-decision details](../../continuity/continuity/README.md#model-experience) as logged user-role messages, preserving the original values, reason, and branch identity. Configure `continuityNotificationValueChars` (default `512`, minimum `16`) and `continuityNotificationMaxChars` (default `8192`, minimum `256`) on this plugin. Both accept positive safe integers and include truncation markers and notification labels in their respective limits. Only included decisions enter `continuity/delivery` and its acknowledgement; remaining items stay pending for later batches. A single oversized decision fails with guidance to raise the complete limit. Persisted v2 deliveries replay their exact text; historical summary-only deliveries do not substitute for field-detail notifications. Wake and process-now messages use fixed Chinese reminders rather than raw decision summaries.

For multiple main lines, address `continuityStatus({ sessionId })`, `continuityPending(limit?, { sessionId })`, `continuityProcessNow({ requestId, sessionId })`, and `continuityConfirmProposal({ proposalEventId, requestId, sessionId })`. A managed branch's status has `enabled: true` and `branchSessionId === sessionId`. Omitting the address is supported only when one main line is bound.

### Host residency acquisition

This package supplies the optional `sessionAgentAcquisition` provider defined by `dsh-agent`. It returns no lease for ordinary roots and uses `acquireLive` for child Sessions, including cold Managers; callers still enforce their own interaction admission.

`acquireLive(requester, sessionId, signal)` is a trusted Host-plugin capability, not a model tool or browser RPC. Supply an exact live same-tree `requester`, or `undefined` when the Host acts for the user. It returns `{ agent, release }` without appending a message or starting a turn. Cold continuable targets and their real ancestors resume through execution admission (`resuming: true`) and ordinary total/group capacity. The real root must already be live; `ROOT_NOT_LIVE` tells the caller to ask the user to open the main conversation first. External executions and unsupported cold sessions cannot be acquired.

Use the returned exact Agent with Host services such as `userQuestions.stageAnswer` and `submitBatch`, then always call `release()` in `finally`. Concurrent acquisitions share one Agent and independently pin the target and its managed parent chain against natural unloading. Release is idempotent; accepted inbox work still runs normally, while an unused restored activation unloads and returns its quota without a parent completion notice. Explicit disposal or tree shutdown can revoke residency despite a hold. The signal owns only acquisition; after return, release remains the caller's responsibility even if that signal aborts. A live Host-owned root keeps its existing owner and is not newly owned by this capability.

### Messaging, interrupting, and discovering

Every exact live Agent can use `sendMessage()` inside its real root tree. A working target receives the message through Steer at its nearest step; an idle target starts a turn. Cold targets restore their actual parent chain; a missing root or unresumable ancestor rejects rather than creating an independent root. `resolveTarget(sender, target, signal)` resolves `parent`, `main`, `self`, an exact session id, then a unique descriptor label. Ambiguous labels return candidate ids and root-first name-segment arrays; unavailable, other-tree, and non-continuable targets return explicit failures. Only the exact live direct parent may interrupt a child; the browser parent address is checked against the live target owner. Interrupt stops only the current turn and preserves grandchildren. A recorded direct child that is inactive returns `{ accepted: false, reason: 'not-running' }`; a running child returns `{ accepted: true }`. Nonresident targets are authorized against the direct parent's durable catalog, so unknown and indirect targets reject without cold resume. A browser continuation prompt independently selects Queue or Steer and may carry image parts: the Host admits and persists each image batch through the attachment store before the child inbox accepts the message, and refuses delivery when the child's declared model does not accept image input. Direct-child discovery reads the parent-owned `subagentCatalog` projection. `listChildren(parentSessionId, signal?)` owns a live-preferred Session observation and returns the catalog asynchronously without reading child logs. It forwards cancellation and releases the observation after materialization. Materialization preserves parent event order in O(D) time for D facts. External entries are leaves and require no child Session observation. Descendant discovery recursively reads local child catalogs in parent event order, observing each reachable Session once. It skips branches whose catalogs cannot be read and returns diagnostics for them; neither path loads or resumes a child Agent.

### Persistence compatibility

`AgentMessageSource` retains `kind: 'agent-message'`, `form: 'relay'`, and `senderSessionId`. New optional fields are `message` (message id, source and target session ids, purpose and optional correlation), `effectId` (idempotent inbox delivery), and `summaryPermit` (runtime reminder child id, direct-parent target and human-turn effect id). Old messages omit them; the new reader preserves ordinary delivery and does not infer permission from absence. Existing readers still understand the native agent-message framing and may ignore added fields; there is no new event or source discriminator, so no new `ignorable` envelope or Session writer-version bump is required. Historical descriptors and composition versions are unchanged. A summary permit authorizes only a free-text report, never a continuity commit; replay returns its prior receipt rather than sending another report. Deployments retaining conversations that call `interrupt_agent` opt into the control tool’s legacy alias.

### Failure and recovery

Starting without the `agents` service rejects with `CONTINUATION_UNAVAILABLE`; an available runtime rejects a missing or replaced parent with `UNAUTHORIZED`. Providers implementing neither execution method are rejected at registration with `UNSUPPORTED_CAPABILITY`; unsupported requested capabilities reject creation with the same code. The caller signal cancels only unpublished work; after publication, `dispose()` cancels the exact activation and waits for its descendants, including pending startups, and their resource cleanup. `result` settles after teardown and notifications, carrying output, optional structured data, and a stop reason; capture failures reject it after teardown. Cleanup failures reject `dispose()` and mark the lifecycle end as failed; the result promise and parent notification retain the captured execution result.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service is built and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **One service, many providers.** The service is a named-provider registry; each backend registers under a unique name and a request picks one by name.
- **One managed lifetime.** `SubagentManager` owns startup, message admission, capacity, parent relationships, and disposal. Each activation retains a local AgentHandle or external SubagentRun directly; local inbox and idle state belong only to the local variant.
- **Fulfillment is publication.** `startActivation()` returns only after the child is accepted and its handle can cancel that exact execution.
- **Trusted same-process values.** Requests, descriptors, and results are borrowed immutable; serialization and hostile-input validation belong at process and wire boundaries.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service entry: provider registry, start and continuation API, lifecycle events |
| [`src/manager.ts`](src/manager.ts) | Unified startup, message admission, cold resume, parent ownership, settlement, and disposal |
| [`src/activation.ts`](src/activation.ts) | Execution records, capacity slots, child locks, and local output capture |
| [`src/continuation-messages.ts`](src/continuation-messages.ts) | Adjacent-Agent messages, return guidance, and settlement notices |
| [`src/internal.ts`](src/internal.ts) | Host-only Queue and Steer adapters plus standard adjacent-Agent messaging markers |
| [`src/structured.ts`](src/structured.ts) | Activation-scoped structured capture and guards |
| [`src/types.ts`](src/types.ts) | Public request, result, and provider contracts |
| [`src/descriptor.ts`](src/descriptor.ts) | Versioned `subagent/descriptor` session-event vocabulary |
| [`src/catalog.ts`](src/catalog.ts) | Parent-owned `subagent/catalog` event and chunked host projection |
| [`src/child-agent.ts`](src/child-agent.ts) | Child composition, delegated policy, depth helpers |
| [`src/list-children.ts`](src/list-children.ts) | Direct and recursive parent-catalog reads |
| [`src/control.ts`](src/control.ts) | Browser control request validation and stable failure codes |
| [`src/control-types.ts`](src/control-types.ts) | Client-safe catalog row, control requests, receipts, and failures |
| [`src/archive-admission.ts`](src/archive-admission.ts) | The `subagent` family of the Workspace registry's archive admission: running descendants and their parent-cause cancel |

### Provider preparation and structured output

The service validates requested capabilities before creation. Local providers supply only `prepareContinuable()`: spawn returns fresh state and fork returns a completed-turn seed. The manager captures the parent model settings, delegated permissions, and composition before creating the child. External providers retain `start()` as a transport adapter and retain their own permission systems. The common manager owns their published execution. Structured tools, instructions, validation, and terminal guards belong to one local activation; they are not persisted as resume configuration. The child can submit its structured result after consuming accepted input and releasing owned descendants. Staging a result closes further input through tool-result policy and any enclosing PTC execution; a rejected result reopens input, while a committed result keeps it closed. Later cold resume has no structured schema.

External providers mint a fresh `SubagentRun.id` for each execution in the runtime's shared Session id namespace, across all parents and providers. A collision with a resident Agent, Session, or activation rejects startup with `DUPLICATE_CHILD` and disposes the new external handle without replacing the existing execution.

### Activation settlement

The manager reserves child identity and capacity, materializes a local Agent or external execution, and accepts the initial task. Local admission closes after Agent activity, pending input, and owned descendants finish, with activity revalidated after the final Session flush. Both local and external activations deliver their result after handle cleanup, capacity release, and settlement notifications. Host waits join progressing descendants and their cleanup, including failed executions; idle parked subtrees remain resident without delaying host completion. Closing admission and disposing the handle prevent late work from entering a released Agent. Parent delivery emits its notice after settlement; caller delivery leaves collection to the awaiting workflow. Headless hosts repeat `agent.whenIdle()` and `waitForChildren(agent)` until no child work remains and the parent stays idle with an unchanged Session sequence across the child check, so completion notices can produce the final parent answer.

A local Agent failure without a subsequently committed `turn/end` settles as `error` after its owned descendants finish. Unclaimed input cannot keep that failed activation resident. A later committed turn ending supersedes the live failure and supplies the recovered outcome.

Successful local creation appends a `subagent/catalog` fact to the parent Session regardless of result delivery. External creation appends a catalog fact only with `delivery: 'parent'`; caller-owned external executions retain their caller's membership records. External entries use `mode: 'external'` to identify children without a local Session. Catalog entries record membership once at creation and carry no execution status. Complete results go to the caller or the parent completion notice. Projections exclude inherited facts. Direct lists read one parent projection, so completed local workflow children remain discoverable and can be opened or continued. Catalog payload v0 records local modes; v1 also accepts unknown mode; v2 records external executions. Readers support all three versions. Historical migration appends a v1 `subagent/catalog` from a readable child header when its descriptor is unavailable; local creation retains v0. Its `mode: 'unknown'` projection keeps the child visible without claiming continuation support; an existing complete entry remains authoritative.

<a id="restoring-child-composition"></a>
### Restoring child composition

An independently selected spawn records `agent-preset/selected` before its first own `subagent/descriptor`. Cold resume excludes the inherited event prefix and checks that ordering, then reads the preset id from the existing `agentPreset` projection. It mounts that id without requiring the original subagent provider to remain registered. A missing or broken selected preset rejects restoration; it does not fall back to the parent or deployment default.

Logs without that selection before the first own descriptor, including historical spawn and fork logs, retain `composeFrom` of the parent's current composition. A header preset id, an inherited selection, or a selection after the descriptor does not opt a child into independent restoration, including a fork with no inherited events. Session and descriptor formats are unchanged. Independent cold resume uses the currently registered preset definition, without preserving an earlier revision across restarts.

### Ownership and invariants

- **The manager owns accepted work** — unpublished failures roll back; published handles cancel their exact activation and await child-first disposal.
- **Registration is effect-scoped** — removing a provider blocks new starts but never revokes accepted runs.
- **Agent-message identity is service-owned** — `sendMessage()` requires the exact live sender and checks both durable parent chains. New messages retain historical `agent-message` attribution and add optional `message` correlation (`messageId`, `source`, `target`, `kind`, `replyTo`, `reportKind`, `resultStatus`) plus a stable `effectId`; old messages without these fields remain readable. Duplicate effects return the original durable inbox receipt without another wake.
- **The descriptor is log-only** — a session event absent from model history and retained across compaction; the writer records the resolved child provider, model, and reasoning effort for cold resume. Historical one-shot descriptors remain readable.
- **This runtime answers archive admission for children** ([seam](../../workspace/workspace/README.md)) — `workspace/session-activity` reports the live subagent descendants inside a turn as the `subagent` family, found by the durable lineage this package records (`parentSession` with the subagent origin, any depth, never a fork) and labelled from each child's descriptor through a live Session observation when the Session query service is composed, otherwise by id; `workspace/session-stop` cancels each of them with the parent cause, one at a time, so one child refusing its cancel is logged while its siblings still stop. The parent's own turn, its jobs, and the archived-lineage step gate belong to the API Session Controller.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared seam to the backends, the model-facing tools, and the design decisions.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [historical Subagent capability seam](../../../.agents/notes/archived/feature/2026-06-21-subagent-capability-seam.md) — the design record for the delegation capability family.
- [Continuable subagents](../../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md) — durable children that accept follow-up turns.
- [In-process spawn backend](../subagent-spawn-in-process/README.md) — the simplest provider to compose.
- [Auto review](../../experimental/auto-review/README.md) — the current-session authorization mode inherited only by in-process DSH children.
- [Out-of-process ACP backend](../subagent-acp/README.md) — children with their own runtime over the Agent Client Protocol.
- [DeepSeek input conversion](../../llm/llm-deepseek/README.md#model-experience) — provider replay rules for saved settlement notices.
- [tool-subagent-control README](../tool-subagent-control/README.md) — the follow-up, interrupt, and listing surface.

-----

<a id="model-experience"></a>
## Model Experience

### Settlement notice

#### What the model sees

Parent delivery emits a user-role status notice containing the child’s nonempty final text blocks, regardless of `send_message` availability or use. External notices also state that further messages are unsupported. Reasoning and other nontext blocks are excluded. Every parent notice includes available structured output as `Structured result: <JSON>` and the provider’s safe diagnostic as a separate text block. Empty closing text is reported as `It left no closing message.` A final Chinese line names the local child's last recorded `request/context` provider/model, marking it as fallback when it is not equivalent to the selected child route under `SubagentRouteEquivalence`. Missing own request records, inherited-only records, and external backends report an unverified identity rather than treating configuration as dispatch evidence. Caller delivery emits no notice; SDK lifecycle notifications retain complete child output when cleanup succeeds.

#### Token effect

One notice per settled activation using parent delivery. Caller delivery adds no completion message; its consumer owns result presentation.

#### KV Cache effect

Append-only in the parent: the notice follows its reusable request prefix. Reaching an idle parent starts one independent model request; reaching a busy one does not.

### Child delegation-scope statement

#### What the model sees

Every in-process child's runtime-context snapshot carries the `subagent:delegation` statement below, after the sandbox-policy and approval-policy sentences.

##### The delegation-scope statement

```markdown
You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the job needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.
```

#### Token effect

One fixed statement in each child's runtime-context snapshot; none in the parent's requests.

#### KV Cache effect

Prefix-stable within a child: the statement never changes during the child's lifetime, so it is written once into the first runtime-context snapshot. Parent-side, no direct invalidation; the named tool consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the seam is a poor fit or needs special operational care. They are current package constraints, not a general delegation comparison or a task backlog.

- **Descendant reads are sequential** — each reachable catalog, including one-shot children, takes one observation. A cold Session without a valid prepared observation requires a full-log read; large cold trees can accumulate storage latency.
- **External children execute once** — ACP, DSH SDK, Codex, and Claude Code have no local child Session and accept no follow-up input. Their parent-owned records remain discoverable after disposal.
- **Adjacent model messaging only** — `sendMessage()` requires an exact live sender; every sender may target a direct continuable child, while only a sender with a resident continuable Activation may target its direct parent. Browser prompts use a separate human Queue-or-Steer control path.
- **A direct parent must remain live for child-to-parent delivery** — the service has no durable parent mailbox; a missing parent rejects the message instead of accepting work it cannot wake.
- **Wake gap during cancellation convergence** — a follow-up accepted after an interrupt signal but before the Agent becomes idle stays queued until another waking send.
- **Pending injected context retains an Activation** — settlement conservatively treats every Inbox occurrence as unfinished. Context parked after the Agent becomes idle keeps the child and its live ancestors resident until a waking delivery claims it, a queue mutation removes it, or manager teardown discards it. Host completion joins active work, pending child creation, and resource cleanup, but does not wait for a subtree containing only idle parked inboxes; it neither completes those activation results nor discards their messages.
- **Process-local residency** — the Activation inbox and ownership graph do not coordinate two harness processes; concurrent access to one persistence store needs a durable mailbox and cross-process lease protocol.
- **No replay of accepted-but-unlogged messages** — a crash can lose an accepted prompt that never reached the child's session log; the lost message is not replayed automatically.
- **No durable parent mailbox** — child-to-parent messages require a resident continuable child and live direct parent, and provide acceptance identity rather than exactly-once delivery.
- **Continuity requires a live main** — the controller does not migrate a session whose main agent is offline; Teams mail is spooled by the plugin and replayed when the bound main line is live again.
- **Lifecycle events are observe-only** — a run-affecting `subagent/end` continuation or decision API waits for a concrete consumer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Cross-process continuation** — a durable mailbox and lease protocol would let two harness processes share one persistence store.
- **Continuable ACP children** — requires persisting the remote session id and a per-child continuation advertisement.
- **Host-user delivery** — a future host adapter needs a concrete authenticated interaction before the seam gains a user delivery capability.

</details>
