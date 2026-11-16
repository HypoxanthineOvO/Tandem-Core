/** Optional residency acquisition for Sessions owned outside ordinary Agent routing. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** A live Agent held until the caller finishes its operation. */
export interface SessionAgentLease {
  readonly agent: Agent
  /** Release the residency hold; repeated calls have no effect. */
  release(): void
}

/** Service Definition implemented by specialized Session lifecycle owners. */
export abstract class SessionAgentAcquisition extends Service {
  constructor(ctx: Context) { super(ctx, 'sessionAgentAcquisition') }
  /** Acquire a specialized Session without sending input or starting a model request.
   * @param sessionId - Addressed Session.
   * @param signal - Cancellation until acquisition completes.
   * @returns A residency hold, or undefined when ordinary Agent routing owns the Session.
   */
  abstract acquire(sessionId: SessionId, signal: AbortSignal): Promise<SessionAgentLease | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionAgentAcquisition: SessionAgentAcquisition
  }
}
