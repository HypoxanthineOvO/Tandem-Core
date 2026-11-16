/** Optional execution admission and turn-report providers.
 * @module @deepseek-ai/dsh-subagent/admission
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Trusted entry point that requested execution; omission on older callers means service. */
export type SubagentAdmissionSource = 'tool' | 'workflow' | 'remote' | 'service'

/** Execution inputs checked before preparation and before each residency reservation. */
export interface SubagentAdmissionRequest {
  readonly parent: Agent
  readonly childId: SessionId
  readonly preset: string | undefined
  readonly label: string
  readonly depth: number
  readonly source: SubagentAdmissionSource
  readonly resuming: boolean
}

/** One tree-wide quota in addition to the total activation limit. */
export interface SubagentQuotaGroup {
  readonly id: string
  readonly max: number
}

/** Pure admission decision; a supplied quota overrides the configured preset quota. */
export type SubagentAdmissionDecision =
  | { readonly allow: true; readonly quotaGroup?: SubagentQuotaGroup }
  | { readonly allow: false; readonly reason: string }

/** Deployment-owned policy; absence preserves ordinary subagent admission. */
export abstract class SubagentAdmissionPolicy extends Service {
  constructor(ctx: Context) { super(ctx, 'subagentAdmissionPolicy') }

  /**
   * Check execution without effects; repeated checks do not establish identity.
   * @param request - exact parent and proposed child execution.
   * @returns permission and optional group, or an actionable rejection reason.
   */
  abstract check(request: SubagentAdmissionRequest): SubagentAdmissionDecision
}

/** One completed turn containing admitted browser-authored input. */
export interface SubagentDirectHumanTurn {
  readonly parent: Agent
  readonly child: Agent
  readonly effectId: string
  readonly turn: number
  /**
   * Queue at most one report-only reminder during this callback. Its returned id
   * is the replyTo required by the single permitted human-summary report.
   * @param content - logged reminder text, including instructions to use its reply id.
   * @returns reminder inbox id; repeating this turn returns the existing id.
   */
  queueReminder(content: ContentBlock[]): MessageId
}

/** Deployment-owned handling of completed direct-human turns; absent means no reminder. */
export abstract class SubagentHumanTurnObserver extends Service {
  constructor(ctx: Context) { super(ctx, 'subagentHumanTurnObserver') }

  /**
   * Observe a normally completed human turn after driver quiescence, before settlement.
   * @param turn - direct-human turn with a callback-scoped reminder capability.
   */
  abstract onTurnEnded(turn: SubagentDirectHumanTurn): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagentAdmissionPolicy: SubagentAdmissionPolicy
    subagentHumanTurnObserver: SubagentHumanTurnObserver
  }
}
