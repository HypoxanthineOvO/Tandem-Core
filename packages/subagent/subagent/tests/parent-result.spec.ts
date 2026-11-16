import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
/** Parent result delivery independent of a local child's messaging tool. */

import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Control from '@deepseek-ai/dsh-tool-subagent-control'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { mountLocalActivations } from './local-activation.ts'
import { SubagentRouteEquivalence, type SubagentModelRoute } from '../src/route-equivalence.ts'

class TestRouteEquivalence extends SubagentRouteEquivalence {
  isSameRoute(selected: SubagentModelRoute, actual: SubagentModelRoute): boolean {
    return selected.provider === actual.provider && selected.model === actual.model.replace(/^cpa[1-5]\//, '')
  }
}

it.each(['absent', 'unused'] as const)('returns the closing answer when send_message is %s', async (availability) => {
  const ctx = new Context()
  await mountLocalActivations(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  if (availability !== 'absent') await ctx.plugin(Control)
  const adapter = new MockAdapter([textResponse('CHILD_RESULT_42'), textResponse('Parent received the answer.')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  const activation = await ctx.subagents.startActivation({
    provider: 'spawn', label: 'Compute the answer', delivery: 'parent', signal: new AbortController().signal,
    request: {
      parent, prompt: [{ type: 'text', text: 'Find the answer.' }],
    },
  })
  try {
    await ctx.subagents.waitForChildren(parent)
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]!.tools?.some(tool => tool.name === 'send_message') ?? false).toBe(availability === 'unused')
    const notices = adapter.requests[1]!.messages.filter(message => message.role === 'user')
    expect(JSON.stringify(notices)).toContain('CHILD_RESULT_42')
    expect(JSON.stringify(notices)).toContain('Its closing message:')
  } finally {
    await activation.dispose()
  }
})

it('labels a different actual request route as fallback in the parent request', async () => {
  const ctx = new Context()
  await mountLocalActivations(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const adapter = new MockAdapter([textResponse('child result'), textResponse('received')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('fallback-parent'), { provider: 'mock', model: 'selected' })
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    return agent === parent ? config : { ...config, model: 'actual-fallback' }
  })
  const activation = await ctx.subagents.startActivation({
    provider: 'spawn', label: 'route proof', delivery: 'parent', signal: new AbortController().signal,
    request: { parent, prompt: [{ type: 'text', text: 'work' }] },
  })
  await activation.result
  await parent.whenIdle()
  expect(adapter.requests[0]?.model).toBe('actual-fallback')
  const notice = adapter.requests[1]!.messages.find(message => message.source?.kind === 'subagent-settled')
  expect(notice?.content.at(-1)).toEqual({ type: 'text', text: '实际模型：mock/actual-fallback（备用；选定模型：mock/selected）。' })
})

it.each([
  { service: true, selected: { provider: 'anthropic', model: 'claude-opus-5-5' }, actual: { provider: 'anthropic', model: 'cpa1/claude-opus-5-5' }, expected: '实际模型：anthropic/cpa1/claude-opus-5-5。' },
  { service: true, selected: { provider: 'openai-codex', model: 'gpt-6.1-sol' }, actual: { provider: 'example-provider', model: 'example-model' }, expected: '实际模型：example-provider/example-model（备用；选定模型：openai-codex/gpt-6.1-sol）。' },
  { service: false, selected: { provider: 'anthropic', model: 'claude-opus-5-5' }, actual: { provider: 'anthropic', model: 'cpa1/claude-opus-5-5' }, expected: '实际模型：anthropic/cpa1/claude-opus-5-5（备用；选定模型：anthropic/claude-opus-5-5）。' },
])('uses optional route equivalence for parent delivery: $service $actual.provider/$actual.model', async ({ service, selected, actual, expected }) => {
  const ctx = new Context()
  try {
    await mountLocalActivations(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    if (service) await ctx.plugin(TestRouteEquivalence)
    const adapter = new MockAdapter([textResponse('child result'), textResponse('received')])
    ctx.llm.registerAdapter(['anthropic', 'openai-codex', 'example-provider'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('equivalence-parent'), selected)
    ctx.on('agent/request', async ({ agent }, next) => {
      const config = await next()
      return agent === parent ? config : { ...config, ...actual }
    })
    const activation = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'route comparison', delivery: 'parent', signal: new AbortController().signal,
      request: { parent, prompt: [{ type: 'text', text: 'work' }] },
    })
    await activation.result
    await parent.whenIdle()
    expect(adapter.requests[0]?.model).toBe(actual.model)
    const notice = adapter.requests[1]!.messages.find(message => message.source?.kind === 'subagent-settled')
    expect(notice?.content.at(-1)).toEqual({ type: 'text', text: expected })
  } finally {
    await ctx.fiber.dispose()
  }
})

it('delivers structured output to the parent when the child has send_message', async () => {
  const ctx = new Context()
  await mountLocalActivations(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Control)
  const adapter = new MockAdapter([
    toolCallResponse('structured-answer', 'structured_output', { answer: 42 }),
    textResponse('Parent received the structured answer.'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  const activation = await ctx.subagents.startActivation({
    provider: 'spawn', label: 'Compute the answer', delivery: 'parent', signal: new AbortController().signal,
    request: {
      parent, prompt: [{ type: 'text', text: 'Find the answer.' }],
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    },
  })
  try {
    await activation.result
    await parent.whenIdle()
    expect(adapter.requests[0]!.tools?.some(tool => tool.name === 'send_message')).toBe(true)
    const notices = adapter.requests[1]!.messages.filter(message => message.role === 'user')
    expect(notices.flatMap(message => message.content)).toContainEqual({ type: 'text', text: 'Structured result: {"answer":42}' })
    expect(JSON.stringify(notices)).not.toContain('Its closing message:')
  } finally {
    await activation.dispose()
  }
})
