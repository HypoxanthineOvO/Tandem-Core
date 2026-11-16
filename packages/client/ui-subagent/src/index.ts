/** Host configuration for subagent presentation; the browser reads the native Settings mirror. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Plain presentation values exposed through the browser Settings mirror. */
export interface HeaderPresentationSettings {
  /** Whether the native lineage and catalog header contributions are registered. */
  headerPresentation: 'default' | 'none'
}

/** Deployment-owned subagent presentation. */
export interface Config {
  /** Live value projected by Settings; defaults to `default`. */
  headerPresentation: Volatile<HeaderPresentationSettings['headerPresentation']>
}

/** Validate the Host configuration exposed through the `ui-subagent` Settings namespace. */
export const Config = z.object({
  headerPresentation: z.union(['default', 'none']).default('default').volatile(),
})

/** Host plugin body; the native Settings service projects its validated Config.
 * @param _ctx - Host plugin context.
 * @param _config - Deployment presentation validated by the Loader.
 */
export function apply(_ctx: Context, _config: Config): void {}
