---
description: "Global send_message, interrupt_agent, and list_agents tools for users and maintainers composing or debugging continuable-child control."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-control` adds the global control tools for continuable children: `send_message` steers between continuable nodes in the same real tree, `interrupt` stops a child's current turn while keeping its inbox and descendants intact, and `list_agents` (from the separately loadable `list-agents` plugin) lists continuable children by durable id and label. Parents and continuable children inherit the same `send_message` definition and ordering, so model communication adds no child-only tool schema. No tool's presence decides whether a delegation tool starts continuable work.

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

Mount this package in any composition with continuable children the model should message, interrupt, or list. The root plugin needs only the subagent service; the list tool is a separate plugin a deployment can omit.

### Minimal configuration

Load the subagent service, a backend, the delegation tool, and this package. Adding the separate list plugin exposes all three tools:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@deepseek-ai/dsh-tool-subagent-control'
- name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
```

The root plugin provides `send_message` and `interrupt`; `legacyInterruptAgent: true` additionally registers `interrupt_agent` for existing conversations. It defaults to false. Both interrupt names apply the same direct-parent check. The list plugin independently provides `list_agents`.

### send_message

Supply `message` and one destination: `agent_id` (exact id) or `to` (exact id, unique task label, or `parent`/`main`/`self`). To reply to your parent, use `to: "parent"` and omit `agent_id`. Empty strings, whitespace-only strings, and `null` count as omitted. If both fields are non-empty, both must resolve to the same session; conflicting or unresolved destinations fail before delivery and report the received values. Same-tree siblings and deeper nodes are valid targets; other-tree nodes and non-continuable targets are rejected. Duplicate labels return candidate ids and full name-segment arrays rather than guessing. A working target receives the message at its nearest step; an idle target starts a turn. Cold targets restore through their real parent chain. The result confirms only acceptance with a stable `messageId`, never the answer.

Optional `kind` is `message` (default), `question`, `answer`, `report`, or `result`. `reply_to`, `report_kind`, and `result_status` carry correlation, report category, and outcome. `report_kind: human-summary` bypasses the human-turn return restriction only for `kind: report` with the exact runtime reminder id in `reply_to`. Tools derive stable delivery effects from their logged call id; replay does not wake the recipient twice. The service writes sender identity, so a message cannot impersonate a parent.

### interrupt

External executions stop permanently and cannot receive follow-ups. Local targets stop only their current turn: queued messages stay parked until a later `send_message`, descendants keep running, and the child stays available for follow-ups. The call returns when the stop request is accepted, not when the target is quiet; an inactive recorded direct child returns `{ accepted: false, reason: 'not-running' }` and `agent … is not running; nothing to interrupt`, while unknown or indirect targets reject even after unloading, and self, sibling, stale, and non-direct-parent callers get errored results.

### list_agents

Lists the continuable children below the calling agent: `children` (default) reads direct children from the parent catalog without opening child logs; `descendants` recursively reads child catalogs in stable pre-order, annotating each entry with its durable direct-parent session id and depth. Status comes from the live Agent registry — `running` or `inactive`. External entries are omitted without reading a child Session. Readable one-shot children are omitted from output but their catalogs remain traversal nodes. Unknown modes and unreadable child catalogs, including one-shot children, appear as diagnostics only in `descendants` scope. Ordinary Session forks are not catalog entries, so neither those forks nor their descendants are listed from the source Session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains what the tools delegate to the subagent service; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Thin adapters over `ctx.subagents.sendMessage()`, `interrupt()`, and the list projections; the tools perform no lifecycle routing. Residency, cold resume, and authorization belong to the service, and the tools pass the exact live calling agent (`exec.agent`) as both sender and authority.

### Delivery and signal ownership

The tool forwards its execution signal, which owns admission only until inbox acceptance. Once the target accepts a message, it cannot be cancelled through this tool. Every message is framed as `Agent <sender-id> sent a message:` and recorded with `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`; the service derives that attribution and never treats it as authority.

### Listing projection

`list_agents` derives the root id from the calling agent, reads the service catalog without a cursor, refines each candidate's status through the live Agent registry, and omits one-shot children because they cannot accept `send_message`. Descendant traversal preserves each parent catalog's event order. Unknown modes produce diagnostics while their catalogs remain traversable; unreadable catalogs produce diagnostics and stop that branch. Descendants absent from reachable catalogs cannot be discovered.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `send_message` and `interrupt` registration |
| [`src/list-agents.ts`](src/list-agents.ts) | `list_agents` registration: direct-child discovery and status refinement |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the tool schemas to the continuation service behind them.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — continuable children, activations, inbox, interrupt, and follow-up authority.
- [dsh-tool-subagent](../tool-subagent/README.md) — the delegation tool that starts continuable children.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control) — the three tool schemas.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control): `send_message` takes `message`, exactly one of `agent_id`/`to`, and optional message correlation; `interrupt` takes a direct child’s `agent_id`; `list_agents` is unchanged.

#### Token effect

Fixed schema cost per parent request.

#### KV Cache effect

Prefix-stable; the schema does not change at runtime.

### Interrupt result

#### What the model sees

`interrupt requested for agent <agent_id>` on acceptance. An unauthorized caller — self, sibling, stale, or non-direct-parent — is an errored result naming the rejection; an absent or settled target still renders the acceptance line.

#### Token effect

One short acknowledgement per call; the interrupted turn's abort is visible only in the child's own transcript.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### Delivery result

#### What the model sees

`message delivered to agent <agent_id>` on acceptance; the canonical output carries the accepted `messageId`. A failure — an other-tree target, unavailable parent, unknown child, descriptor-less child that cannot be resumed, or admission rejected — is an errored result whose message states the message was not delivered.

#### Token effect

One short acknowledgement per call; the target's response never returns through this call. A child uses the same tool with its initial task's parent id to append selected content to parent history.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Listing result

#### What the model sees

One line per continuable child in stable catalog order: `<id> [<status>] — <label>` (`running` = executing a turn; `inactive` = no turn executing, whether loaded or stored; neither status describes task completion or outcome). Only `descendants` scope adds `<id> [diagnostic: <reason>]` for an unknown mode or unreadable child catalog, including an unreadable one-shot child. The `descendants` scope inserts ` parent=<id> depth=<n>` before the label dash on every line, in pre-order. Readable one-shot children are omitted; `(no subagents)` means no continuable child or diagnostic survived the projection.

#### Token effect

Grows linearly with the listed continuable children and diagnostics — reachable catalog descendants under the `descendants` scope; there is no cursor or cap, so long-lived parents with many persisted children pay the full list each call.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the control tools cannot observe or steer; they are current package constraints.

- **A delivered message has no independent result** — acceptance returns only its inbox `messageId`; later target work lands in that target's durable Session and is never collected through this tool. A reply is another explicitly addressed `send_message`, not this call's result.
- **Cold delivery requires a live root and resumable ancestors** — the service refuses an unavailable root or an unsupported ancestor instead of changing parentage. External executions remain non-continuable.
- **Listing is a snapshot, not a delivery promise** — it may race publication, disposal, or a later message, and another process may activate a child this process reports as `inactive`; cross-process accuracy requires a shared lease. `interrupt` performs the authoritative live-lineage check itself, so discovery staleness cannot grant authority.
- **No pagination or deletion** — the complete stably ordered set is returned, and persisted children remain listed for as long as their sessions remain in persistence; a service-level bound or delete operation is a later product decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
