---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-prompt-modes

English | [中文](2026-11-01-prompt-modes.zh.md)

## Summary

Records conversational mode selection, branch-local read baselines, and the session-mode/continuity-baseline message sources. Refreshes the inventory for the already-present continuity events and optional compact-checkpoint strategy field.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-prompt-modes
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "8449aeae390fd7152234b5bdae8ad5ac78b255318b05d8429e907ae05803f927"
    decision: same-version
  - root: "event:continuity/ack"
    previous: null
    after: "5e575bcbc6dfc81a44a1fa06990e184d1ed97c9e3a001097dbdae3632cf46b10"
    decision: same-version
  - root: "event:continuity/branch-read"
    previous: null
    after: "d3cbc40e36b0da014339786df41b35f54cef08e781580e4e3099d18d364eb173"
    decision: same-version
  - root: "event:continuity/delivery"
    previous: null
    after: "e7a92fb3a187e718d31d882cd0446a3ca18dc1c6b870a3cbd5b8c18db6cba3bb"
    decision: same-version
  - root: "event:continuity/observe"
    previous: null
    after: "26c1896f19b8c2b96b1b65bb5455274bd9bd0e68a3ddee1e4c76075cf84caaff"
    decision: same-version
  - root: "event:continuity/read"
    previous: null
    after: "0cd08990fff8b833ba92d48443029629945b18467382b61e47b8b55f95586056"
    decision: same-version
  - root: "event:continuity/transaction"
    previous: null
    after: "2ebb903d54b6c34b6ad716a4fae9bcaddb66912020b8e5a284a7d4e74d0e11d5"
    decision: same-version
  - root: "event:continuity/wake"
    previous: null
    after: "2d6d95a2fb54b2eb985d7ce3268eac01cf31019cb256f513f16770ab7bdf6dbd"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "b72367c7e9876b93d754d0fa8251cd2d502299c77696b47e9eb1046dbca22c68"
    decision: same-version
  - root: "event:session-mode/selected"
    previous: null
    after: "b864273d453fa3f21a525d8ce680805b9b782c52bee0586c201a87d2ec89a61a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "1b4e1505d9960443f391d372d42256e2fc4799af05240b4aa664d53a00a0136c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "9936acdfe391ab5206c8595d220fd1fa229321bd71b8f1a414f7da2d8b50b286"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Historical event payloads remain unchanged and the writer remains V4. The new selection and branch-read event discriminators are required-on-read: a released reader that does not know them refuses the log rather than resuming with an incorrect policy. New message sources retain the ordinary user-role content representation and are preserved as extension metadata; no existing source discriminator changes meaning. The optional checkpoint strategy field and pre-existing continuity event additions retain their previous runtime behavior. No committed historical generation is rewritten or removed.

<a id="verification"></a>
## Verification

Focused continuity controller, child-preset exclusion, parent-result routing, settlement-content and continuation tests: 199 subagent tests passed. Mode notifications are also covered by a Loader-composed Agent-loop test and owner-local model-visible snapshots. Full contract regressions and build are recorded in the task completion evidence.

<a id="dev-note"></a>
## Dev Note

None.
