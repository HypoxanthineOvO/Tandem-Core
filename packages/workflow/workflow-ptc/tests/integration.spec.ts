import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../src/index.ts'
import SubagentDelegation, { SubagentModelSelectionConfig } from '@deepseek-ai/dsh-subagent-delegation'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import PtcWorkflowEngine from '../src/index.ts'
import { mountPtcRuntime } from './setup.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

async function setup(script: Script, config: Config = {}) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const { cwd } = await mountPtcRuntime(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentDelegation)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(PtcWorkflowEngine, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd })
  return { ctx, parent, adapter }
}

describe('dsh-workflow-ptc over the real in-process stack', () => {
  it('runs a two-stage workflow: a plain child, then a schema child through the structured runtime', async () => {
    const { ctx, parent } = await setup([
      textResponse('the file list is a.ts'),
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { verdict: 'real', confidence: 0.9 }),
    ])
    const childIds: string[] = []
    const parentFollowup = vi.spyOn(parent, 'followup')
    const parentSteer = vi.spyOn(parent, 'steer')
    const published = new Set<string>()
    ctx.on('subagent/start', (child) => { published.add(child.id) })
    ctx.on('workflow/agent-start', (_info, agent) => {
      expect(published.has(agent.childId)).toBe(true)
      childIds.push(agent.childId)
    })
    const run = ctx.workflowEngine.start({
      meta: { name: 'integration', description: 'plain + structured children' },
      script: `phase('Read')
const prose = await agent('read the repo')
phase('Judge')
const judged = await agent('judge: ' + prose, {
  schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['real', 'bogus'] }, confidence: { type: 'number' } }, required: ['verdict'] },
})
return { prose, verdict: judged.verdict, confidence: judged.confidence }`,
      parent,
    })
    const result = await run.result
    expect(result.stopReason, result.error?.split('\n')[0]).toBe('completed')
    expect(result.value).toEqual({ prose: 'the file list is a.ts', verdict: 'real', confidence: 0.9 })
    expect(result.agentsStarted).toBe(2)
    await run.dispose()
    expect(parentFollowup).not.toHaveBeenCalled()
    expect(parentSteer).not.toHaveBeenCalled()
    expect(parent.session.snapshotEvents()
      .filter(event => event.type === 'subagent/catalog')
      .map(event => ({ id: event.data.childId, mode: event.data.mode })))
      .toEqual(childIds.map(id => ({ id, mode: 'continuable' })))
    // Both children were disposed to quiescence — no live child agents remain.
    expect(childIds.length).toBe(2)
    for (const childId of childIds) {
      expect(ctx.agents.get(SessionId(childId))).toBeUndefined()
    }
  })

  it('a child that fails against its schema (nudges exhausted) reaches the script as null', async () => {
    const { ctx, parent } = await setup([
      textResponse('prose only'),
      textResponse('still prose after the nudge'),
    ])
    const run = ctx.workflowEngine.start({
      meta: { name: 'null-path', description: 'schema failure maps to null' },
      script: `const judged = await agent('judge it', { schema: { type: 'object', properties: { v: { type: 'string' } } } })
return { got: judged === null ? 'null' : 'value' }`,
      parent,
    })
    const result = await run.result
    expect(result.stopReason, result.error?.split('\n')[0]).toBe('completed')
    expect(result.value).toEqual({ got: 'null' })
    await run.dispose()
  })

  it('pairs published children with workflow progress after a progress burst', async () => {
    const { ctx, parent } = await setup([textResponse('child complete')])
    const logs: string[] = []
    const published = new Set<string>()
    const starts: string[] = []
    ctx.on('subagent/start', (child) => { published.add(child.id) })
    ctx.on('workflow/log', (_info, message) => { logs.push(message) })
    ctx.on('workflow/agent-start', (_info, child) => {
      expect(published.has(child.childId)).toBe(true)
      starts.push(child.childId)
    })
    const run = ctx.workflowEngine.start({
      meta: { name: 'progress-burst', description: 'ordered progress and child visibility' },
      script: 'for (let index = 0; index < 200; index++) log(String(index)); return await agent("finish")',
      parent,
    })
    try {
      await expect(run.result).resolves.toMatchObject({ value: 'child complete', stopReason: 'completed', agentsStarted: 1 })
      expect(logs).toEqual(Array.from({ length: 200 }, (_, index) => String(index)))
      expect(starts).toHaveLength(1)
      expect(ctx.agents.get(SessionId(starts[0]!))).toBeUndefined()
    } finally {
      await run.dispose()
    }
  })
})


