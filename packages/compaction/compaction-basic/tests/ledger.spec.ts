import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { commitToLedger, foldLedgerEvents, initialLedger, renderFixedArea } from '@deepseek-ai/dsh-continuity'
import type { LedgerState } from '@deepseek-ai/dsh-continuity'
import { LedgerCompactionEngine } from '../src/ledger.ts'
import { createUserMessage, createMessage, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { selectCompactableRange } from '../src/region.ts'

const MODEL = 'ledger-test-model'

class StubAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function context(): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new StubAdapter())
  return ctx
}

function agent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as Agent
}

function ledgerSession(id: string, turns: number): { session: Session; ledger: LedgerState } {
  const session = Session.create(SessionId(id))
  let ledger = initialLedger('main', 'branch')
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
  for (let index = 0; index < turns; index += 1) {
    const event = `event-${index}`
    const result = commitToLedger(ledger, {
      eventId: event,
      baseRev: ledger.rev,
      actor: { kind: 'agent', id: 'branch' },
      source: { sessionId: 'branch', turnId: String(index) },
      patch: [
        { key: index === 0 ? 'goal.scope' : index === 1 ? 'artifact.report' : 'risk.note', before: ledger.fields[index === 0 ? 'goal.scope' : index === 1 ? 'artifact.report' : 'risk.note'], after: `${event}-${'x'.repeat(120)}` },
      ],
      reason: `ledger ${event}`,
      at: index + 1,
      ...index === 1 ? {
        workItem: {
          id: 'compaction-work',
          sourceRefs: [event],
          owner: { kind: 'agent', id: 'branch' },
          acceptance: ['constraints and artifact pointers survive checkpoints'],
          closePolicy: 'user-accept' as const,
          taskRefs: ['t20'],
        },
      } : {},
      ...index === 2 ? {
        workItem: {
          id: 'compaction-work',
          sourceRefs: [event],
          owner: { kind: 'agent', id: 'branch' },
          acceptance: ['constraints and artifact pointers survive checkpoints'],
          closePolicy: 'user-accept' as const,
          taskRefs: ['t20'],
          acceptedAt: 42,
        },
      } : {},
    })
    if (result.kind !== 'committed' || result.transaction === undefined) throw new Error(result.kind)
    ledger = result.state
    session.append('continuity/transaction', result.transaction)
    session.append('step/start', { turn: 1, step: index + 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${event} history ${'y'.repeat(600)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: index + 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${event} reply ${'z'.repeat(600)}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: index + 1 })
  }
  return { session, ledger }
}

describe('ledger compaction strategy', () => {
  it('replaces visible history with one deterministic fixed-area checkpoint', async () => {
    const ctx = context()
    const engine = new LedgerCompactionEngine(ctx)
    const { session, ledger } = ledgerSession('ledger-one', 4)
    const before = session.surface.nodes.length
    const range = selectCompactableRange(session, ctx.tokenMeter.measure(session), 100, true)
    expect(range).not.toBeNull()
    const result = await engine.compactRegion(range!.start, range!.end, agent(session))
    expect(result.summary).toHaveLength(1)
    const checkpoint = session.eventAt(session.surface.nodes.find(seq => {
      const event = session.eventAt(seq)
      return event?.type === 'user/message' && event.data.source.kind === 'compact-checkpoint'
    })!)
    if (checkpoint?.type !== 'user/message') throw new Error('missing ledger checkpoint')
    expect(checkpoint.type).toBe('user/message')
    expect(checkpoint.data.source).toMatchObject({ kind: 'compact-checkpoint', strategy: 'ledger' })
    expect(session.surface.nodes.length).toBeLessThan(before)
    const summary = session.snapshotEvents().find(event => event.type === 'compaction/summary')
    expect(summary).toMatchObject({ data: { provider: 'dsh-continuity', model: 'fixed-area-renderer-1' } })
    const folded = foldLedgerEvents('main', session.snapshotEvents(), 'branch')
    expect(renderFixedArea(folded).hash).toBe(renderFixedArea(ledger).hash)
    expect(folded.fields['artifact.report']).toBe(ledger.fields['artifact.report'])
  })

  it('keeps constraints, todos, and artifact pointers identical across three compactions and replay', async () => {
    const ctx = context()
    const engine = new LedgerCompactionEngine(ctx)
    const { session, ledger } = ledgerSession('ledger-three', 8)
    const expected = renderFixedArea(ledger).hash
    for (let round = 0; round < 3; round += 1) {
      appendHistoryPair(session, round)
      const range = selectCompactableRange(session, ctx.tokenMeter.measure(session), 100, true)
      if (range === null) throw new Error(`no range in round ${round}`)
      await engine.compactRegion(range.start, range.end, agent(session))
    }
    const replayed = foldLedgerEvents('main', session.snapshotEvents(), 'branch')
    expect(renderFixedArea(replayed).hash).toBe(expected)
    expect(replayed.fields['goal.scope']).toBe(ledger.fields['goal.scope'])
    expect(replayed.fields['artifact.report']).toBe(ledger.fields['artifact.report'])
    expect(replayed.workItems['compaction-work']).toEqual(ledger.workItems['compaction-work'])
    expect(replayed.workItems['compaction-work']?.acceptedAt).toBe(42)
  })

  it('protects the ledger checkpoint from ordinary summary selection', async () => {
    const ctx = context()
    const engine = new LedgerCompactionEngine(ctx)
    const { session } = ledgerSession('ledger-protected', 3)
    const first = selectCompactableRange(session, ctx.tokenMeter.measure(session), 100, true)
    await engine.compactRegion(first!.start, first!.end, agent(session))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `after checkpoint ${'w'.repeat(900)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const ordinary = selectCompactableRange(session, ctx.tokenMeter.measure(session), 0)
    const checkpointIndex = session.surface.nodes.findIndex(seq => {
      const event = session.eventAt(seq)
      return event?.type === 'user/message' && event.data.source.kind === 'compact-checkpoint'
    })
    const startIndex = session.surface.nodes.findIndex(seq => seq === ordinary?.start)
    expect(startIndex).toBeGreaterThan(checkpointIndex)
  })
})

function appendHistoryPair(session: Session, index: number): void {
  const step = 100 + index
  session.append('step/start', { turn: 1, step })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `third-compaction-${index} ${'q'.repeat(1200)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `third-reply-${index} ${'r'.repeat(1200)}` }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step })
}
