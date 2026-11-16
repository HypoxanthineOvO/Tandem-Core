/** Tandem mark for the running Chat status; legacy filename retained. */
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ChatView.module.css'

/**
 * Render the decorative Tandem status mark without motion.
 * @returns the square status mark.
 */
export function RunningWhaleTail() {
  return <span className={css.runningIcon} aria-hidden="true"><FishLogo size={14} /></span>
}
