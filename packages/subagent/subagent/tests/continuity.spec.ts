import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { foldLedgerEvents, type PendingNotificationLimits } from '@deepseek-ai/dsh-continuity'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { ContinuityController, lastDirectHumanInput } from '../src/continuity/controller.ts'
import { admittedEffectMessageId } from '../src/manager.ts'

function harness(notificationLimits?: () => PendingNotificationLimits): { agent: Agent; controller: ContinuityController; session: Session; wake: string[]; ctx: Context; flush: { result: boolean; error?: unknown }; services: { sessions: { get(id: string): Session | undefined; flush(): Promise<boolean> } } } {
  const ctx = new Context()
  const session = Session.create(SessionId('main'))
  const wake: string[] = []
  const flush: { result: boolean; error?: unknown } = { result: true }
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    followup(message: ReturnType<typeof createUserMessage>) { wake.push(message.content[0]?.type === 'text' ? message.content[0].text : '') },
  } as Agent
  const services = {
    sessions: {
      get: (id: string) => id === session.id ? session : undefined,
      flush: async () => {
        if (flush.error !== undefined) throw flush.error
        return flush.result
      },
    },
  }
  const controller = new ContinuityController(ctx, services, notificationLimits)
  controller.bind(agent, SessionId('branch'))
  return { agent, controller, session, wake, ctx, flush, services }
}

/** Model-visible input retains the durable inbox identity that was actually admitted. */
function admit(session: Session, message: UserMessage): void {
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  session.append('user/message', message, { surfaceOp: 'append' })
}

function commitInput(controller: ContinuityController, eventId: string, key: string, after: string, proposal = false) {
  const state = controller.state()
  return {
    eventId,
    baseRev: state.rev,
    actor: { kind: 'agent' as const, id: 'branch' },
    source: { sessionId: 'branch', turnId: '1' },
    patch: [{ key, before: state.fields[key] ?? null, after }],
    reason: `set ${key}`,
    at: Date.now(),
    proposal,
  }
}

