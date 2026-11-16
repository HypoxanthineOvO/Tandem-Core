---
kind: upgrade-guide
description: "Older builds refuse Sessions containing durable user-question batch events."
---

# Durable question batches

English | [中文](guide.zh.md)

## Change

Keyed user questions record `user-question/batch` revisions, including staged answers and submission receipts. Builds whose generated Session vocabulary does not include that event refuse those logs rather than lose accepted answers. The Session format version is unchanged. Existing questions and agent-message attribution remain readable; the three new agent-message metadata fields are optional. See the [persistence acknowledgement](../../../persistence-changes/2026-11-07-collaboration-messages-question-batches.md).

## Migration

1. Upgrade the question Host and native question Client together. Custom answer panels use `submitBatch` for both foreground and continued questions; use `stageAnswer` to retain per-question answers on the Host.
2. Keep a backup before writing new question batches. An older release cannot reopen those newly written Sessions; retain the newer release when returning to them. Do not remove required events or rewrite stored generations to force a downgrade.
3. Deployments enabling child questions install a `HumanInteractionPolicy` provider and set `userQuestions` config `requirePolicy: true`. Without an installed or required policy, runtime-root-only behavior remains unchanged.
4. Verify that `query(session)` reconstructs staged answers after reopening a Session and that repeating `submitBatch` returns `already-submitted` without another reply.
