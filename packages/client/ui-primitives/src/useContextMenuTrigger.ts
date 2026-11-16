/**
 * Context-menu opening for an element that already owns a `Menu`: a secondary
 * click, the ContextMenu key or Shift+F10, and a touch long-press open the
 * owner's existing menu at the pointer (or below the element for the keyboard)
 * instead of the browser's native menu.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'

/** Touch hold before a long-press opens the menu, matching the platform press-and-hold delay. */
const LONG_PRESS_MS = 500

/** Finger travel that turns a press into a scroll or drag and cancels the long-press. */
const LONG_PRESS_SLOP_PX = 8

/**
 * Window after a keyboard opening in which the browser's own keyboard
 * `contextmenu` event is absorbed instead of re-anchoring at its synthetic point.
 */
const KEYBOARD_ECHO_MS = 300

type Origin =
  | { kind: 'pointer'; x: number; y: number; element: HTMLElement }
  | { kind: 'keyboard'; element: HTMLElement }

/** Event handlers the owner spreads on the element that opens the context menu. */
export interface ContextMenuTriggerHandlers {
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onClickCapture: (event: MouseEvent<HTMLElement>) => void
}

/** What the owner passes on to its `Menu` while this trigger opened it. */
export interface ContextMenuTrigger {
  /** Handlers for the trigger element; inert while disabled. */
  handlers: ContextMenuTriggerHandlers
  /** True while the open menu was opened by this trigger rather than the owner's own button. */
  active: boolean
  /** True while the open menu was opened from the keyboard; pass as `Menu.autoFocus`. */
  keyboard: boolean
  /**
   * `Menu.getAnchorRect` while active: a zero-size rect at the pointer, or the
   * trigger element's live rect for a keyboard opening. Undefined otherwise, so
   * the menu measures its own anchor as before.
   */
  getAnchorRect: (() => DOMRect | null) | undefined
  /** The element a keyboard opening started from, for `Menu.returnFocusTo`. */
  returnFocusTo: (() => HTMLElement | null) | undefined
}

/**
 * Open an owner's existing menu as a context menu.
 *
 * The owner keeps its single `open` state and its single `Menu`; this hook only
 * records where the opening came from. Events that reach the trigger through
 * the React tree from a portaled descendant (the open menu itself) are ignored
 * for positioning. While active, a scroll that moves the trigger element (the
 * document or a container holding the element) closes the menu, because the
 * point it was anchored to has moved relative to the content. Scrolls inside
 * the trigger element itself (a marqueeing title), inside a `role="menu"`
 * element, or in an unrelated container leave it open.
 * @param options.open - the owner's menu open state.
 * @param options.onOpen - open the owner's menu.
 * @param options.onClose - close the owner's menu.
 * @param options.enabled - false leaves every event to the browser (no menu for this element).
 * @returns handlers for the trigger element and the props for its `Menu`.
 */
export function useContextMenuTrigger({ open, onOpen, onClose, enabled }: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  enabled: boolean
}): ContextMenuTrigger {
  const [origin, setOrigin] = useState<Origin | null>(null)
  // A closed menu forgets its origin, so a later opening from the owner's own
  // button measures that button again.
  if (!open && origin !== null) setOrigin(null)
  const active = open && origin !== null
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const suppressClick = useRef(false)
  const keyboardAt = useRef(Number.NEGATIVE_INFINITY)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const cancelPress = (): void => {
    if (press.current === null) return
    clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => cancelPress, [])

  const anchorElement = open && origin !== null ? origin.element : undefined
  useEffect(() => {
    if (anchorElement === undefined) return
    const closeOnScroll = (event: Event): void => {
      const target = event.target
      // Window and document scrolls move every element.
      if (!(target instanceof Element)) {
        onCloseRef.current()
        return
      }
      if (target.contains(anchorElement) && target !== anchorElement) onCloseRef.current()
    }
    window.addEventListener('scroll', closeOnScroll, true)
    return () => { window.removeEventListener('scroll', closeOnScroll, true) }
  }, [anchorElement])

  const openAt = (next: Origin): void => {
    setOrigin(next)
    onOpen()
  }
  // Events bubbling from the portaled menu reach the trigger through the React
  // tree only; they are not the trigger's own.
  const own = (event: { currentTarget: HTMLElement; target: EventTarget }): boolean =>
    event.target instanceof Node && event.currentTarget.contains(event.target)

  const handlers: ContextMenuTriggerHandlers = {
    onContextMenu: (event) => {
      if (!enabled) return
      event.preventDefault()
      event.stopPropagation()
      cancelPress()
      if (!own(event)) return
      if (performance.now() - keyboardAt.current < KEYBOARD_ECHO_MS) return
      openAt({ kind: 'pointer', x: event.clientX, y: event.clientY, element: event.currentTarget })
    },
    onKeyDown: (event) => {
      if (!enabled || !own(event)) return
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      if (event.ctrlKey || event.altKey || event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      keyboardAt.current = performance.now()
      openAt({ kind: 'keyboard', element: event.currentTarget })
    },
    onPointerDown: (event) => {
      if (!enabled || event.pointerType !== 'touch' || !own(event)) return
      cancelPress()
      const x = event.clientX
      const y = event.clientY
      const element = event.currentTarget
      press.current = {
        x, y,
        timer: setTimeout(() => {
          press.current = null
          suppressClick.current = true
          openAt({ kind: 'pointer', x, y, element })
        }, LONG_PRESS_MS),
      }
    },
    onPointerMove: (event) => {
      const start = press.current
      if (start === null) return
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancelPress()
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onClickCapture: (event) => {
      // The click that ends a long-press would otherwise also activate the element.
      if (!suppressClick.current) return
      suppressClick.current = false
      event.preventDefault()
      event.stopPropagation()
    },
  }

  // One callback identity per origin: `Menu` re-runs its placement effect when it changes.
  const anchor = useMemo(() => {
    if (origin === null) return { getAnchorRect: undefined, returnFocusTo: undefined }
    if (origin.kind === 'pointer') {
      const { x, y } = origin
      return { getAnchorRect: () => new DOMRect(x, y, 0, 0), returnFocusTo: undefined }
    }
    const { element } = origin
    return { getAnchorRect: () => element.getBoundingClientRect(), returnFocusTo: () => element }
  }, [origin])
  return {
    handlers,
    active,
    keyboard: active && origin?.kind === 'keyboard',
    getAnchorRect: active ? anchor.getAnchorRect : undefined,
    returnFocusTo: active ? anchor.returnFocusTo : undefined,
  }
}
