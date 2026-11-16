---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-07-collaboration-messages-question-batches

English | [中文](2026-11-07-collaboration-messages-question-batches.zh.md)

## Summary

Adds optional agent-message correlation metadata (message, effectId, summaryPermit) and the user-question/batch event for staged answers and idempotent batch acceptance.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-collaboration-messages-question-batches
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-01-prompt-modes"
    after: "382f34f93db2a9fb80b43e89757b7e2faec3c7deeb46fb5897c7fc84d5c8811e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-01-prompt-modes"
    after: "ffc135a926adb72bbd6448f266342f683bb885f58b855532b5a137109919d73f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-01-prompt-modes"
    after: "7d99fd129d5b6ce4210733ba092111de5507e0e7c48aca372c030c8d3a4eafa6"
    decision: same-version
  - root: "event:user-question/batch"
    previous: null
    after: "d082684c2e03f07773dcee49f18f9246d970ecf5d635683096a958d1a3369530"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-01-prompt-modes"
    after: "96c18def2285103c4b50249c917bc8b32aa138303f54f8b8903ad3214d1f6d86"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing AgentMessageSource fields and discriminators are unchanged; historical messages omit the three optional fields and retain their original meaning. Readers that do not consume those optional fields continue to interpret the original sender attribution. New question batch revisions use their own required event discriminator rather than changing tool results or user-question-reply sources. Current readers validate and project the batch; older readers without that event vocabulary refuse the unknown required event before interpreting the log. This safe refusal and the additive optional metadata permit the existing Session format version to remain unchanged. Projection stateVersion advances independently; no historical generation is rewritten.

<a id="verification"></a>
## Verification

Focused user-questions, tool-ask-user, and ui-user-questions Vitest suites exercise admission, staging, foreground resolution, timeout, duplicate submission and child delivery. The user-questions Loader composition uses the real JSONL backend to stage an answer, recreate the composition, submit once from concurrent panels, persist one inbox reply and distinguish answered from skipped. A pre-generation JSONL read refused the unknown required event; regenerating known-event-types enables the new reader. Affected package tsc -b and persistence catalog checks cover the declared fields.

<a id="dev-note"></a>
## Dev Note

None.
