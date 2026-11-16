---
kind: upgrade-guide
description: "Custom delegation compositions need the shared delegation service, and workflows now enforce complete LLM routes and the Host depth limit."
---

# Shared subagent delegation

English | [中文](guide.zh.md)

## Change

Custom compositions that mount `@deepseek-ai/dsh-tool-subagent` or `@deepseek-ai/dsh-workflow-ptc` must also mount `@deepseek-ai/dsh-subagent-delegation`. The shipped base bundle includes it. Delegation parameter schemas and activation acknowledgements remain unchanged.

Workflow `agent()` calls now share preset, exact-model permission, adapter preflight and depth checks with native delegation. Provider-only or model-only LLM overrides are rejected. An omitted workflow depth uses the Host `subagent.maxDepth` setting instead of sending no limit. External providers that cannot enforce a numeric cap require explicit `maxDepth: provider-managed`.

Fork supports explicitly selected independent presets. Omitting the preset retains the parent's current preset; selecting a readonly preset retains conversation history, not the parent's writable tools.

## Migration

1. Add `- name: '@deepseek-ai/dsh-subagent-delegation'` beside the native subagent service in custom compositions. Ensure the package is in the profile's dependencies; do not add an extra service row when using the updated base bundle.
2. Update workflow overrides to provide both LLM fields: `agent('task', { provider: 'your-provider', model: 'your-model' })`. Register that route in the Session's allowed-model policy and ensure its adapter can resolve it.
3. Configure `workflow-ptc.config.maxDepth` when the Host default is not the intended cap. Use `provider-managed` only for a backend that owns its recursion policy. Configure `agentPreset` to select a fixed workflow-child preset.
4. Check the composed profile and run `pnpm exec vitest run packages/subagent/subagent-delegation/tests packages/workflow/workflow-ptc/tests` without model credentials. Confirm that a forked readonly child has no `write`, `edit` or `bash` declaration, and that a workflow beyond the selected depth returns a start error without creating a child.

5. Replace `interrupt_agent` with `interrupt`; set `tool-subagent-control.config.legacyInterruptAgent: true` only when existing conversations still need the old name. Both names authorize only the exact direct parent, not grandparents or siblings, even for unloaded targets. Historical logs remain readable without making historical tool names executable. An inactive recorded direct child now returns `{ accepted: false, reason: 'not-running' }`, not a successful stop request.
