/** Loader-composed Host residency holds and delayed question replies to cold children. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { ownerPeer } from '../../../api/gateway/tests/peer.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import type { UserQuestionSubmission, HumanInteractionAdmission } from '@deepseek-ai/dsh-user-questions'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import UserQuestions, { HumanInteractionPolicy } from '@deepseek-ai/dsh-user-questions'
import * as AskUser from '@deepseek-ai/dsh-tool-ask-user'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Subagents, { SubagentAdmissionPolicy } from '../src/index.ts'
import type { SubagentAdmissionRequest } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession } from './persistence-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const signal = new AbortController().signal
const prompt = [{ type: 'text' as const, text: 'task' }]

class Admission extends SubagentAdmissionPolicy {
  readonly checks: SubagentAdmissionRequest[] = []
  denyResume = false
  check(request: SubagentAdmissionRequest) {
    this.checks.push(request)
    if (request.resuming && this.denyResume) return { allow: false as const, reason: 'resume denied by test policy' }
    return { allow: true as const, ...(request.label.startsWith('limited') ? { quotaGroup: { id: 'limited', max: 1 } } : {}) }
  }
}

class InteractionAdmission extends HumanInteractionPolicy {
  readonly denied = new Set<SessionId>()
  check({ agent }: HumanInteractionAdmission) { return this.denied.has(agent.id) ? { allowed: false as const, reason: 'worker cannot ask' } : { allowed: true as const } }
}

async function boot(adapter: MockAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-live-acquisition-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(TypertGateway)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  ctx.llm.registerAdapter(['mock'], adapter)
  const config = join(root, 'cordis.yml')
  await writeFile(config, `- name: cordis:subagents
  config: { maxDepth: 3, maxActiveSubagents: 16 }
- name: cordis:spawn
- name: cordis:admission
- name: cordis:interactionAdmission
- name: cordis:sessionApi
- name: cordis:questions
  config: { requirePolicy: true }
- name: cordis:ask
  config: { mode: timed, timeout: 1 }
`)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, subagents: Subagents, spawn: Spawn,
    sessionApi: { apply() { createSessionTestController(ctx, {
      cwd: root, defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    }) } },
    admission: Admission, interactionAdmission: InteractionAdmission, questions: UserQuestions, ask: AskUser })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const handle = await ctx.agents.create({ sessionId: SessionId('acquisition-main'), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })
  const parent = handle.agent
  const ordinary = await ctx.sessionController.resolveAgent(parent.id)
  expect('agent' in ordinary && ordinary.agent === parent).toBe(true)
  const start = (label: string, owner: Agent = parent) => ctx.subagents.startActivation({ provider: 'spawn', label,
    delivery: 'caller', request: { parent: owner, prompt, maxDepth: 3 }, signal })
  return { ctx, parent, start, disposeParent: handle.dispose, admission: ctx.get('subagentAdmissionPolicy') as Admission }
}

it('retains concurrent live acquisitions without messages and releases every group slot idempotently', async () => {
  const adapter = new MockAdapter([textResponse('initial'), textResponse('replacement')])
  const { ctx, parent, start, admission, disposeParent } = await boot(adapter)
  const first = await start('limited child')
  await first.result
  expect(ctx.agents.get(first.childId)).toBeUndefined()
  const before = await loadStoredSession(ctx.sessionPersistence, first.childId)
  const [left, right] = await Promise.all([
    ctx.subagents.acquireLive(undefined, first.childId, signal), ctx.subagents.acquireLive(parent, first.childId, signal),
  ])
  expect(left.agent).toBe(right.agent)
  expect(ctx.agents.get(first.childId)).toBe(left.agent)
  expect(left.agent.status).toBe('idle')
  expect(left.agent.session.snapshotEvents().filter(event => event.type === 'turn/start' || event.type === 'user/message'))
    .toEqual(before.events.filter(event => event.type === 'turn/start' || event.type === 'user/message'))
  expect(adapter.requests).toHaveLength(1)
  expect(admission.checks.some(check => check.childId === first.childId && check.resuming)).toBe(true)
  left.release()
  left.release()
  await right.agent.whenIdle()
  await expect(start('limited overflow')).rejects.toMatchObject({ code: 'ACTIVATION_GROUP_LIMIT_REACHED' })
  const foreign = await ctx.agents.create({ sessionId: SessionId('foreign') })
  await expect(ctx.subagents.acquireLive(foreign.agent, first.childId, signal)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(ctx.subagents.acquireLive({ ...parent, id: parent.id } as Agent, first.childId, signal)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  right.release()
  await vi.waitFor(() => expect(ctx.agents.get(first.childId)).toBeUndefined())
  const replacement = await start('limited replacement')
  await replacement.result
  await disposeParent()
  await expect(ctx.subagents.acquireLive(undefined, first.childId, signal)).rejects.toMatchObject({ code: 'ROOT_NOT_LIVE' })
})

it('retains and releases a cold real parent chain and contains denied or cancelled restoration', async () => {
  const adapter = new MockAdapter([textResponse('branch'), textResponse('leaf'), { hangAfter: [] }, textResponse('replacement')])
  const { ctx, parent, start, admission } = await boot(adapter)
  const branch = await start('branch')
  await branch.result
  const branchHold = await ctx.subagents.acquireLive(undefined, branch.childId, signal)
  const leaf = await start('limited leaf', branchHold.agent)
  await leaf.result
  branchHold.release()
  await vi.waitFor(() => expect(ctx.agents.get(branch.childId)).toBeUndefined())
  admission.denyResume = true
  await expect(ctx.subagents.acquireLive(undefined, leaf.childId, signal)).rejects.toMatchObject({ code: 'ADMISSION_DENIED' })
  expect(ctx.agents.get(branch.childId)).toBeUndefined()
  admission.denyResume = false
  await expect(ctx.subagents.acquireLive(undefined, leaf.childId, AbortSignal.abort())).rejects.toThrow()
  const occupant = await start('limited occupant')
  await vi.waitFor(() => expect(adapter.requests).toHaveLength(3))
  await expect(ctx.subagents.acquireLive(undefined, leaf.childId, signal)).rejects.toMatchObject({ code: 'ACTIVATION_GROUP_LIMIT_REACHED' })
  expect(ctx.agents.get(branch.childId)).toBeUndefined()
  expect(ctx.agents.get(occupant.childId)).toBeDefined()
  await occupant.dispose()
  const lease = await ctx.subagents.acquireLive(undefined, leaf.childId, signal)
  expect(lease.agent.session.header.parentSession).toBe(branch.childId)
  expect(ctx.agents.get(branch.childId)?.session.header.parentSession).toBe(parent.id)
  expect(lease.agent.status).toBe('idle')
  expect(adapter.requests).toHaveLength(3)
  lease.release()
  await vi.waitFor(() => {
    expect(ctx.agents.get(leaf.childId)).toBeUndefined()
    expect(ctx.agents.get(branch.childId)).toBeUndefined()
  })
  const replacement = await start('limited replacement')
  await replacement.result
})

it('resumes a timed-question owner without input, submits its late answer once and releases capacity', async () => {
  const callId = ToolCallId('timed-question')
  const adapter = new MockAdapter([
    toolCallResponse(callId, 'ask_user_question', { questions: [{ id: 'choice', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }], timeout: 1 }),
    textResponse('no answer yet'), textResponse('answer received'), textResponse('replacement'),
  ])
  const { ctx, start } = await boot(adapter)
  const manager = await start('limited manager')
  await manager.result
  expect(ctx.agents.get(manager.childId)).toBeUndefined()
  expect(adapter.requests).toHaveLength(2)
  const lease = await ctx.subagents.acquireLive(undefined, manager.childId, signal)
  expect(lease.agent.status).toBe('idle')
  expect(adapter.requests).toHaveLength(2)
  expect(lease.agent.inbox.nextStep).toHaveLength(0)
  expect(lease.agent.inbox.nextTurn).toHaveLength(0)
  const staged = await ctx.userQuestions.stageAnswer(lease.agent, callId, { id: 'choice', selected: ['A'] })
  const revision = staged.batch.revision
  const receipts = await Promise.all([
    ctx.userQuestions.submitBatch(lease.agent, callId, { expectedRevision: revision }),
    ctx.userQuestions.submitBatch(lease.agent, callId, { expectedRevision: revision }),
  ])
  expect(receipts.map(receipt => receipt.status)).toEqual(['submitted', 'already-submitted'])
  lease.release()
  await vi.waitFor(() => expect(ctx.agents.get(manager.childId)).toBeUndefined())
  expect(adapter.requests).toHaveLength(3)
  const stored = await loadStoredSession(ctx.sessionPersistence, manager.childId)
  const replies = stored.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user-question-reply')
  expect(replies).toHaveLength(1)
  expect(stored.events.filter(event => event.type === 'turn/start')).toHaveLength(2)
  expect(JSON.stringify(replies)).toContain('A')
  const replacement = await start('limited replacement')
  await replacement.result
})


it.each(['live', 'cold'])('routes a %s Manager card payload through real Typert without weakening ordinary lookup', async (mode) => {
  const callId = ToolCallId('session-addressed-question')
  const questions = [{ id: 'choice', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }]
  const adapter = new MockAdapter([
    toolCallResponse(callId, 'ask_user_question', { questions, timeout: mode === 'live' ? 60 : 1 }),
    textResponse('continued'), textResponse('late answer'), textResponse('worker'),
  ])
  const { ctx, parent, start } = await boot(adapter)
  const manager = await start('manager')
  if (mode === 'cold') await manager.result
  else await vi.waitFor(() => expect(ctx.userQuestions.query(ctx.agents.get(manager.childId)!.session)).toHaveLength(1))
  const invoke = (method: string, args: Record<string, unknown>) => ctx.typertGateway.invoke({
    namespace: 'userQuestions', method, args, peer: ownerPeer(ctx),
  }) as Promise<UserQuestionSubmission>
  const before = adapter.requests.length
  const claim = await ctx.typertGateway.stream({ namespace: 'userQuestions', method: 'attachSessionWait',
    args: { sessionId: manager.childId, callId }, peer: ownerPeer(ctx),
  })
  const iterator = claim[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(mode === 'cold')
  const current = ctx.agents.get(manager.childId)
  if (current !== undefined) await expect(ctx.typert.lookups.get('agent')!.resolve(manager.childId)).rejects.toMatchObject({ code: 'session/agent-busy' })
  expect(adapter.requests).toHaveLength(before)
  const batch = await invoke('stageSessionAnswer', { sessionId: manager.childId, callId,
    answer: { id: 'choice', selected: ['A'] }, expectedRevision: mode === 'live' ? 0 : 2 })
  expect(batch.status).toBe('submitted')
  const editingRevision = batch.batch.revision
  const updated = await invoke('stageSessionAnswer', { sessionId: manager.childId, callId,
    answer: { id: 'choice', selected: ['B'] }, expectedRevision: editingRevision })
  const stale = await invoke('submitSessionBatch', { sessionId: manager.childId, callId,
    submission: { answers: [{ id: 'choice', selected: ['A'] }], expectedRevision: editingRevision } })
  expect(stale.status).toBe('conflict')
  expect(stale.batch.answers).toEqual([{ id: 'choice', selected: ['B'] }])
  const accepted = await invoke('submitSessionBatch', { sessionId: manager.childId, callId,
    submission: { answers: [{ id: 'choice', selected: ['B'] }], expectedRevision: updated.batch.revision } })
  expect(accepted.status).toBe('submitted')
  if (mode === 'live') expect((await iterator.next()).done).toBe(true)
  await manager.result
  await vi.waitFor(() => expect(ctx.agents.get(manager.childId)).toBeUndefined())
  const stored = await loadStoredSession(ctx.sessionPersistence, manager.childId)
  expect(stored.events.filter(event => event.type === 'user-question/batch' && event.data.acceptedAt !== undefined)).toHaveLength(1)
  expect(parent.inbox.nextTurn).toHaveLength(0)
  expect(parent.inbox.nextStep).toHaveLength(0)

  // Root addressing still uses the ordinary lookup and never acquires a child.
  const rootCall = ToolCallId('main-session-question')
  parent.session.append('user-question/batch', { sessionId: parent.id, asker: parent.id, callId: rootCall,
    createdAt: 1, revision: 0, status: 'continued', questions, answers: [] })
  const acquire = vi.spyOn(ctx.subagents, 'acquireLive')
  expect((await invoke('stageSessionAnswer', { sessionId: parent.id, callId: rootCall,
    answer: { id: 'choice', selected: ['A'] }, expectedRevision: 0 })).status).toBe('submitted')
  expect(acquire).not.toHaveBeenCalled()
  const worker = await start('worker')
  await worker.result
  ;(ctx.get('humanInteractionPolicy') as InteractionAdmission).denied.add(worker.childId)
  await expect(invoke('stageSessionAnswer', { sessionId: worker.childId, callId,
    answer: { id: 'choice', selected: ['A'] }, expectedRevision: 0 })).rejects.toMatchObject({ code: 'INTERACTION_DENIED' })
  await vi.waitFor(() => expect(ctx.agents.get(worker.childId)).toBeUndefined())
})
