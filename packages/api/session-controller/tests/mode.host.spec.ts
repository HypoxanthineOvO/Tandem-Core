/** Mode changes through the real Loader, Agent loop, durable events, and request history. */
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Mode from '../src/mode.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('persists mode, appends notifications once, and preserves system and tool bytes', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const root = await mkdtemp(join(tmpdir(), 'dsh-mode-loader-'))
  roots.push(root)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(TestSessionQuery)
  // This test only addresses live Agents; cold activation remains the Session Controller's operation.
  ctx.provide('sessionController', { resolveAgent() { throw new Error('unexpected cold activation') } } as never)
  ctx.provide('typert', {} as never)
  const flush = vi.spyOn(ctx.sessions, 'flush')
  const config = join(root, 'cordis.yml')
  await writeFile(config, '- name: cordis:mode\n')
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.mode = Mode
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect(ctx.get('sessionMode')).toBeDefined()
  const adapter = new MockAdapter(Array.from({ length: 7 }, () => textResponse('done')))
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('mode-session'), { provider: 'mock', model: 'mock' })
  const send = async (text = 'continue') => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  expect(await ctx.sessionMode.get({ sessionId: agent.id })).toEqual({ mode: 'work' })
  await send()
  expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'session-mode')).toBe(false)
  const eventsBefore = agent.session.seq
  await ctx.sessionMode.set({ sessionId: agent.id, mode: 'direct' })
  expect(agent.status).toBe('idle')
  expect(adapter.requests).toHaveLength(1)
  expect(agent.session.seq).toBe(eventsBefore + 1)
  await send()
  await ctx.sessionMode.set({ sessionId: agent.id, mode: 'direct' })
  await send()
  await ctx.sessionMode.set({ sessionId: agent.id, mode: 'work' })
  await send()
  const notices = agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'session-mode'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
  expect(notices).toMatchInlineSnapshot(`
    [
      "[模式：直接模式。从这里起由你自己完成任务。]",
      "[模式：工作模式。从这里起由你负责理解需求、拆分任务、调度子代理并汇总核对结果。]",
    ]
  `)
  expect(adapter.requests.map(request => JSON.stringify(request.tools))).toEqual(Array(4).fill(JSON.stringify(adapter.requests[0]!.tools)))
  const systems = adapter.requests.map(request => JSON.stringify(request.messages.filter(message => message.role === 'system')))
  expect(new Set(systems).size).toBe(1)
  const restored = Session.create(SessionId('restored'), agent.session.snapshotEvents())
  expect(ctx.sessionProjections.stateOf(restored, 'sessionMode')?.mode).toBe('work')
  expect(flush).toHaveBeenCalled()
  await send('切到直接模式！')
  expect(await ctx.sessionMode.get({ sessionId: agent.id })).toEqual({ mode: 'direct' })
  await send('切到工作模式，然后继续')
  expect(await ctx.sessionMode.get({ sessionId: agent.id })).toEqual({ mode: 'direct' })
  await send('  切到工作模式.  ')
  expect(await ctx.sessionMode.get({ sessionId: agent.id })).toEqual({ mode: 'work' })
  expect(agent.session.deriveMessages().some(message => message.role === 'user' && message.source.kind === 'user'
    && message.content.some(block => block.type === 'text' && block.text === '切到直接模式！'))).toBe(true)
  // HMR disposal removes behavior and the registered projection together.
  const entry = [...ctx.loader.entries()].find(item => item.options.name === 'cordis:mode')!
  await entry.fiber!.dispose()
  expect(ctx.sessionProjections.snapshot(agent.session).values.sessionMode).toBeUndefined()
})

it.each(['standard-native', 'standard', 'eval-clean'])('announces the configured native default once without changing system/tools: %s', async (preset) => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  ctx.provide('sessionController', { resolveAgent() { throw new Error('unexpected cold activation') } } as never)
  ctx.provide('typert', {} as never)
  const { agentPresetProjectionDefinition } = await import('@deepseek-ai/dsh-agent-preset-registry')
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-mode-'))
  roots.push(root)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, '- name: cordis:mode\n  config:\n    initialNotificationPresets: [standard-native]\n')
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.mode = Mode
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const adapter = new MockAdapter(Array.from({ length: 3 }, () => textResponse('done')))
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`initial-${preset}`), { provider: 'mock', model: 'mock' })
  agent.session.append('agent-preset/selected', { agentPreset: preset })
  for (const text of ['first question', 'second question']) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  const notices = agent.session.deriveMessages().filter(message => message.role === 'user' && message.source.kind === 'session-mode')
  expect(notices).toHaveLength(preset === 'standard-native' ? 1 : 0)
  if (preset === 'standard-native') {
    expect(JSON.stringify(notices)).toContain('工作模式')
    expect(JSON.stringify(notices)).not.toContain('Hypo')
    expect(adapter.requests[0]!.messages.some(message => message.role === 'user' && JSON.stringify(message).includes('工作模式'))).toBe(true)
    const restored = Session.create(SessionId('native-restored'), agent.session.snapshotEvents())
    expect(ctx.sessionProjections.stateOf(restored, 'sessionMode')!.selectionSeq).toBeGreaterThan(-1)
    await ctx.sessionMode.set({ sessionId: agent.id, mode: 'direct' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'after switch' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(await ctx.sessions.flush(agent.session)).toBe(true)
    const allNotices = agent.session.deriveMessages().filter(message => message.role === 'user' && message.source.kind === 'session-mode')
    expect(allNotices).toHaveLength(2)
    expect(JSON.stringify(allNotices[1])).toContain('直接模式')
    const file = (await readdir(join(root, 'sessions'), { recursive: true })).find(name => name.endsWith('.jsonl'))
    expect(file).toBeDefined()
    expect(await readFile(join(root, 'sessions', file!), 'utf8')).toContain('session-mode/selected')
  }
  expect(new Set(adapter.requests.map(request => JSON.stringify(request.messages.filter(message => message.role === 'system')))).size).toBe(1)
  expect(new Set(adapter.requests.map(request => JSON.stringify(request.tools))).size).toBe(1)
})
