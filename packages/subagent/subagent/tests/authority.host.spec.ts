/** Loader-composed execution authority, tree delivery, capacity and human reports. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Control from '@deepseek-ai/dsh-tool-subagent-control'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Subagents, { SubagentAdmissionPolicy, SubagentHumanTurnObserver } from '../src/index.ts'
import type { SubagentAdmissionRequest, SubagentDirectHumanTurn } from '../src/index.ts'
import type { SubagentPromptRequestId } from '../src/control-types.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const signal = new AbortController().signal
const prompt = [{ type: 'text' as const, text: 'task' }]

class Policy extends SubagentAdmissionPolicy {
  readonly checks: SubagentAdmissionRequest[] = []
  check(request: SubagentAdmissionRequest) {
    this.checks.push(request)
    if (request.label === 'denied') return { allow: false as const, reason: 'test execution denied' }
    return { allow: true as const, ...(request.label.startsWith('limited') ? { quotaGroup: { id: 'limited', max: 1 } } : {}) }
  }
}

class Reports extends SubagentHumanTurnObserver {
  readonly turns: SubagentDirectHumanTurn[] = []
  readonly reminders: MessageId[] = []
  onTurnEnded(turn: SubagentDirectHumanTurn) {
    this.turns.push(turn)
    const first = turn.queueReminder([{ type: 'text', text: 'Summarize the human discussion to your parent.' }])
    expect(turn.queueReminder([{ type: 'text', text: 'duplicate' }])).toBe(first)
    this.reminders.push(first)
  }
}

async function boot(adapter: MockAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-authority-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  ctx.llm.registerAdapter(['mock'], adapter)
  const config = join(root, 'cordis.yml')
  await writeFile(config, `- name: cordis:subagents
  config: { maxDepth: 3, maxActiveSubagents: 16, continuityAutoBind: true }
- name: cordis:spawn
- name: cordis:control
- name: cordis:policy
- name: cordis:reports
`)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, subagents: Subagents, spawn: Spawn, control: Control, policy: Policy, reports: Reports })
  const composition = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const handle = await ctx.agents.create({ sessionId: SessionId('authority-main'), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })
  const parent = handle.agent
  // Root output is not part of these tests; keep messages durable and parked.
  ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent ? { kind: 'reject', reason: { kind: 'refusal' } } : next())
  const start = (label: string, owner = parent, childId?: SessionId, source: 'service' | 'workflow' = 'service') =>
    ctx.subagents.startActivation({ provider: 'spawn', label, ...(childId === undefined ? {} : { childId }), source, delivery: 'caller', request: { parent: owner, prompt, maxDepth: 3 }, signal })
  return { ctx, parent, start, composition, policy: ctx.get('subagentAdmissionPolicy') as Policy, reports: ctx.get('subagentHumanTurnObserver') as Reports }
}

it('reserves a group atomically and releases creation failure, cancellation, disposal and cold-resume failure', async () => {
  const adapter = new MockAdapter(Array.from({ length: 8 }, () => ({ hangAfter: [] })))
  const { ctx, parent, start } = await boot(adapter)
  const first = await start('limited first')
  await expect(start('limited excess')).rejects.toMatchObject({ code: 'ACTIVATION_GROUP_LIMIT_REACHED' })
  await first.dispose()
  const failId = SessionId('creation-failure')
  const unhook = ctx.on('agent/created', ({ agent }) => { if (agent.id === failId) throw new Error('create failed') })
  await expect(start('limited failure', parent, failId)).rejects.toThrow('create failed')
  unhook()
  const aborted = AbortSignal.abort()
  await expect(ctx.subagents.startActivation({ provider: 'spawn', label: 'limited cancelled', delivery: 'caller', request: { parent, prompt }, signal: aborted })).rejects.toThrow()
  const second = await start('limited second')
  await expect(ctx.subagents.sendMessage(parent, first.childId, prompt, { signal })).rejects.toMatchObject({ code: 'ACTIVATION_GROUP_LIMIT_REACHED' })
  await second.dispose()
  await ctx.subagents.sendMessage(parent, first.childId, prompt, { signal })
  expect(ctx.agents.get(first.childId)?.session.header.parentSession).toBe(parent.id)
  await expect(start('limited excess again')).rejects.toMatchObject({ code: 'ACTIVATION_GROUP_LIMIT_REACHED' })
})

it('counts pending materialization and returns its group slot after cancellation', async () => {
  const { ctx, parent, start } = await boot(new MockAdapter([{ hangAfter: [] }]))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const childId = SessionId('pending-limited')
  const stop = ctx.on('agent/created', async ({ agent }) => {
    if (agent.id !== childId) return
    entered.resolve()
    await release.promise
  })
  const controller = new AbortController()
  const pending = ctx.subagents.startActivation({ provider: 'spawn', childId, label: 'limited pending', delivery: 'caller', request: { parent, prompt }, signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow()
  await entered.promise
  await expect(start('limited overflow')).rejects.toMatchObject({ code: 'ACTIVATION_GROUP_LIMIT_REACHED' })
  controller.abort()
  release.resolve()
  await rejected
  stop()
  const replacement = await start('limited replacement')
  await replacement.dispose()
})

it('checks workflow and direct service execution and removes optional providers with their Loader composition', async () => {
  const { ctx, start, policy, composition } = await boot(new MockAdapter([]))
  await expect(start('denied', undefined, undefined, 'workflow')).rejects.toMatchObject({ code: 'ADMISSION_DENIED' })
  await expect(start('denied')).rejects.toMatchObject({ code: 'ADMISSION_DENIED' })
  expect(policy.checks.map(request => request.source)).toEqual(['workflow', 'service'])
  await ctx.loader.resolve(composition).fiber!.dispose()
  expect(ctx.get('subagentAdmissionPolicy')).toBeUndefined()
  expect(ctx.get('subagentHumanTurnObserver')).toBeUndefined()
  expect(ctx.get('sessionAgentAcquisition')).toBeUndefined()
})

it('routes siblings by unique label with durable sender identity and idempotent effects; duplicate names return paths', async () => {
  const { ctx, parent, start } = await boot(new MockAdapter(Array.from({ length: 4 }, () => ({ hangAfter: [] }))))
  const a = await start('first')
  const b = await start('second')
  const sender = ctx.agents.get(a.childId)!
  const call = { name: 'send_message', arguments: { to: 'second', message: 'question', kind: 'question' }, callId: ToolCallId('same-message'), agent: sender, signal }
  const sent = await ctx.tools.execute(call)
  const repeated = await ctx.tools.execute(call)
  expect(sent.isError).toBe(false)
  expect(repeated.value).toEqual(sent.value)
  const target = ctx.agents.get(b.childId)!
  const inserted = target.session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
    .filter(message => message.source.kind === 'agent-message' && message.source.senderSessionId === a.childId)
  expect(inserted).toHaveLength(1)
  expect(inserted[0]?.source).toMatchObject({ message: { source: a.childId, target: b.childId, kind: 'question' } })
  await start('second')
  const ambiguous = await ctx.subagents.resolveTarget(sender, 'second', signal)
  expect(ambiguous.kind).toBe('ambiguous')
  if (ambiguous.kind === 'ambiguous') expect(ambiguous.candidates.map(row => row.path)).toEqual([[parent.id, 'second'], [parent.id, 'second']])
  expect(await ctx.subagents.resolveTarget(sender, 'main', signal)).toEqual({ kind: 'resolved', id: parent.id })
  expect(await ctx.subagents.resolveTarget(sender, 'self', signal)).toEqual({ kind: 'resolved', id: sender.id })
  const other = await ctx.agents.create({ sessionId: SessionId('other-root') })
  expect(await ctx.subagents.resolveTarget(sender, other.agent.id, signal)).toEqual({ kind: 'outside-tree', target: other.agent.id })
  await expect(ctx.subagents.sendMessage(sender, other.agent.id, prompt, { signal })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

it('restores a cold sibling through the real cold parent chain, never as an independent root', async () => {
  const { ctx, parent, start } = await boot(new MockAdapter(Array.from({ length: 6 }, () => ({ hangAfter: [] }))))
  const branch = await start('branch')
  const middle = ctx.agents.get(branch.childId)!
  const leaf = await start('leaf', middle)
  await branch.dispose()
  const sibling = await start('sender')
  const sender = ctx.agents.get(sibling.childId)!
  await ctx.subagents.sendMessage(sender, leaf.childId, prompt, { signal, effectId: 'cold-message' })
  expect(ctx.agents.get(leaf.childId)?.session.header.parentSession).toBe(branch.childId)
  expect(ctx.agents.get(branch.childId)?.session.header.parentSession).toBe(parent.id)
})

it('rejects grandparent interruption while direct-parent interruption preserves grandchildren', async () => {
  const { ctx, parent, start } = await boot(new MockAdapter(Array.from({ length: 3 }, () => ({ hangAfter: [] }))))
  const branch = await start('branch')
  const middle = ctx.agents.get(branch.childId)!
  const leaf = await start('leaf', middle)
  expect(() => ctx.subagents.interrupt(leaf.childId, { kind: 'ancestor', agent: parent })).toThrow('not a direct child')
  expect(() => ctx.subagents.interruptByParent(leaf.childId, parent.id, 'continuable')).toThrow('does not belong')
  ctx.subagents.interrupt(branch.childId, { kind: 'ancestor', agent: parent })
  await middle.whenIdle()
  expect(ctx.agents.get(leaf.childId)?.status).toBe('running')
  ctx.subagents.interrupt(leaf.childId, { kind: 'ancestor', agent: middle })
  await leaf.result
})

it('rejects cold grandchildren and reports not-running only for a recorded direct child', async () => {
  const { ctx, parent, start } = await boot(new MockAdapter([{ hangAfter: [] }, { hangAfter: [] }]))
  const branch = await start('branch')
  const middle = ctx.agents.get(branch.childId)!
  const leaf = await start('leaf', middle)
  const hold = await ctx.subagents.acquireLive(parent, branch.childId, signal)
  expect(() => ctx.subagents.interrupt(leaf.childId, { kind: 'ancestor', agent: parent })).toThrow('not a direct child')
  await vi.waitFor(() => expect(ctx.agents.get(leaf.childId)?.status).toBe('running'))
  expect(ctx.subagents.interrupt(leaf.childId, { kind: 'ancestor', agent: middle })).toEqual({ accepted: true })
  await leaf.result
  await vi.waitFor(() => expect(ctx.agents.get(leaf.childId)).toBeUndefined())
  expect(() => ctx.subagents.interrupt(leaf.childId, { kind: 'ancestor', agent: parent })).toThrow('not a direct child')
  expect(ctx.subagents.interrupt(leaf.childId, { kind: 'ancestor', agent: middle })).toEqual({ accepted: false, reason: 'not-running' })
  const tool = await ctx.tools.execute({ callId: ToolCallId('cold-interrupt'), name: 'interrupt', arguments: { agent_id: leaf.childId }, agent: middle, signal })
  expect(tool.value).toEqual({ accepted: false, reason: 'not-running' })
  expect(JSON.stringify(tool.content)).toContain('is not running; nothing to interrupt')
  ctx.subagents.interrupt(branch.childId, { kind: 'ancestor', agent: parent })
  hold.release()
  await branch.result
})

it('queues one reminder for a real human turn and admits only its correlated human-summary report', async () => {
  const adapter = new MockAdapter([textResponse('delegated answer'), textResponse('human answer'), { hangAfter: [] }])
  const { ctx, parent, start, reports } = await boot(adapter)
  const initial = await start('conversation')
  await initial.result
  expect(reports.turns).toHaveLength(0)
  await ctx.subagents.prompt({ requestId: 'human-turn' as SubagentPromptRequestId, parentSessionId: parent.id,
    childSessionId: initial.childId, mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: 'human input' }] }, signal)
  await vi.waitFor(() => expect(reports.reminders).toHaveLength(1))
  await vi.waitFor(() => expect(adapter.requests).toHaveLength(3))
  const child = ctx.agents.get(initial.childId)!
  await expect(ctx.subagents.sendMessage(child, parent.id, prompt, { signal })).rejects.toMatchObject({ code: 'INPUT_CLOSED' })
  await expect(ctx.subagents.sendMessage(child, parent.id, prompt, { signal, kind: 'report', reportKind: 'human-summary', replyTo: 'forged' as MessageId })).rejects.toMatchObject({ code: 'INPUT_CLOSED' })
  const options = { signal, kind: 'report' as const, reportKind: 'human-summary', replyTo: reports.reminders[0]! }
  const delivered = await ctx.subagents.sendMessage(child, parent.id, prompt, options)
  expect(await ctx.subagents.sendMessage(child, parent.id, prompt, options)).toBe(delivered)
  expect(reports.turns[0]?.effectId).toBe(`direct-human-turn:${child.id}:2`)
  expect(ctx.subagents.continuity.status(child.id).pendingCount).toBe(0)
  expect(adapter.requests[2]!.messages.filter(message => message.role === 'user').map(message => message.content.map(block => block.type === 'text' ? block.text.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<id>') : block))).toMatchSnapshot('human-summary reminder request')
  await expect(ctx.tools.execute({ name: 'send_message', arguments: { to: 'parent', agent_id: parent.id, message: 'invalid' }, callId: ToolCallId('two-addresses'), agent: child, signal })).resolves.toMatchObject({ isError: true })
  child.cancel({ kind: 'user' })
})
