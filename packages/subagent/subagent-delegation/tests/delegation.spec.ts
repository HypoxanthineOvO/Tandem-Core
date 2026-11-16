/** Keyless Loader composition: native fork history must not transfer writable permissions. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as AgentPreset from '@deepseek-ai/dsh-agent-preset'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentDelegation, { SubagentModelSelectionConfig } from '../src/index.ts'
import type { DelegationRequest } from '../src/index.ts'

const signal = new AbortController().signal

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Test-only caller identity record. */
    'delegation-test/identity': { label: string }
  }
}

const testTools = {
  name: 'test-tools',
  inject: ['tools', 'systemPrompt'],
  apply(ctx: Context, config: { names: string[]; prompt: string }): void {
    for (const name of config.names) ctx.effect(() => ctx.tools.register(defineTool({
      name, description: `fixture ${name}`, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve(name),
    })))
    ctx.systemPrompt.section({ name: 'persona', order: 1, text: config.prompt })
  },
}

async function setup() {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'dsh-delegation-'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  ctx.baseUrl = new URL('./fixtures/', import.meta.url).href
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, presets: AgentPresets, preset: AgentPreset,
    subagents: SubagentRuntime, delegation: SubagentDelegation, fork: Fork, testTools,
    testRuntime: {
      name: 'test-runtime',
      async apply(runtimeCtx: Context) {
        await mountAgentLoopTestDependencies(runtimeCtx, { workingDirectory: true })
        await runtimeCtx.plugin(AgentLoop, { agents: [] })
      },
    },
  })
  await ctx.loader.root.update([{
    id: 'composition', name: 'cordis:include',
    config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href },
  }])
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  await ctx.plugin(Jsonl, { root: join(root, 'sessions') })
  const adapter = new MockAdapter([textResponse('completed parent'), textResponse('completed child')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = (await ctx.agents.create({
    sessionId: SessionId('delegation-parent'), agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'writable') },
  })).agent
  return { ctx, parent, adapter }
}

function request(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return { label: 'review', prompt: 'Review completed work', delivery: 'caller', ...overrides }
}

