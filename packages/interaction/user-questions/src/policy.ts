/** Optional deployment-owned human-interaction admission. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** Exact live caller and its runtime ownership chain, nearest parent first. */
export interface HumanInteractionAdmission {
  readonly agent: Agent
  readonly session: Session
  readonly isSubagent: boolean
  readonly parentChain: readonly Agent[]
}

/** Deployment decision; a denial carries an actionable reason. */
export type HumanInteractionDecision = { allowed: true } | { allowed: false; reason: string }

/** Optional provider; without one userQuestions retains runtime-root-only admission. */
export abstract class HumanInteractionPolicy extends Service {
  constructor(ctx: Context) { super(ctx, 'humanInteractionPolicy') }
  /** Decide whether this exact live caller may interact with the human.
   * @param request - Caller and runtime ancestry.
   * @returns Admission or an explicit denial reason.
   */
  abstract check(request: HumanInteractionAdmission): HumanInteractionDecision
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    humanInteractionPolicy: HumanInteractionPolicy
  }
}
