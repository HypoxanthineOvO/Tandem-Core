/** Durable conversational mode, append-only model notifications, and its Remote owner. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { SessionMode, SessionModeState } from './types.ts'
import { hasApiSessionSubagentOwner } from './agent.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { sessionMode: SessionModeService }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-mode': { readonly kind: 'session-mode'; readonly mode: SessionMode; readonly selectionSeq: number }
  }
}

const modeSchema = z.enum(['direct', 'work'])
const modeViewSchema = z.object({ mode: modeSchema })
const modeStateSchema = z.object({ mode: modeSchema, selectionSeq: z.number().int() })

/** Mode projection shared by live control, cold reads, and notification admission. */
export const sessionModeProjection = {
  key: 'sessionMode',
  stateVersion: 1,
  stateSchema: modeStateSchema,
  init: () => ({ mode: 'work', selectionSeq: -1 }),
  apply: (state, event) => event.type === 'session-mode/selected'
    ? { mode: event.data.mode, selectionSeq: event.seq }
    : state,
  wire: { viewSchema: modeViewSchema, view: state => ({ mode: state.mode }) },
} satisfies ProjectionDefinition<'sessionMode', SessionModeState>

/** Presets whose persona does not already declare the default conversational policy. */
export interface SessionModeConfig { initialNotificationPresets?: string[] }

/** Conversational policy owner; never changes persona, preset, system sections, or tools. */
export class SessionModeService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionController', 'sessionQuery', 'sessionProjections', 'typert']
  static Config = schema.object({ initialNotificationPresets: schema.array(schema.string().min(1)).default([]) })

  /** @param ctx - Session and Agent services owning the addressed conversations. */
  constructor(ctx: Context, config: SessionModeConfig = {}) {
    super(ctx, 'sessionMode', { namespace: 'sessionMode' })
    ctx.sessionProjections.register(sessionModeProjection)
    ctx.on('agent/pre-step', async ({ agent, step, messages, signal }, next) => {
      const decision = await next()
      if (decision.kind !== 'enter' || signal.aborted || hasApiSessionSubagentOwner(ctx, agent.session, agent)) return decision
      if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision
      for (const message of decision.messages) {
        if (message.source.kind !== 'user' || !message.content.every(block => block.type === 'text')) continue
        const text = message.content.map(block => block.type === 'text' ? block.text : '').join('\n').trim()
        const command = /^切到(直接|工作)模式[。！.!]?$/.exec(text)
        if (command !== null) this.select(agent.session, command[1] === '直接' ? 'direct' : 'work')
      }
      let state = ctx.sessionProjections.stateOf(agent.session, 'sessionMode')
      if (state === undefined) throw new Error('缺少会话模式投影。')
      if (state.selectionSeq < 0) {
        const preset = ctx.sessionProjections.stateOf(agent.session, 'agentPreset') ?? agent.session.header.agentPreset
        if (preset === undefined || preset === null || !config.initialNotificationPresets?.includes(preset)) return decision
        agent.session.append('session-mode/selected', { mode: state.mode })
        state = ctx.sessionProjections.stateOf(agent.session, 'sessionMode')!
      }
      const retained = agent.session.deriveMessages().some(message => message.role === 'user'
        && message.source.kind === 'session-mode' && message.source.selectionSeq === state.selectionSeq)
      const queued = decision.messages.some(message => message.source.kind === 'session-mode'
        && message.source.selectionSeq === state.selectionSeq)
      if (retained || queued) return decision
      return { ...decision, messages: [createUserMessage({
        content: [{ type: 'text', text: state.mode === 'direct'
          ? '[模式：直接模式。从这里起由你自己完成任务。]'
          : '[模式：工作模式。从这里起由你负责理解需求、拆分任务、调度子代理并汇总核对结果。]' }],
        source: { kind: 'session-mode', mode: state.mode, selectionSeq: state.selectionSeq },
      }), ...decision.messages] }
    })
  }

  /**
   * Read current conversational mode without activating a cold Agent.
   * @param request - Session identity whose projection supplies the mode.
   * @returns the durable ordinary-session mode, or work for a subagent.
   */
  @Remote
  async get(request: { sessionId: SessionId }): Promise<{ mode: SessionMode }> {
    using observation = await this.ctx.sessionQuery.observeSession(request.sessionId)
    if (hasApiSessionSubagentOwner(this.ctx, observation, this.ctx.agents.get(request.sessionId))) return { mode: 'work' }
    const value = observation.projections?.values.sessionMode
    if (value === undefined) throw new RemoteError('gateway/internal', '缺少会话模式投影。', {})
    return value
  }

  /**
   * Persist an ordinary main-line mode without waking the Agent; reject subagent targets.
   * The notification enters the next admitted request.
   * @param request - Session identity and new conversational policy.
   * @returns current durable mode after persistence succeeds.
   */
  @Remote
  async set(request: { sessionId: SessionId; mode: SessionMode }): Promise<{ mode: SessionMode }> {
    const live = this.ctx.agents.get(request.sessionId)
    {
      using observation = await this.ctx.sessionQuery.observeSession(request.sessionId, { projectionMode: 'none' })
      if (hasApiSessionSubagentOwner(this.ctx, observation, live)) {
        throw new RemoteError('gateway/bad-request', '模式开关仅用于主线会话。子代理不切换模式，请直接发送任务或问题。', {})
      }
    }
    const resolved = live === undefined ? await this.ctx.sessionController.resolveAgent(request.sessionId) : { agent: live }
    if ('error' in resolved) throw resolved.error
    const session = resolved.agent.session
    this.select(session, request.mode)
    if (!await this.ctx.sessions.flush(session)) throw new RemoteError('gateway/internal', '会话模式已记录，但持久化尚未确认，请重试。', {})
    return { mode: this.ctx.sessionProjections.stateOf(session, 'sessionMode')!.mode }
  }

  private select(session: Session, mode: SessionMode): void {
    const current = this.ctx.sessionProjections.stateOf(session, 'sessionMode')
    if (current === undefined) throw new Error('缺少会话模式投影。')
    if (current.mode !== mode) session.append('session-mode/selected', { mode })
  }
}

export default SessionModeService
