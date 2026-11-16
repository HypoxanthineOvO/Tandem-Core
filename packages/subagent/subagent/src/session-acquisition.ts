/** Subagent-owned provider for generic Session Agent acquisition. */
import { Context } from '@deepseek-ai/cordis'
import { SessionAgentAcquisition, type SessionAgentLease } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRuntime } from './index.ts'

/** Retains the native owner chain for both live and cold child Sessions. */
export class SubagentSessionAcquisition extends SessionAgentAcquisition {
  constructor(ctx: Context, private readonly runtime: SubagentRuntime) { super(ctx) }

  async acquire(sessionId: SessionId, signal: AbortSignal): Promise<SessionAgentLease | undefined> {
    const session = this.ctx.get('agents')?.get(sessionId)?.session ?? this.ctx.get('sessions')?.get(sessionId)
    let origin = session?.header.origin
    if (session === undefined) {
      const query = this.ctx.get('sessionQuery')
      if (query === undefined) return undefined
      using observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' })
      origin = observation.header.origin
    }
    if (origin !== 'subagent') return undefined
    return this.runtime.acquireLive(undefined, sessionId, signal)
  }
}
