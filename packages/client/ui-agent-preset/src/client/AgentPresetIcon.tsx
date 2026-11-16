/** A preset's declared monochrome image, or the native generic glyph. */
import { IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** Presentation metadata only; the preset identity and composition remain unchanged. */
export function AgentPresetIcon({ icon, size = 18, className }: { icon?: string | undefined; size?: number; className?: string | undefined }) {
  if (icon === undefined) return <IconAgentPresetOutlineRegular size={size} className={className} />
  return <span aria-hidden="true" className={className} style={{ display: 'inline-block', width: size, height: size, flex: '0 0 auto', backgroundColor: 'currentColor', maskImage: `url("${icon}")`, maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center' }} />
}
