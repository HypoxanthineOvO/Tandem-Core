/** Loader-composed conversational modes, direct human continuation, and source-level return policy. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Control from '@deepseek-ai/dsh-tool-subagent-control'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, expect, it, vi } from 'vitest'
import Mode from '../../../api/session-controller/src/mode.ts'
import { ApiSessionAgentController } from '../../../api/session-controller/src/agent.ts'
import { installModelSelectionProjection } from '../../../api/session-controller/src/model-selection-projection.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Subagents from '../src/index.ts'
import type { SubagentPromptRequestId } from '../src/control-types.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function boot(adapter: MockAdapter, limits: { valueChars: number; maxChars: number } = { valueChars: 512, maxChars: 8192 }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mode-continuity-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(TypertRegistry)
  installModelSelectionProjection(ctx)
  const resolver = new ApiSessionAgentController(ctx)
  ctx.provide('sessionController', { resolveAgent: (id: SessionId) => resolver.resolveAgent(id) } as never)
  ctx.llm.registerAdapter(['mock'], adapter)
  const config = join(root, 'cordis.yml')
  await writeFile(config, `- name: cordis:defaultModel
  config: { provider: mock, model: mock }
- name: cordis:subagents
  config: { continuityAutoBind: true, maxDepth: 2, continuityNotificationValueChars: ${limits.valueChars}, continuityNotificationMaxChars: ${limits.maxChars} }
- name: cordis:spawn
- name: cordis:control
- name: cordis:mode
`)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, defaultModel: AgentDefaultModel, subagents: Subagents, spawn: Spawn, control: Control, mode: Mode })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const handle = await ctx.agents.create({ sessionId: SessionId('mode-parent'), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })
  return { ctx, parent: handle.agent, disposeParent: handle.dispose }
}

it.each(['切到直接模式', 'ordinary direct question'])('keeps the human child turn local after main UI selection: %s', async (prompt) => {
  const adapter = new MockAdapter([
    textResponse('delegated answer'),
    toolCallResponse('private-return', 'send_message', { agent_id: 'mode-parent', message: 'private branch body' }),
    textResponse('local human answer'),
  ])
  const { ctx, parent } = await boot(adapter)
  const initial = await ctx.subagents.startActivation({ provider: 'spawn', label: 'child', delivery: 'caller',
    request: { parent, prompt: [{ type: 'text', text: 'initial delegated task' }] }, signal: new AbortController().signal })
  await initial.result
  await vi.waitFor(() => expect(ctx.agents.get(initial.childId)).toBeUndefined())
  await ctx.sessionMode.set({ sessionId: parent.id, mode: 'direct' })
  // Another host plugin appends request context before the admitted inbox message; it must not claim turn origin.
  let appended = false
  ctx.on('agent/request', async ({ agent }, next) => {
    const result = await next()
    if (agent.id === initial.childId && !appended) {
      appended = true
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '[host request context]' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    }
    return result
  })
  const followup = vi.spyOn(parent, 'followup')
  const steer = vi.spyOn(parent, 'steer')
  await ctx.subagents.prompt({ requestId: 'direct-question' as SubagentPromptRequestId, parentSessionId: parent.id,
    childSessionId: initial.childId, mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: prompt }] }, new AbortController().signal)
  await vi.waitFor(() => expect(ctx.agents.get(initial.childId)).toBeUndefined())
  expect(ctx.subagents.continuity.status(initial.childId)).toMatchObject({ enabled: true, branchSessionId: initial.childId, mainSessionId: parent.id })
  expect(followup).not.toHaveBeenCalled()
  expect(steer).not.toHaveBeenCalled()
  expect(adapter.requests.filter(request => request.sessionId === parent.id)).toHaveLength(0)
  const childRequests = adapter.requests.filter(request => request.sessionId === initial.childId)
  expect(childRequests).toHaveLength(3)
  const observation = await ctx.sessionQuery.observeSession(initial.childId)
  using retained = observation
  expect(retained.events.some(event => event.type === 'session-mode/selected')).toBe(false)
  expect(retained.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user'
    && event.data.content.some(block => block.type === 'text' && block.text === prompt))).toBe(true)
  const rejected = retained.events.flatMap(event => event.type === 'tool/result' ? [{ isError: event.data.message.isError, content: event.data.message.content }] : [])
  expect(rejected).toHaveLength(1)
  expect(rejected[0]?.isError).toBe(true)
  expect(JSON.stringify(rejected[0]?.content)).toContain('free-text parent delivery is disabled')
  expect(rejected).toMatchSnapshot('parent send rejection')
  expect(childRequests[1]!.messages.filter(message => message.role === 'user').map(message => message.content)
    .filter(content => !content.some(block => block.type === 'text' && block.text.includes('initial delegated task')))).toMatchSnapshot('human request context')
  expect(parent.inbox.nextTurn.some(message => message.source.kind === 'subagent-settled')).toBe(false)
})

it('appends confirmed field values and redacted branch details to a main request without changing its system or tools', async () => {
  const adapter = new MockAdapter([textResponse('main ready'), textResponse('delegated result'), textResponse('branch local'), textResponse('main absorbed')])
  const { ctx, parent } = await boot(adapter, { valueChars: 64, maxChars: 8192 })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'main task' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  const child = await ctx.subagents.startActivation({ provider: 'spawn', childId: SessionId('pending-branch'), label: 'pending source', delivery: 'caller',
    request: { parent, prompt: [{ type: 'text', text: 'delegated work' }] }, signal: new AbortController().signal })
  await child.result
  await ctx.subagents.prompt({ requestId: 'confirm-field-values' as SubagentPromptRequestId, parentSessionId: parent.id,
    childSessionId: child.childId, mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: 'confirm branch decision' }] }, new AbortController().signal)
  await vi.waitFor(() => expect(ctx.agents.get(child.childId)).toBeUndefined())
  ctx.subagents.continuity.read(['acceptance.alpha'])
  const result = await ctx.subagents.continuity.commit({ eventId: 'confirmed-values', baseRev: 0,
    actor: { kind: 'user', id: 'user-confirmation' }, source: { sessionId: child.childId, turnId: 'confirmed' },
    patch: [{ key: 'acceptance.alpha', before: null, after: '通过A' },
      { key: 'acceptance.metadata', before: null, after: { api_key: 'secret-native-value', status: '已核对' } },
      { key: 'acceptance.long', before: null, after: '说明'.repeat(100) }], reason: '用户确认字段，并同意带回主线' })
  expect(result.state).toBe('wake-queued')
  await parent.whenIdle()
  const requests = adapter.requests.filter(request => request.sessionId === parent.id)
  expect(requests).toHaveLength(2)
  const received = requests[1]!.messages.filter(message => message.role === 'user' && message.source?.kind === 'continuity-delivery').map(message => message.content)
  expect(received).toMatchSnapshot('confirmed decision details')
  expect(JSON.stringify(received)).not.toContain('secret-native-value')
  expect(JSON.stringify(received)).toContain('通过A')
  expect(JSON.stringify(received)).toContain('已截断')
  expect(JSON.stringify(requests[1]!.messages.filter(message => message.role === 'system'))).toBe(JSON.stringify(requests[0]!.messages.filter(message => message.role === 'system')))
  expect(JSON.stringify(requests[1]!.tools)).toBe(JSON.stringify(requests[0]!.tools))
  const delivery = parent.session.snapshotEvents().find(event => event.type === 'continuity/delivery')
  expect(delivery?.type === 'continuity/delivery' ? delivery.data.text : undefined).toBe(received[0]?.[0]?.type === 'text' ? received[0][0].text : '')
});

it('rejects the mode control on a live subagent without altering its running turn', async () => {
  const adapter = new MockAdapter([{ hangAfter: [] }])
  const { ctx, parent } = await boot(adapter)
  const running = await ctx.subagents.startActivation({ provider: 'spawn', label: 'live child', delivery: 'caller',
    request: { parent, prompt: [{ type: 'text', text: 'delegated running task' }] }, signal: new AbortController().signal })
  await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
  const child = ctx.agents.get(running.childId)!
  await expect(ctx.sessionMode.set({ sessionId: child.id, mode: 'direct' })).rejects.toMatchObject({ message: '模式开关仅用于主线会话。子代理不切换模式，请直接发送任务或问题。' })
  expect(child.status).toBe('running')
  expect(child.session.snapshotEvents().some(event => event.type === 'session-mode/selected')).toBe(false)
  expect(await ctx.sessionMode.get({ sessionId: child.id })).toEqual({ mode: 'work' })
  ctx.subagents.interruptByParent(child.id, parent.id, 'continuable')
  await running.result
});

it('rejects mode changes for cold children and resumes a cold ordinary main without running it', async () => {
  const adapter = new MockAdapter([textResponse('delegated answer')])
  const { ctx, parent, disposeParent } = await boot(adapter)
  const initial = await ctx.subagents.startActivation({ provider: 'spawn', label: 'child', delivery: 'caller',
    request: { parent, prompt: [{ type: 'text', text: 'initial delegated task' }] }, signal: new AbortController().signal })
  await initial.result
  await vi.waitFor(() => expect(ctx.agents.get(initial.childId)).toBeUndefined())
  await expect(ctx.sessionMode.set({ sessionId: initial.childId, mode: 'direct' })).rejects.toMatchObject({ message: '模式开关仅用于主线会话。子代理不切换模式，请直接发送任务或问题。' })
  expect(ctx.agents.get(initial.childId)).toBeUndefined()
  expect(await ctx.sessionMode.get({ sessionId: initial.childId })).toEqual({ mode: 'work' })
  await disposeParent()
  expect(ctx.agents.get(parent.id)).toBeUndefined()
  expect(await ctx.sessionMode.set({ sessionId: parent.id, mode: 'direct' })).toEqual({ mode: 'direct' })
  expect(ctx.agents.get(parent.id)?.status).toBe('idle')
  expect(adapter.requests.filter(request => request.sessionId === parent.id)).toHaveLength(0)
})
