---
description: "Resolve child presets, model permissions and depth consistently across delegation tools, workflows and trusted plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-delegation

English | [中文](README.zh.md)

## Summary

Delegate tasks with the same preset, exact-model and depth checks from tools, workflows or trusted plugins. Conversation inheritance can use an independent readonly preset without inheriting the parent's tools. Reserve a local child identity and persist its identity or routing records before its first model request. No delegation tool needs to be visible to use this service.

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

Mount this service beside the native subagent runtime and the chosen providers. The service adds no tools and has no deployment configuration fields of its own; each trusted consumer explicitly registers its dispatch permissions.

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-delegation'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-subagent-fork-in-process'
```

### Register and dispatch

Inject `subagentDelegation` into the consumer plugin. Register a provider, optional context-inheriting provider, preset allowlist, model-selection permission and depth limit with the consumer's Context. The returned opaque policy is not a tool name, and is revoked when that Context unloads. `resolve(parent, request, policy, signal)` validates preset references, exact route permissions, effort, live adapter preflight and current depth; `start(spec, signal, hooks?)` consumes that spec once and returns the native Activation. Both methods reject on cancellation or failed admission; no dependent task should continue after a rejected start.

```javascript
const policy = ctx.subagentDelegation.register({
  provider: 'spawn',
  forkProvider: 'fork',
  agentPreset: 'subagent',
  allowedAgentPresets: ['subagent', 'subagent-readonly'],
  modelSelectionSettings: true,
  maxDepth: 2,
}, ctx)
const spec = await ctx.subagentDelegation.resolve(parent, {
  prompt: 'Review the completed work.',
  label: 'Review implementation',
  agentPreset: 'subagent-readonly',
  inheritContext: true,
  delivery: 'caller',
}, policy, signal)
const activation = await ctx.subagentDelegation.start(spec, signal)
try { await activation.result } finally { await activation.dispose() }
```

Preset ids must already be declared. Host sampling requires the existing `@deepseek-ai/dsh-tool-subagent/model-selection-settings` service; that entry adds no delegation tool. Explicit child LLM selection supplies `provider` and `model` together; `reasoningEffort` is optional. The parent's durable model-selection policy applies even when the consumer registers broader permissions. A registration with `modelSelectionSettings: true` captures Host permissions during `agent/created`, even without delegation tools, and disables explicit selection when the captured preference is off. `selectionPolicy(session, true)` samples the Host setting for a fresh root or inherits a child's recorded policy; restored Sessions without a decision do not sample a later preference. Omitted depth reads the current Host limit, while `provider-managed` leaves enforcement to the backend. `source` defaults to `service`; tool and workflow consumers set `tool` and `workflow` respectively for execution-layer admission.

### Persist identity before the first request

`start()` reserves a local child id before invoking `onChildReserved(childId)`. An optional caller-provided `request.childId` is used unchanged. `beforeChildStart(child, signal)` runs in the awaited `agent/created` phase, before initial task submission. Append child identity and policy records there and await `ctx.sessions.flush(child.session)`; the first child model request cannot start until the callback finishes. A flush failure must reject the callback. These hooks do not bypass the runtime's duplicate-id, live-parent, capacity or admission checks.

```javascript
const activation = await ctx.subagentDelegation.start(spec, signal, {
  onChildReserved(childId) {
    return reserveIdentity(childId)
  },
  async beforeChildStart(child, signal) {
    signal.throwIfAborted()
    await appendIdentityAndPolicy(child.session)
    if (!await ctx.sessions.flush(child.session)) throw new Error('identity persistence unavailable')
  },
})
```

`onChildReserved` may return a synchronous disposer for temporary caller state. The service calls it after startup succeeds, fails or is cancelled, and always releases its own reservation. If a disposer throws, startup rejects with an `AggregateError` and awaits disposal of any accepted Activation; inspect caller state and disposal failures before retrying. A callback that throws before returning a disposer owns any state it already changed. Child records committed before a later failure remain durable evidence; the service does not erase them. External providers do not accept reserved ids or either identity hook. An accepted workflow can `retain(policy)` before consumer unload and release it after the run and all children settle; a revoked policy cannot gain new holders.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The default service class declares the capability and implements policy resolution. Deployment registrations and single-use specs belong to that service instance. The existing tool and workflow engine are consumers; native providers and the subagent runtime continue to own child execution, cancellation, catalog membership and results. No consumer searches the tools registry for hidden dispatch endpoints.

The shared policy modules retain the existing model-policy event and projection. Fork retains the completed-turn seed, while native child composition records an explicitly selected preset after the inherited range. The loop logs the selected preset's current system and tool declarations before sending its first request.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subagent runtime](../subagent/README.md) — activation ownership and persistence.
- [Delegation tool](../tool-subagent/README.md) — model-facing schema and results.
- [Fork backend](../subagent-fork-in-process/README.md) — completed-turn context inheritance.
- [Workflow engine](../../workflow/workflow-ptc/README.md) — caller-owned structured result collection.

-----

<a id="model-experience"></a>
## Model Experience

### Delegated child input

#### What the model sees

The service supplies the caller's `prompt` and selected child preset. It contributes no parent tool schema or system section. Native child composition and the loop log every current system/tool declaration; inherited history does not grant the parent preset's tools to an independently selected readonly preset.

#### Token effect

Each child consumes its own prompt and selected context. The service adds no orchestration tokens; the model-facing consumer owns acknowledgements and result rendering.

#### KV Cache effect

Fresh children do not share parent history. Fork can reuse an unchanged inherited prefix; changing the child preset or route can replace system/tool declarations and invalidate that reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits qualify identity preparation and policy ownership.

- Reservation hooks require a local continuable provider; external providers allocate their own identities.
- The caller owns the contents and persistence of identity or routing records; this service does not infer expert roles.
- A successful start transfers execution ownership to the returned native Activation; cancelling the startup signal afterwards is not a substitute for disposing that Activation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
