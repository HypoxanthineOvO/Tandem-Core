# Known Core lifecycle issues

These four failures were reproduced using the original integration metadata and byte-identical runtime/test files from `2501530cedcdc727e7b7403e79611d9d2b3cdc33`. They predate the Tandem packaging and sanitization changes. They remain failing tests; no runtime workaround or assertion suppression is applied. Publication severity is subject to independent review.

## Loop-only teardown retains queued input

- Test: `packages/core/agent-loop/tests/resource-lifecycle.spec.ts` — `unloads loop while a background child is stopping`.
- Reproduction: mount the shared delegation service, start a child blocked in `agent/request`, enqueue next-step and next-turn messages, then dispose only the AgentLoop plugin while the root context remains alive.
- Observed: the child stops, but the expected durable inbox-cancellation splices are absent. Disposing the entire root context passes the corresponding test.
- Scope: partial plugin unload and subsequent queued-input lifecycle; ordinary startup, image requests and whole-process shutdown are separate paths.
- Baseline: the original release fixture failed earlier because it omitted the required delegation service. Adding that fixture dependency exposes this queue assertion on the unchanged release runtime.

## Pre-step checkpoint failure parks a continuation

- Test: `packages/subagent/subagent/tests/continuation.spec.ts` — `reports a turn that failed before reaching its first step`.
- Reproduction: a child completes its first task, a second task is queued, and an `agent/pre-step` listener throws a synthetic disk-full error before that second task reaches a model request.
- Observed: failed-input recovery preserves the pending human task for retry, keeping its activation resident. The inherited test waiting for a terminal failure notice times out.
- Scope: checkpoint/assembly failure after continuation admission but before request admission. The unresolved question is whether parent-facing state should report the parked failure while retaining retryable input.
- Baseline: identical failure on `2501530c` with original metadata; this candidate does not change checkpoint or activation behavior.

## Teardown settlement notice reappears on parent resume

- Test: `packages/subagent/subagent/tests/continuation.spec.ts` — `records but cannot deliver a teardown notice once the parent is disposed too`.
- Reproduction: drain a child's subtree, deliver its stopped notice to an idle parent, dispose that parent, then resume the same parent session.
- Observed: the resumed parent still exposes one settlement notice, whereas the inherited test expects the unread notice to have been durably cancelled.
- Scope: unread settlement delivery across parent disposal/resumption; it may cause a stopped-child notification to be seen after reopening a session.
- Baseline: identical assertion failure on `2501530c` with original metadata. No session format or replay semantics are changed by packaging.

## Source-attribution fixture observes repeated recovery splices

- Test: `packages/api/session-controller/tests/remote-access.host.spec.ts` — `records a non-owner caller on the prompt source and leaves owner sources unchanged`.
- Reproduction: submit a guest prompt followed by an owner prompt through the queue API in the minimal access-control fixture, which has no successful model response configured; inspect every inserted source in durable inbox-splice events.
- Observed: the two original source records are accompanied by additional guest-source insertions as failed-input recovery requeues work. The old test expects exactly one insertion per accepted prompt and fails. The additional entries retain the guest principal rather than acquiring owner authority.
- Scope: input recovery and source projection under a failing/minimal model configuration. Whether these additional queue records can become duplicate visible messages or duplicate model input has not been established, so the assertion is retained rather than weakened.
- Baseline: the test and controller implementation are byte-identical to `2501530c`; the failure reproduces in the focused access-control suite as well as the 27-package test run. Packaging changes neither source attribution nor retry behavior.
