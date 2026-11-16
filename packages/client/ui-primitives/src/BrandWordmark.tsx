import type { IconProps } from './icons/props.ts'
import { FishLogo } from './FishLogo.tsx'

/** Display options for the Tandem wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading Tandem mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the Tandem wordmark.
 * @param props.size - Height in pixels; width follows the selected artwork.
 * @param props.className - Extra class for layout placement.
 * @param props.includeMark - Whether to include the leading Tandem mark.
 * @returns decorative Tandem name artwork.
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const width = includeMark ? 126 : 98
  return (
    <svg width={(size * width) / 24} height={size} className={className}
      viewBox={includeMark ? '0 0 126 24' : '28 0 98 24'} fill="currentColor" aria-hidden="true">
      {includeMark && <FishLogo size={24} />}
      <text x="28" y="19" fontSize="22" fontFamily="system-ui, sans-serif" fontWeight="600">Tandem</text>
    </svg>
  )
}
