/**
 * Collapsible strip docked above the composer card: a one-line header with a
 * leading icon, title, ellipsized summary, and direction chevron, then an
 * optional scrolling item list and footer while open.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular } from './icons/index.tsx'
import css from './DockPanel.module.css'

/** Props of {@link DockPanel}; remaining attributes land on the root `section`. */
export interface DockPanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Decorative leading glyph. */
  icon: ReactNode
  /** Short visible title. */
  title: string
  /** One-line summary after the title; ellipsized when it does not fit. */
  summary: string
  /** Whether the list and footer are shown. */
  open: boolean
  /** Toggle request from the header button. */
  onToggle: () => void
  /** `DockPanelItem` rows rendered in the open list; none renders no list. */
  children?: ReactNode
  /** Actions and status rendered under the open list. */
  footer?: ReactNode
}

/**
 * Render the docked strip. The owner decides whether it renders at all and
 * owns the open state.
 * @param props - header copy, open state, list rows, and footer.
 * @returns the strip.
 */
export function DockPanel({ icon, title, summary, open, onToggle, children, footer, ...rest }: DockPanelProps) {
  return (
    <section className={css.root} {...rest}>
      <div className={css.body}>
        <button type="button" className={css.header} aria-expanded={open} onClick={onToggle}>
          <span className={css.lead} aria-hidden>{icon}</span>
          <span className={css.title}>{title}</span>
          <span className={css.progress}>{summary}</span>
          <span className={css.chevron} aria-hidden>
            {open ? <IconChevronDownOutlineRegular /> : <IconChevronUpOutlineRegular />}
          </span>
        </button>
        {open && children !== undefined && <ul className={css.list}>{children}</ul>}
        {open && footer !== undefined && <div className={css.footer}>{footer}</div>}
      </div>
    </section>
  )
}

/** Props of {@link DockPanelItem}; remaining attributes land on the `li`. */
export interface DockPanelItemProps extends HTMLAttributes<HTMLLIElement> {
  /** Leading status mark, usually a `StateDot` inside a labelled `role="img"` span. */
  glyph: ReactNode
  /** One-line item text; ellipsized when it does not fit. */
  content: string
  /** Optional short trailing note. */
  trailing?: string | undefined
}

/**
 * Render one list row of a {@link DockPanel}.
 * @param props - status mark, item text, and optional trailing note.
 * @returns the list item.
 */
export function DockPanelItem({ glyph, content, trailing, ...rest }: DockPanelItemProps) {
  return (
    <li className={css.item} {...rest}>
      <span className={css.glyph}>{glyph}</span>
      <span className={css.content} title={content}>{content}</span>
      {trailing !== undefined && <span className={css.trailing}>{trailing}</span>}
    </li>
  )
}
