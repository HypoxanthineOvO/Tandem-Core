---
description: "Show the durable work/direct conversational mode and switch it from the composer tool row."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-mode

English | [中文](README.zh.md)

## Summary

This package renders the session-mode chip in the composer tool row. It reads the Host-computed `sessionMode` projection, shows the current mode (work or direct), and switches it through the `sessionMode` Remote. A new Session starts in work mode. The chip is hidden inside addressed subagent conversations, where the delegated prompt owns the behavior.

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

The Web bundle includes this plugin. It has no configuration fields.

The chip shows `工作模式` (work) or `直接模式` (direct). Clicking it selects the other mode; the chip stays disabled while the Host call is in flight and repaints only when the pushed projection frame confirms the recorded switch. A refused or failed switch leaves the displayed mode unchanged and shows a short failure line beside the chip.

The mode itself is durable Host state, not a client preference. Work mode delegates: the main line splits independent tasks, dispatches them, then integrates and verifies the results. Direct mode has the main line complete the task itself. The Host appends the model-visible mode notification to the next admitted request, so switching mid-conversation does not change the system prompt or the tool list.

Disable the following row through a profile patch to remove the chip:

```yaml
- id: ui-session-mode
  disabled: true
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser entry registers one component into the conversation-owned `conversation.input.left` list slot through `ctx.slots.inject()`. The component reads the current mode with the standard `useProjection('sessionMode')` hook, hides itself when the Session snapshot carries a subagent address, and disables itself when `useAccess('sessionMode/set')` denies the current Peer. The inject face calls `remote.sessionMode.set({ sessionId, mode })` and converts a business failure into the local failure line. The component never guesses the target mode locally: the projection is the only authority.

Registration and dictionaries leave with the plugin fiber. The package owns no cache, subscription, poll, or persisting state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Plan mode control](../ui-plan/README.md) — the sibling composer chip over a Host projection.
- [Permission presets](../ui-permission-presets/README.md) — the sibling composer trigger and its collapse rule.
- [Session Controller](../../api/session-controller/README.md) — the Host `sessionMode` Remote and projection.

-----

<a id="model-experience"></a>
## Model Experience

The chip itself changes no model request. The Host owns the model-visible effect: after a recorded switch it appends one user-role notification to the next admitted request, for example `[模式：直接模式。从这里起由你自己完成任务。]`. The notification states the conversational policy only; tools, preset, and system prompt stay unchanged.

#### KV Cache effect

None at the switch step. The notification is appended after the cached prefix, and the system prompt and tool list do not change, so switching modes mid-conversation does not reset cache hits.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The control is a two-state switch, not a picker. A future third mode needs a menu and a wider projection.
- The chip is hidden in addressed subagent conversations by design; those Sessions run the delegated prompt shipped with their mode.
- Before the first projection frame arrives the chip displays work mode, matching the Host default. It does not distinguish an older Host without the capability.
- Switching by phrase (`切到直接模式` / `切到工作模式`) is recognized by the Host prompt admission, not by this package; the chip only reflects the resulting projection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The chip occupies the free `conversation.input.left` list beside the permission and plan seats. It deliberately does not live in `conversation.input.model`: the model seat is a single-occupant selection surface owned by model selection, while mode is its own policy control. The label collapses under the shared 460px container query so the composer row stays inside a 420px narrow surface.

</details>