describe('shared delegation service', () => {
  it('forks completed history with the selected readonly preset and logs the new request declarations', async () => {
    const { ctx, parent, adapter } = await setup()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent task' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['bash', 'edit', 'read', 'write'])
    expect(ctx.tools.schemas(parent).map(tool => tool.name)).not.toContain('subagent')
    const policy = ctx.subagentDelegation.register({ provider: 'fork', allowedAgentPresets: ['subagent-readonly'], maxDepth: 2 }, ctx)
    const spec = await ctx.subagentDelegation.resolve(parent, request({ agentPreset: 'subagent-readonly', inheritContext: true }), policy, signal)
    let child: Agent | undefined
    const activation = await ctx.subagentDelegation.start(spec, signal, { beforeChildStart: agent => { child = agent } })
    await activation.result
    expect(adapter.requests.at(-1)?.tools?.map(tool => tool.name)).toEqual(['read'])
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain('Readonly child persona')
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).not.toContain('Writable parent persona')
    expect(child?.session.header.agentPreset).toBe('subagent-readonly')
    expect(child?.session.inheritedEventCount).toBeGreaterThan(0)
    const ownEvents = child!.session.snapshotEvents().slice(child!.session.inheritedEventCount)
    expect(ownEvents.some(event => event.type === 'agent-preset/selected' && event.data.agentPreset === 'subagent-readonly')).toBe(true)
    expect(ownEvents.some(event => event.type === 'system/message' && JSON.stringify(event.data).includes('Readonly child persona'))).toBe(true)
    await activation.dispose()
  })

  it('awaits reserved identity persistence before the first child model request and releases temporary state', async () => {
    const { ctx, parent, adapter } = await setup()
    const policy = ctx.subagentDelegation.register({ provider: 'fork', maxDepth: 2 }, ctx)
    const spec = await ctx.subagentDelegation.resolve(parent, request(), policy, signal)
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const released = vi.fn()
    let reserved: SessionId | undefined
    const starting = ctx.subagentDelegation.start(spec, signal, {
      onChildReserved: id => { reserved = id; return released },
      beforeChildStart: async (child) => {
        expect(child.id).toBe(reserved)
        child.session.append('delegation-test/identity', { label: 'reviewer' })
        expect(await ctx.sessions.flush(child.session)).toBe(true)
        entered.resolve()
        await resume.promise
      },
    })
    try {
      await entered.promise
      expect(adapter.requests).toEqual([])
    } finally { resume.resolve() }
    const activation = await starting
    await activation.result
    expect(adapter.requests).toHaveLength(1)
    expect(released).toHaveBeenCalledOnce()
    await activation.dispose()
  })

  it.each(['cancel', 'throw'] as const)('releases reservations on %s and permits a fresh spec under the same child id', async (failure) => {
    const { ctx, parent } = await setup()
    const policy = ctx.subagentDelegation.register({ provider: 'fork', maxDepth: 2 }, ctx)
    const controller = new AbortController()
    const id = SessionId(`reserved-${failure}`)
    const spec = await ctx.subagentDelegation.resolve(parent, request({ childId: id }), policy, signal)
    const released = vi.fn()
    await expect(ctx.subagentDelegation.start(spec, controller.signal, {
      onChildReserved: () => {
        if (failure === 'throw') throw new Error('identity failed')
        controller.abort(new Error('cancelled identity'))
        return released
      },
    })).rejects.toThrow(failure === 'throw' ? 'identity failed' : 'cancelled identity')
    expect(ctx.agents.get(id)).toBeUndefined()
    if (failure === 'cancel') expect(released).toHaveBeenCalledOnce()
    const retry = await ctx.subagentDelegation.resolve(parent, request({ childId: id }), policy, signal)
    const activation = await ctx.subagentDelegation.start(retry, signal)
    await activation.result
    await activation.dispose()
  })

  it('rejects unknown policies/specs, unlisted presets, unauthorized routes and excessive depth before reservation', async () => {
    const { ctx, parent } = await setup()
    const policy = ctx.subagentDelegation.register({ provider: 'fork', maxDepth: 0, allowedAgentPresets: ['subagent-readonly'], modelSelectionEnabled: true }, ctx)
    await expect(ctx.subagentDelegation.resolve(parent, request(), { token: Symbol() }, signal)).rejects.toMatchObject({ code: 'UNREGISTERED_POLICY' })
    await expect(ctx.subagentDelegation.start({ provider: 'fork' }, signal)).rejects.toMatchObject({ code: 'INVALID_SPEC' })
    await expect(ctx.subagentDelegation.resolve(parent, request({ agentPreset: 'writable' }), policy, signal)).rejects.toThrow('must be one of')
    await expect(ctx.subagentDelegation.resolve(parent, request(), policy, signal)).rejects.toThrow('exceeds maxDepth 0')
    parent.session.append('subagent/model-selection-policy', { allowedModels: [{ provider: 'mock', model: 'allowed' }] })
    await expect(ctx.subagentDelegation.resolve(parent, request({ provider: 'mock', model: 'forbidden' }), policy, signal)).rejects.toThrow('not allowed for this Session')
    expect(ctx.agents.list()).toEqual([parent])
  })

  it('revokes disposed registrations and consumes a resolved spec exactly once', async () => {
    const { ctx, parent } = await setup()
    const owner = ctx.plugin(function deploymentOwner() {})
    const policy = ctx.subagentDelegation.register({ provider: 'fork', maxDepth: 2 }, owner.ctx)
    const spec = await ctx.subagentDelegation.resolve(parent, request(), policy, signal)
    await owner.dispose()
    await expect(ctx.subagentDelegation.resolve(parent, request(), policy, signal)).rejects.toMatchObject({ code: 'UNREGISTERED_POLICY' })
    await expect(ctx.subagentDelegation.start(spec, signal)).rejects.toMatchObject({ code: 'UNREGISTERED_POLICY' })
    await expect(ctx.subagentDelegation.start(spec, signal)).rejects.toMatchObject({ code: 'INVALID_SPEC' })
  })
})


it('captures a fresh Session model pool without a model-facing delegation tool', async () => {
  const { ctx } = await setup()
  await ctx.plugin(SubagentModelSelectionConfig, {
    enabled: true, allowedModels: [{ provider: 'mock', model: 'allowed' }],
  })
  const policy = ctx.subagentDelegation.register({ provider: 'fork', modelSelectionSettings: true, maxDepth: 2 }, ctx)
  const parent = (await ctx.agents.create({
    sessionId: SessionId('no-delegation-tools'), agentOptions: { provider: 'mock', model: 'mock' },
  })).agent
  expect(parent.session.snapshotEvents().some(event => event.type === 'subagent/model-selection-policy')).toBe(true)
  expect(ctx.tools.schemas(parent).map(tool => tool.name)).not.toContain('subagent')
  await expect(ctx.subagentDelegation.resolve(parent, request({ provider: 'mock', model: 'forbidden' }), policy, signal))
    .rejects.toThrow('not allowed for this Session')
})


it('stops an accepted activation when caller identity cleanup fails instead of losing its handle', async () => {
  const { ctx, parent } = await setup()
  const policy = ctx.subagentDelegation.register({ provider: 'fork', maxDepth: 2 }, ctx)
  const childId = SessionId('cleanup-failure-child')
  const spec = await ctx.subagentDelegation.resolve(parent, request({ childId }), policy, signal)
  await expect(ctx.subagentDelegation.start(spec, signal, {
    onChildReserved: () => () => { throw new Error('caller cleanup failed') },
  })).rejects.toThrow('identity cleanup failed')
  expect(ctx.agents.get(childId)).toBeUndefined()
})
