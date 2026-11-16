/** Optional route comparison supplied by a deployment's routing policy.
 * @module @deepseek-ai/dsh-subagent/route-equivalence
 */

import { Service, type Context } from '@deepseek-ai/cordis'

/** A selected or recorded model route, without changing its dispatch identity. */
export interface SubagentModelRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Service Definition for `subagentRouteEquivalence`. Routing plugins provide it;
 * parent settlement notices consume it without normalizing the recorded route.
 */
export abstract class SubagentRouteEquivalence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subagentRouteEquivalence')
  }

  /**
   * Compare model identity under the provider's routing rules, synchronously and without effects.
   * @param selected - the complete route selected when the child was created.
   * @param actual - the child's last recorded own request route.
   * @returns true when the routes represent the same model, false for a fallback route.
   */
  abstract isSameRoute(selected: SubagentModelRoute, actual: SubagentModelRoute): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagentRouteEquivalence: SubagentRouteEquivalence
  }
}