describe('continuity controller', () => {
  it('keeps multiple branches independent and defaults commits to each branch’s last read revision', async () => {
    const { agent, controller, session, wake, services } = harness()
    const branches = new Map(['branch', 'branch-2'].map(id => [id, Session.create(SessionId(id))]))
    services.sessions.get = (id: string) => id === session.id ? session : branches.get(id)
    controller.bind(agent, SessionId('branch-2'))
    expect(controller.status(SessionId('branch-2'))).toMatchObject({ enabled: true, branchSessionId: 'branch-2', mainSessionId: 'main' })
    controller.read([], SessionId('branch'))
    controller.read([], SessionId('branch-2'))
    const first = commitInput(controller, 'first', 'notes.first', 'one')
    const { baseRev: _baseRev, ...implicit } = first
    expect((await controller.commit(implicit)).state).toBe('committed-local')
    const second = { ...implicit, eventId: 'second', source: { sessionId: 'branch-2', turnId: '1' }, patch: [{ key: 'notes.second', before: null, after: 'two' }] }
    expect((await controller.commit(second)).state).toBe('conflict')
    controller.read([], SessionId('branch-2'))
    expect((await controller.commit(second)).state).toBe('committed-local')
    expect(controller.state().fields).toEqual({ 'notes.first': 'one', 'notes.second': 'two' })
    expect(wake).toHaveLength(0)
    expect(controller.status(SessionId('not-bound')).enabled).toBe(false)
    expect(() => controller.read([], session.id)).toThrow('这是主线会话')
    expect(() => controller.commit({ ...implicit, source: { sessionId: 'not-bound', turnId: '1' } })).toThrow('尚未绑定为受管支线')
    const branch = branches.get('branch')!
    branch.append('turn/start', { turn: 1 })
    branch.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'baseline' }], source: { kind: 'continuity-baseline', mainSessionId: session.id, rev: 2 } }), { surfaceOp: 'append' })
    admit(branch, createUserMessage({ content: [{ type: 'text', text: 'human' }], source: { kind: 'user', rpcId: 'direct' } }))
    expect(controller.integration.suppressSettlement(branch.snapshotEvents())).toBe(true)
    expect((await controller.commit({ ...implicit, eventId: 'injected', patch: [{ key: 'notes.third', before: null, after: 'three' }] })).state).toBe('committed-local')
  })

  it('routes independent main lines by source session instead of a global first binding', async () => {
    const { agent, controller, session, services } = harness()
    const secondMain = Session.create(SessionId('main-2'))
    services.sessions.get = (id: string) => id === session.id ? session : id === secondMain.id ? secondMain : undefined
    const input = { ...commitInput(controller, 'scoped', 'notes.scope', 'second'), source: { sessionId: 'other-branch', turnId: '1' } }
    controller.bind({ ...agent, id: secondMain.id, session: secondMain }, SessionId('other-branch'))
    expect((await controller.commit(input)).state).toBe('committed-local')
    expect(controller.state(secondMain.id).fields['notes.scope']).toBe('second')
    expect(controller.state(session.id).rev).toBe(0)
  })

  it('keeps a nested branch baseline, commit, and main injection on its direct parent ledger', async () => {
    const { agent: main, controller, session: mainSession, services, ctx } = harness()
    const branch = Session.create(SessionId('branch'))
    const nested = Session.create(SessionId('nested'))
    const byId = new Map([mainSession, branch, nested].map(session => [session.id, session]))
    services.sessions.get = (id: string) => byId.get(SessionId(id))
    const branchAgent = { ...main, id: branch.id, session: branch, ctx }
    const nestedAgent = { ...main, id: nested.id, session: nested, ctx }
    const outer = commitInput(controller, 'outer-only', 'notes.outer', 'outer')
    controller.bind(branchAgent, nested.id)
    await controller.commit(outer)
    expect(controller.state(main.id).rev).toBe(1)
    expect(controller.state(nested.id).rev).toBe(0)
    const decision = await agentEvents(ctx, nestedAgent).waterfall('agent/pre-step', {
      turn: 1, step: 1, messages: [], signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [] }))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected admitted baseline')
    expect(decision.messages.map(message => ({ source: message.source, content: message.content }))).toMatchInlineSnapshot(`
      [
        {
          "content": [
            {
              "text": "受管支线已连接主线。当前连续性账本版本：0。用户确认“带回主线”后再提交决议。",
              "type": "text",
            },
          ],
          "source": {
            "kind": "continuity-baseline",
            "mainSessionId": "branch",
            "rev": 0,
          },
        },
      ]
    `)
    nested.append('turn/start', { turn: 1 })
    for (const message of decision.messages) nested.append('user/message', message, { surfaceOp: 'append' })
    const result = await controller.commit({ eventId: 'nested-only', actor: { kind: 'agent', id: nested.id },
      source: { sessionId: nested.id, turnId: 'confirmed' }, patch: [{ key: 'notes.inner', before: null, after: 'inner' }], reason: 'confirmed inner decision' })
    expect(result).toMatchObject({ state: 'committed-local', rev: 1 })
    expect(controller.state(nested.id).fields).toEqual({ 'notes.inner': 'inner' })
    expect(controller.state(main.id).fields).toEqual({ 'notes.outer': 'outer' })
    await controller.injectPendingBatch(branchAgent, [], 2)
    expect(foldLedgerEvents(branch.id, branch.snapshotEvents(), nested.id).contextObservedRev).toBe(1)
    expect(controller.state(main.id).contextObservedRev).toBe(0)
  })

  it('uses the first admitted inbox input rather than appended host context to classify a turn', () => {
    const session = Session.create(SessionId('host-context'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '[模式：直接模式。从这里起由你自己完成任务。]' }], source: { kind: 'session-mode', mode: 'direct', selectionSeq: 1 } }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'host-only notification' }], source: { kind: 'user', rpcId: 'not-input' } }), { surfaceOp: 'append' })
    admit(session, createUserMessage({ content: [{ type: 'text', text: 'actual human prompt' }], source: { kind: 'user', rpcId: 'human' } }))
    expect(lastDirectHumanInput(session.snapshotEvents())).toMatchObject({ turnId: 'human' })
    session.append('turn/start', { turn: 2 })
    admit(session, createUserMessage({ content: [{ type: 'text', text: 'delegated opening' }], source: { kind: 'user' } }))
    admit(session, createUserMessage({ content: [{ type: 'text', text: 'human steering later' }], source: { kind: 'user', rpcId: 'later' } }))
    expect(lastDirectHumanInput(session.snapshotEvents())).toBeUndefined()
  })

  it('keeps human branch bodies out of parent settlement and send paths', () => {
    const ctx = new Context()
    const controller = new ContinuityController(ctx)
    const session = Session.create(SessionId('branch'))
    admit(session, createUserMessage({
      content: [{ type: 'text', text: 'delegated task' }],
      source: { kind: 'user' },
    }))
    expect(controller.integration.suppressSettlement(session.snapshotEvents())).toBe(false)
    expect(controller.integration.interceptHumanSend(session.snapshotEvents())).toBe(false)
    session.append('turn/start', { turn: 2 })
    admit(session, createUserMessage({
      content: [{ type: 'text', text: 'direct user question' }],
      source: { kind: 'user', rpcId: 'request-1' },
    }))
    expect(lastDirectHumanInput(session.snapshotEvents())).toMatchObject({ turnId: 'request-1' })
    expect(controller.integration.suppressSettlement(session.snapshotEvents())).toBe(true)
    expect(controller.integration.interceptHumanSend(session.snapshotEvents())).toBe(true)
    const delegated = Session.create(SessionId('ordinary'))
    admit(delegated, createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    }))
    expect(lastDirectHumanInput(delegated.snapshotEvents())).toBeUndefined()
    expect(controller.integration.suppressSettlement(delegated.snapshotEvents())).toBe(false)
    session.append('turn/start', { turn: 3 })
    admit(session, createUserMessage({
      content: [{ type: 'text', text: 'new delegated task' }],
      source: { kind: 'user' },
    }))
    admit(session, createUserMessage({
      content: [{ type: 'text', text: 'mid-turn human steering' }],
      source: { kind: 'user', rpcId: 'request-3' },
    }))
    expect(controller.integration.suppressSettlement(session.snapshotEvents())).toBe(false)
    expect(controller.integration.interceptHumanSend(session.snapshotEvents())).toBe(false)
    session.append('turn/start', { turn: 4 })
    admit(session, createUserMessage({
      content: [{ type: 'text', text: 'human branch opening' }],
      source: { kind: 'user', rpcId: 'request-4' },
    }))
    admit(session, createUserMessage({
      content: [{ type: 'text', text: 'later delegated queue task' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('parent') },
    }))
    expect(controller.integration.suppressSettlement(session.snapshotEvents())).toBe(true)
    expect(controller.integration.interceptHumanSend(session.snapshotEvents())).toBe(true)
  })

  it('commits once and classifies ledger-only, defer, and wake returns', async () => {
    const { controller, session, wake } = harness()
    const local = await controller.commit(commitInput(controller, 'local-1', 'notes.detail', 'detail'))
    expect(local.state).toBe('committed-local')
    expect(wake).toHaveLength(0)

    const defer = await controller.commit(commitInput(controller, 'defer-1', 'budget.tokens', '100'))
    expect(defer.state).toBe('deferred')
    expect(controller.pending()).toHaveLength(1)
    expect(wake).toHaveLength(0)

    controller.read(['budget.tokens'])
    const wakeResult = await controller.commit(commitInput(controller, 'wake-1', 'budget.tokens', '200'))
    expect(wakeResult.state).toBe('wake-queued')
    expect(wake).toHaveLength(1)
    expect(wake[0]).toBe('支线有新的待带入决议，请核对字段改动。')

    const duplicate = await controller.commit(commitInput(controller, 'wake-1', 'budget.tokens', '200'))
    expect(duplicate.state).toBe('wake-queued')
    expect(wake).toHaveLength(1)
    const conflict = await controller.commit({ ...commitInput(controller, 'conflict-1', 'budget.tokens', '300'), baseRev: 0 })
    expect(conflict.state).toBe('conflict')
    const replayed = foldLedgerEvents('main', session.snapshotEvents(), 'branch')
    expect(replayed.rev).toBe(controller.state().rev)
  })

  it('creates cross-scope proposals once and confirms them idempotently', async () => {
    const { controller } = harness()
    const proposed = await controller.commit(commitInput(controller, 'proposal-1', 'interface.external', 'v2', true))
    expect(proposed.state).toBe('deferred')
    expect(controller.pending()[0]).toMatchObject({ kind: 'proposal' })
    const confirmed = await controller.confirmProposal('proposal-1', 'confirm-1')
    expect(confirmed.state).toBe('committed-local')
    const duplicate = await controller.confirmProposal('proposal-1', 'confirm-1')
    expect(duplicate.state).toBe('committed-local')
  })

  it('rejects managed effects after the observed ledger revision advances', async () => {
    const { controller } = harness()
    const observed = controller.observeMainContext()
    expect(controller.authorize(observed).ok).toBe(true)
    await controller.commit(commitInput(controller, 'effect-1', 'schedule.deadline', 'tomorrow'))
    expect(controller.authorize(observed).ok).toBe(false)
    expect(controller.authorize(controller.state().rev).ok).toBe(true)
  })

  it('acknowledges only decisions that fit in a delivered notification and keeps the rest pending', async () => {
    const { controller, session, ctx, agent } = harness(() => ({ valueMaxChars: 64, maxChars: 256 }))
    for (const suffix of ['a', 'b', 'c']) await controller.commit(commitInput(controller, `split-${suffix}`, `acceptance.${suffix}`, 'x'.repeat(1000)))
    const live = { ...agent, ctx }
    const first = await controller.injectPendingBatch(live, [], 1)
    expect(first.messages[0]?.content).toEqual([{ type: 'text', text: expect.stringContaining('还有 2 条待带入，下次继续。') }])
    expect(session.snapshotEvents().flatMap(event => event.type === 'continuity/delivery' ? [event.data.inboxIds] : [])).toEqual([['split-a:inbox']])
    appendAssistant(session, 1, false)
    await controller.injectPendingBatch(live, [], 2)
    expect(controller.pending().map(item => item.eventId)).toEqual(['split-b', 'split-c'])
    expect(session.snapshotEvents().flatMap(event => event.type === 'continuity/ack' ? [event.data.inboxIds] : [])).toEqual([['split-a:inbox']])
    const next = await controller.injectPendingBatch(live, [], 3)
    expect(next.messages[0]?.content).toEqual([{ type: 'text', text: expect.stringContaining('还有 1 条待带入，下次继续。') }])
    expect(session.snapshotEvents().flatMap(event => event.type === 'continuity/delivery' ? [event.data.inboxIds] : [])).toEqual([['split-a:inbox'], ['split-b:inbox']])
    expect(controller.pending().find(item => item.eventId === 'split-c')?.ackedAt).toBeUndefined()
  })

  it('keeps one oversized decision unacknowledged and replaces historical summary-only deliveries with details', async () => {
    let maxChars = 1
    const { controller, session, ctx, agent } = harness(() => ({ valueMaxChars: 16, maxChars }))
    await controller.commit(commitInput(controller, 'large', 'acceptance.alpha', 'x'.repeat(1000)))
    const live = { ...agent, ctx }
    await expect(controller.injectPendingBatch(live, [], 1)).rejects.toThrow('单条待带入决议')
    expect(session.snapshotEvents().some(event => event.type === 'continuity/delivery')).toBe(false)
    expect(controller.pending()).toHaveLength(1)
    session.append('continuity/delivery', { batchId: 'batch:1:large', inboxIds: ['large:inbox'], ledgerRev: 1, turn: 1, step: 1, text: 'old summary-only notice', textHash: 'old' })
    maxChars = 8192
    const detail = await controller.injectPendingBatch(live, [], 2)
    expect(detail.messages[0]?.content).toEqual([{ type: 'text', text: expect.stringContaining('"acceptance.alpha"：null →') }])
    expect(detail.messages[0]?.content).not.toEqual([{ type: 'text', text: 'old summary-only notice' }])
    expect(session.snapshotEvents().flatMap(event => event.type === 'continuity/delivery' ? [event.data.batchId] : [])).toEqual(['batch:1:large', 'batch:v2:1:large'])
  })

  it('acks only a normal response for the delivered turn and recovers an ack after a crash', async () => {
    const { controller, session, ctx, services } = harness()
    await controller.commit(commitInput(controller, 'defer-ack', 'risk.level', 'high'))
    const bindingAgent = { id: session.id, session, status: 'running' as const, ctx } as Agent
    const ordinary = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
    const delivered = await controller.injectPendingBatch(bindingAgent, [ordinary], 7)
    expect(delivered.messages[0]!.source).toMatchObject({ kind: 'continuity-delivery' })
    appendAssistant(session, 6, false)
    appendAssistant(session, 7, true)
    appendAssistant(session, 7, false, 2)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(session.snapshotEvents().some(event => event.type === 'continuity/ack')).toBe(false)
    appendAssistant(session, 7, false, 1)
    const recoveredBatch = await controller.injectPendingBatch(bindingAgent, [ordinary], 8)
    expect(recoveredBatch.messages).toHaveLength(1)
    const acks = session.snapshotEvents().filter(event => event.type === 'continuity/ack')
    expect(acks).toHaveLength(1)
    expect(controller.status().lastSyncedBatch?.batchId).toMatch(/^batch:/)
    const restarted = new ContinuityController(ctx, services)
    restarted.bind(bindingAgent, SessionId('branch'))
    expect(restarted.status().lastSyncedBatch).toEqual(controller.status().lastSyncedBatch)
  })

  it('keeps an unflushed transaction uncertain and confirms the original receipt only after durable flush', async () => {
    const { controller, session, flush } = harness()
    flush.result = false
    const uncertain = await controller.commit(commitInput(controller, 'uncertain-1', 'budget.tokens', '10'))
    expect(uncertain.state).toBe('commit-uncertain')
    expect(controller.authorize(controller.state().rev).ok).toBe(false)
    expect(session.snapshotEvents().some(event => event.type === 'continuity/transaction' && event.data.eventId === 'uncertain-1')).toBe(true)
    flush.result = true
    const confirmed = await controller.commit(commitInput(controller, 'uncertain-1', 'budget.tokens', '10'))
    expect(confirmed.state).toBe('deferred')
    expect(session.snapshotEvents().filter(event => event.type === 'continuity/transaction' && event.data.eventId === 'uncertain-1')).toHaveLength(1)
    controller.observeMainContext()
    expect(controller.authorize(controller.state().rev).ok).toBe(true)
    flush.error = new Error('disk unavailable')
    const thrown = await controller.commit(commitInput(controller, 'flush-throws', 'risk.note', 'x'))
    expect(thrown.state).toBe('commit-uncertain')
    expect(controller.authorize(controller.state().contextObservedRev).ok).toBe(false)
    flush.error = undefined
    expect((await controller.commit(commitInput(controller, 'flush-throws', 'risk.note', 'x'))).state).toBe('deferred')
  })

  it('releases a deferred wake once after a failed flush is retried durably', async () => {
    const { controller, wake, flush } = harness()
    controller.read(['budget.tokens'])
    flush.result = false
    const uncertain = await controller.commit(commitInput(controller, 'wake-uncertain', 'budget.tokens', '20'))
    expect(uncertain.state).toBe('commit-uncertain')
    expect(wake).toHaveLength(0)
    flush.result = true
    const released = await controller.commit(commitInput(controller, 'wake-uncertain', 'budget.tokens', '20'))
    expect(released.state).toBe('wake-queued')
    expect(wake).toHaveLength(1)
    const duplicate = await controller.commit(commitInput(controller, 'wake-uncertain', 'budget.tokens', '20'))
    expect(duplicate.state).toBe('wake-queued')
    expect(wake).toHaveLength(1)
  })

  it('reuses the durable child admission for a repeated managed effect', () => {
    const child = Session.create(SessionId('managed-child'))
    const source = { kind: 'user', effectId: 'effect:team:t1' } as MessageSource & { effectId: string }
    child.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'dispatch' }],
      source,
    }), { surfaceOp: 'append' })
    const admitted = admittedEffectMessageId(child.snapshotEvents(), 'effect:team:t1')
    expect(admitted).toBeDefined()
    expect(admittedEffectMessageId(child.snapshotEvents(), 'effect:team:t1')).toBe(admitted)
    expect(admittedEffectMessageId(child.snapshotEvents(), 'effect:team:t2')).toBeUndefined()
  })

  it('injects one durable pending batch at the main line step', async () => {
    const { controller, session, ctx, flush } = harness()
    flush.result = false
    const uncertain = await controller.commit(commitInput(controller, 'defer-1', 'risk.level', 'high'))
    expect(uncertain.state).toBe('commit-uncertain')
    flush.result = true
    const confirmed = await controller.commit(commitInput(controller, 'defer-1', 'risk.level', 'high'))
    expect(confirmed.state).toBe('deferred')
    flush.result = false
    const bindingAgent = {
      id: session.id,
      session,
      status: 'running' as const,
      ctx,
    } as Agent
    const ordinary = createUserMessage({ content: [{ type: 'text', text: 'user turn' }], source: { kind: 'user' } })
    const notAdmitted = await controller.injectPendingBatch(bindingAgent, [ordinary], 2)
    expect(notAdmitted.messages).toHaveLength(1)
    expect(session.snapshotEvents().some(event => event.type === 'continuity/delivery')).toBe(true)
    flush.result = true
    const decision = await controller.injectPendingBatch(bindingAgent, [ordinary], 3)
    expect(decision.messages).toHaveLength(2)
    const delivered = decision.messages[0]!
    expect(delivered.source).toMatchObject({ kind: 'continuity-delivery' })
    const events = session.snapshotEvents().filter(event => event.type === 'continuity/delivery')
    expect(events).toHaveLength(1)
    const again = await controller.injectPendingBatch(bindingAgent, [ordinary], 4)
    expect(again.messages).toHaveLength(2)
    expect(again.messages[0]!.content).toEqual(delivered.content)
  })
})

function appendAssistant(session: Session, turn: number, interrupted: boolean, step = 1): void {
  session.append('assistant/message', {
    turn,
    step,
    ...interrupted ? { interrupted: true as const } : {},
    stream: [],
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `assistant ${turn}.${step}${interrupted ? ' interrupted' : ''}` }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
}