describe('workflow shared delegation permissions', () => {
  it.each(['off', 'legacy', 'missing-service'])('denies explicit routes for %s while retaining pure inheritance', async (mode) => {
    const { ctx, parent, adapter } = await setup([textResponse('inherited')])
    if (mode !== 'missing-service') await ctx.plugin(SubagentModelSelectionConfig, {
      enabled: mode === 'legacy', allowedModels: [{ provider: 'mock', model: 'mock' }],
    })
    if (mode === 'legacy') parent.session.append('session/end-seed', {})
    const start = vi.spyOn(ctx.subagents, 'startActivation')
    const run = ctx.workflowEngine.start({
      meta: { name: 'selection-denial', description: 'no implicit model selection authority' },
      script: "let denied; try { await agent('forbidden', { provider: 'mock', model: 'mock' }) } catch (e) { denied = e.message }; return { denied, inherited: await agent('inherit') }", parent,
    })
    try {
      const result = await run.result
      expect(result.value).toEqual({ denied: expect.stringContaining('model selection is disabled'), inherited: 'inherited' })
      expect(start).toHaveBeenCalledTimes(1)
      expect(adapter.requests).toHaveLength(1)
    } finally { await run.dispose() }
  })

  it('rejects excessive depth before starting a workflow child', async () => {
    const { ctx, parent, adapter } = await setup([], { maxDepth: 0 })
    const start = vi.spyOn(ctx.subagents, 'startActivation')
    const run = ctx.workflowEngine.start({
      meta: { name: 'depth-denial', description: 'shared child depth' },
      script: "try { await agent('must not start') } catch (e) { return e.message }", parent,
    })
    try {
      expect((await run.result).value).toContain('exceeds maxDepth 0')
      expect(start).not.toHaveBeenCalled()
      expect(adapter.requests).toEqual([])
    } finally { await run.dispose() }
  })

  it('rejects an explicit route outside the same durable Session model pool', async () => {
    const { ctx, parent, adapter } = await setup([])
    await ctx.plugin(SubagentModelSelectionConfig, { enabled: false })
    parent.session.append('subagent/model-selection-policy', { allowedModels: [{ provider: 'mock', model: 'allowed' }] })
    const start = vi.spyOn(ctx.subagents, 'startActivation')
    const run = ctx.workflowEngine.start({
      meta: { name: 'pool-denial', description: 'shared exact model pool' },
      script: "try { await agent('must not start', { provider: 'mock', model: 'forbidden' }) } catch (e) { return e.message }", parent,
    })
    try {
      expect((await run.result).value).toContain('not allowed for this Session')
      expect(start).not.toHaveBeenCalled()
      expect(adapter.requests).toEqual([])
    } finally { await run.dispose() }
  })

  it('uses a deployment-selected child preset instead of parent-local write tools', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('readonly answer')], { agentPreset: 'subagent-readonly' })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(AgentPresets, { default: 'subagent-readonly' })
    await ctx.agentPresets.register({ id: 'subagent-readonly', plugins: [] })
    parent.ctx.effect(() => parent.ctx.tools.register(defineTool({
      name: 'write', description: 'parent-only write', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('write'),
    })))
    expect(ctx.tools.schemas(parent).map(tool => tool.name)).toContain('write')
    const start = vi.spyOn(ctx.subagents, 'startActivation')
    const run = ctx.workflowEngine.start({
      meta: { name: 'preset-selection', description: 'fixed workflow child preset' },
      script: "return await agent('review without write access')", parent,
    })
    try {
      expect((await run.result).value).toBe('readonly answer')
      expect(start.mock.calls[0]?.[0].request.agentPreset).toBe('subagent-readonly')
      expect(start.mock.calls[0]?.[0].source).toBe('workflow')
      expect(adapter.requests[0]?.tools?.map(tool => tool.name) ?? []).not.toContain('write')
    } finally { await run.dispose() }
  })
})
