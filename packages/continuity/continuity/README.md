---
description: "Pure versioned continuity ledger model, return classification, and deterministic fixed-area rendering for main-line session continuity."
kind: "package-library"
---

# @deepseek-ai/dsh-continuity

English | [中文](README.zh.md)

## Summary

`dsh-continuity` folds the continuity events in one main Session log into a versioned ledger and derives continuity decisions from it: optimistic commits, main-ledger field classification, defer/wake return modes, managed-effect authorization, and the deterministic fixed area used by ledger checkpoints. The package is pure TypeScript: it registers no plugin, holds no mutable state, and never calls a model. Runtime owners (`dsh-subagent` and the AgentTeams adapter) own sessions, locks, persistence, and delivery.

## Model Experience

#### What the model sees

Ledger checkpoints use the deterministic fixed area. `renderPendingDecisions(state, items, limits)` separately renders Chinese notifications containing the original decision version, field names, before/after values, reason, and source branch; proposals remain explicitly unadopted. It resolves decisions by event id rather than substituting inbox summaries or current field values.

#### Token effect

Notification values and reasons are clipped with `…（已截断）` after redaction, without splitting surrogate pairs. Sensitive field paths and nested credential properties are masked in full; credential assignments, Bearer/Basic authorization, opaque token prefixes, and URL credentials use `[已脱敏]`. These display rules do not change the stored ledger or the fixed-area renderer; the ledger is not a credential store. The caller supplies UTF-16 character limits for individual values and the complete notification. Whole decisions fill the batch in order, reserving a Chinese remainder-count footer; the result returns only included inbox ids. A single decision that still cannot fit, or missing original details, raises an error instead of producing an incomplete decision. Fixed-area token cost follows the compaction budget.

#### KV Cache effect

Notifications append to history without changing system or tool declarations. Fixed-area rendering is deterministic per ledger state and renderer version; newer revisions intentionally replace the checkpoint, while the same revision renders identical text and hash.

## Known Limitations and Deferred Work

- **Runtime entry** — consumers import `@deepseek-ai/dsh-continuity`, which resolves to built JavaScript outside source tooling. Do not import `/src/*` from runtime packages. Source tooling resolves the public entry through the generated `tsconfig` alias; this package also enables `erasableSyntaxOnly` to reject parameter properties, enums, and value namespaces.
- **No runtime ownership** — persistence, locks, wake, inbox delivery, and Teams integration live in consuming packages; this model only validates and folds values.
- **Heuristic token pricing** — fixed-area budgets use the shared 4-characters-per-token density until exact tokenizer integration exists.

## Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Ledger values and durable `continuity/*` Session events |
| [`src/ledger.ts`](src/ledger.ts) | Optimistic commit, replay fold, classification, read sets, effects |
| [`src/render.ts`](src/render.ts) | Deterministic fixed-area renderer and text token estimate |
| [`src/pending.ts`](src/pending.ts) | Bounded, redacted pending-decision notifications |
| [`tests/ledger.spec.ts`](tests/ledger.spec.ts) | Idempotency, conflict, classification, authorization, rendering |
