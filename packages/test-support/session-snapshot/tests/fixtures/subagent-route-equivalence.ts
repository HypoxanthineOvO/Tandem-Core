/** Recorded-session routing policy with a physical child alias and equivalent logical identity. */
import type { Context } from '@deepseek-ai/cordis'
import { SubagentRouteEquivalence, type SubagentModelRoute } from '@deepseek-ai/dsh-subagent'

class SnapshotRouteEquivalence extends SubagentRouteEquivalence {
  isSameRoute(selected: SubagentModelRoute, actual: SubagentModelRoute): boolean {
    return selected.provider === actual.provider && selected.model === actual.model.replace(/^physical\//, '')
  }
}

export const name = 'snapshot-subagent-route-equivalence'
export const inject = ['agents']

/**
 * Mount a route comparison and dispatch child requests through a test-only physical alias.
 * @param ctx - snapshot runtime with its recorded-response adapter.
 */
export function apply(ctx: Context): void {
  ctx.plugin(SnapshotRouteEquivalence)
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    return agent.session.header.parentSession === undefined ? config : { ...config, model: `physical/${config.model}` }
  })
}
