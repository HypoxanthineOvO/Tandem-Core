import type { IconProps } from './icons/props.ts'

/** Tandem mark dimensions; legacy export name retained for plugin compatibility. */
export const FISH_LOGO_VIEWBOX = { width: 100, height: 100 }

/** Monochrome Tandem T silhouette for consumers composing masks. */
export const FISH_LOGO_PATH = 'M16.4 10H83.6A6.4 6.4 0 0 1 83.6 22.8H16.4A6.4 6.4 0 0 1 16.4 10ZM49.3 22.8H50.7V92.4H49.3Z'

/**
 * Render the Tandem mark from the approved promo vector geometry.
 * @param props.size - Square width and height in pixels.
 * @param props.className - Extra class for layout placement.
 * @returns decorative Tandem SVG; the legacy component name stays compatible.
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <rect x="10" y="10" width="80" height="12.8" rx="6.4" fill="#ffb840" />
      <path d="M50 22.8V92.4" stroke="#38e8ff" strokeWidth="1.4" />
      <rect x="40.8" y="27.6" width="18.4" height="13.6" rx="6.8" fill="#f2895c" fillOpacity=".18" stroke="#f2895c" strokeWidth="2" />
      <rect x="40.8" y="45.2" width="18.4" height="13.6" rx="6.8" fill="#22c98a" fillOpacity=".18" stroke="#22c98a" strokeWidth="2" />
      <rect x="40.8" y="62.8" width="18.4" height="13.6" rx="6.8" fill="#a98bff" fillOpacity=".18" stroke="#a98bff" strokeWidth="2" />
      <rect x="40.8" y="80.4" width="18.4" height="13.6" rx="6.8" fill="#5b8cff" fillOpacity=".18" stroke="#5b8cff" strokeWidth="2" />
    </svg>
  )
}
