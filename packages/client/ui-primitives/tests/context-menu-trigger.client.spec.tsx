// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { Menu, useContextMenuTrigger } from '../src/index.ts'

afterEach(cleanup)

const items = [
  { id: 'rename', label: 'Rename' },
  { id: 'off', label: 'Unavailable', disabled: true },
  { id: 'delete', label: 'Delete' },
]

/** One element owning one Menu, opened from its own button or as a context menu. */
function Owner({ enabled = true, onActivate = () => {}, onSelect = () => {} }: {
  enabled?: boolean
  onActivate?: () => void
  onSelect?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const context = useContextMenuTrigger({
    open, enabled,
    onOpen: () => { setOpen(true) },
    onClose: () => { setOpen(false) },
  })
  return (
    <div data-testid="list">
      <div role="treeitem" tabIndex={0} {...context.handlers} onClick={onActivate}>
        <span data-testid="title">Row</span>
        <Menu
          open={open}
          items={items}
          portal
          closeOnPointerLeave={!context.active}
          autoFocus={context.keyboard}
          getAnchorRect={context.getAnchorRect}
          returnFocusTo={context.returnFocusTo}
          onSelect={(id) => { setOpen(false); onSelect(id) }}
          onClose={() => { setOpen(false) }}
          anchor={<button type="button" onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}>More</button>}
        />
      </div>
      <div data-testid="elsewhere" style={{ overflow: 'auto' }}>Elsewhere</div>
    </div>
  )
}

function contextMenu(target: Element, x = 40, y = 60): boolean {
  return fireEvent.contextMenu(target, { clientX: x, clientY: y, button: 2 })
}

function touch(type: 'pointerDown' | 'pointerMove', target: Element, x: number, y: number): void {
  fireEvent[type](target, { pointerType: 'touch', clientX: x, clientY: y })
}

function menuLabels(): (string | null)[] {
  return screen.getAllByRole('menuitem').map(item => item.textContent)
}

describe('useContextMenuTrigger', () => {
  it('opens the same Menu instance at the pointer with identical rows, order and disabled state', () => {
    const onActivate = vi.fn()
    render(<Owner onActivate={onActivate} />)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    const fromButton = menuLabels()
    const disabledFromButton = screen.getAllByRole('menuitem').map(item => (item as HTMLButtonElement).disabled)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    const prevented = !contextMenu(screen.getByText('Row'), 40, 60)
    expect(prevented).toBe(true)
    expect(menuLabels()).toEqual(fromButton)
    expect(screen.getAllByRole('menuitem').map(item => (item as HTMLButtonElement).disabled)).toEqual(disabledFromButton)
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('64px')
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('keeps the menu inside the viewport near the right and bottom edges', () => {
    render(<Owner />)
    contextMenu(screen.getByText('Row'), 0, 0)
    const menu = screen.getByRole('menu')
    Object.defineProperty(menu, 'offsetWidth', { configurable: true, value: 160 })
    Object.defineProperty(menu, 'offsetHeight', { configurable: true, value: 120 })
    fireEvent.keyDown(document, { key: 'Escape' })
    contextMenu(screen.getByText('Row'), window.innerWidth - 5, window.innerHeight - 5)
    const placed = screen.getByRole('menu')
    Object.defineProperty(placed, 'offsetWidth', { configurable: true, value: 160 })
    Object.defineProperty(placed, 'offsetHeight', { configurable: true, value: 120 })
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(Number.parseFloat(placed.style.left)).toBe(window.innerWidth - 160 - 12)
    expect(Number.parseFloat(placed.style.top)).toBe(window.innerHeight - 120 - 12)
  })

  it('leaves the browser menu alone when disabled and outside the element', () => {
    render(<Owner enabled={false} />)
    expect(contextMenu(screen.getByText('Row'))).toBe(true)
    expect(contextMenu(screen.getByTestId('elsewhere'))).toBe(true)
    fireEvent.keyDown(screen.getByRole('treeitem'), { key: 'ContextMenu' })
    touch('pointerDown', screen.getByText('Row'), 1, 1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('suppresses the native menu but keeps the position for a secondary click inside the open menu', () => {
    render(<Owner />)
    contextMenu(screen.getByText('Row'), 40, 60)
    expect(contextMenu(screen.getByRole('menuitem', { name: 'Rename' }), 300, 300)).toBe(false)
    expect(screen.getByRole('menu').style.left).toBe('40px')
  })

  it('closes on Escape, an outside pointerdown, and a scroll outside the menu', () => {
    render(<Owner />)
    const row = screen.getByText('Row')
    contextMenu(row)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    contextMenu(row)
    fireEvent.pointerDown(screen.getByTestId('elsewhere'))
    expect(screen.queryByRole('menu')).toBeNull()

    contextMenu(row)
    fireEvent.scroll(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.scroll(window)
    expect(screen.queryByRole('menu')).toBeNull()
    // A scroll after closing changes nothing.
    fireEvent.scroll(screen.getByTestId('elsewhere'))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('ignores scrolls inside the row, the menu, or an unrelated container, and closes when a container of the row scrolls', () => {
    render(<Owner />)
    contextMenu(screen.getByText('Row'))
    // A long title marquees by scrolling itself; that does not move the row.
    fireEvent.scroll(screen.getByTestId('title'))
    fireEvent.scroll(screen.getByRole('treeitem'))
    fireEvent.scroll(screen.getByRole('menu'))
    fireEvent.scroll(screen.getByTestId('elsewhere'))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.scroll(screen.getByTestId('list'))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('applies the same scroll rule to keyboard and long-press openings, and closes on a document scroll', () => {
    vi.useFakeTimers()
    try {
      render(<Owner />)
      const row = screen.getByRole('treeitem')
      row.focus()
      fireEvent.keyDown(row, { key: 'ContextMenu' })
      fireEvent.scroll(screen.getByTestId('title'))
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.scroll(document)
      expect(screen.queryByRole('menu')).toBeNull()

      touch('pointerDown', screen.getByText('Row'), 5, 5)
      act(() => { vi.advanceTimersByTime(500) })
      fireEvent.scroll(screen.getByTestId('title'))
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.scroll(screen.getByTestId('list'))
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a menu opened from its own button open on scroll, as before', () => {
    render(<Owner />)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.scroll(window)
    fireEvent.scroll(screen.getByTestId('list'))
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('does not close a context menu when the pointer leaves the row, unlike the button opening', () => {
    vi.useFakeTimers()
    try {
      render(<Owner />)
      contextMenu(screen.getByText('Row'))
      const wrapper = screen.getByRole('button', { name: 'More' }).parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      fireEvent.pointerLeave(wrapper)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.getByRole('menu')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['ContextMenu', false],
    ['F10', true],
  ] as const)('opens below the focused element from %s, focuses the first row, and returns focus on Escape', (key, shiftKey) => {
    render(<Owner />)
    const row = screen.getByRole('treeitem')
    row.getBoundingClientRect = () => new DOMRect(10, 100, 200, 32)
    row.focus()
    fireEvent.keyDown(row, { key, shiftKey })
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('10px')
    expect(menu.style.top).toBe('136px')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
    // The browser's own keyboard contextmenu that follows is absorbed.
    expect(contextMenu(row, 0, 0)).toBe(false)
    expect(screen.getByRole('menu').style.top).toBe('136px')
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it('returns focus to the row after a keyboard-opened selection', async () => {
    const onSelect = vi.fn()
    render(<Owner onSelect={onSelect} />)
    const row = screen.getByRole('treeitem')
    row.focus()
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(onSelect).toHaveBeenCalledWith('delete')
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(row)
  })

  it('ignores other keys, modified shortcuts, and keys from the portaled menu', () => {
    render(<Owner />)
    const row = screen.getByRole('treeitem')
    fireEvent.keyDown(row, { key: 'F10' })
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: 'ContextMenu', ctrlKey: true })
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true, altKey: true })
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true, metaKey: true })
    expect(screen.queryByRole('menu')).toBeNull()
    contextMenu(screen.getByText('Row'), 40, 60)
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rename' }), { key: 'ContextMenu' })
    expect(screen.getByRole('menu').style.left).toBe('40px')
  })

  it('opens from a touch long-press at the press point and swallows the click that ends it', () => {
    vi.useFakeTimers()
    try {
      const onActivate = vi.fn()
      render(<Owner onActivate={onActivate} />)
      const row = screen.getByText('Row')
      touch('pointerDown', row, 30, 50)
      touch('pointerMove', row, 33, 52)
      act(() => { vi.advanceTimersByTime(499) })
      expect(screen.queryByRole('menu')).toBeNull()
      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.getByRole('menu').style.left).toBe('30px')
      fireEvent.pointerUp(row)
      fireEvent.click(row)
      expect(onActivate).not.toHaveBeenCalled()
      // Only the one click is swallowed.
      fireEvent.keyDown(document, { key: 'Escape' })
      fireEvent.click(row)
      expect(onActivate).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the long-press on travel, release, cancel, a native contextmenu, mouse input and unmount', () => {
    vi.useFakeTimers()
    try {
      const view = render(<Owner />)
      const row = screen.getByText('Row')
      touch('pointerDown', row, 0, 0)
      touch('pointerMove', row, 20, 0)
      fireEvent.pointerMove(row, { clientX: 40, clientY: 0 })
      act(() => { vi.advanceTimersByTime(600) })
      expect(screen.queryByRole('menu')).toBeNull()

      touch('pointerDown', row, 0, 0)
      fireEvent.pointerUp(row)
      act(() => { vi.advanceTimersByTime(600) })
      touch('pointerDown', row, 0, 0)
      fireEvent.pointerCancel(row)
      act(() => { vi.advanceTimersByTime(600) })
      fireEvent.pointerDown(row, { pointerType: 'mouse', clientX: 0, clientY: 0 })
      act(() => { vi.advanceTimersByTime(600) })
      expect(screen.queryByRole('menu')).toBeNull()

      // Android's own long-press contextmenu wins over the pending timer.
      touch('pointerDown', row, 0, 0)
      touch('pointerDown', row, 5, 5)
      contextMenu(row, 70, 80)
      act(() => { vi.advanceTimersByTime(600) })
      expect(screen.getByRole('menu').style.left).toBe('70px')
      fireEvent.keyDown(document, { key: 'Escape' })

      touch('pointerDown', row, 0, 0)
      view.unmount()
      act(() => { vi.advanceTimersByTime(600) })
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reopening from the button after a context opening measures the button again', () => {
    render(<Owner />)
    contextMenu(screen.getByText('Row'), 40, 60)
    fireEvent.keyDown(document, { key: 'Escape' })
    const button = screen.getByRole('button', { name: 'More' })
    ;(button.parentElement as HTMLElement).getBoundingClientRect = () => new DOMRect(150, 20, 16, 16)
    fireEvent.click(button)
    expect(screen.getByRole('menu').style.left).toBe('150px')
    expect(screen.getByRole('menu').style.top).toBe('40px')
  })
})

describe('Menu.returnFocusTo', () => {
  it('falls back to the trigger when the element is gone', () => {
    const detached = document.createElement('div')
    function Detached() {
      const [open, setOpen] = useState(false)
      return (
        <Menu
          open={open}
          autoFocus
          items={items}
          returnFocusTo={() => detached}
          onClose={() => { setOpen(false) }}
          anchor={<button type="button" onClick={() => { setOpen(true) }}>Open</button>}
        />
      )
    }
    render(<Detached />)
    const trigger = screen.getByRole('button', { name: 'Open' })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })

  it('moves keyboard focus with a visible ring on Shift+Tab', () => {
    function ShiftTab() {
      const [open, setOpen] = useState(false)
      const context = useContextMenuTrigger({
        open, enabled: true, onOpen: () => { setOpen(true) }, onClose: () => { setOpen(false) },
      })
      return (
        <div role="treeitem" tabIndex={0} {...context.handlers}>
          <Menu
            open={open}
            items={items}
            autoFocus={context.keyboard}
            returnFocusTo={context.returnFocusTo}
            onClose={() => { setOpen(false) }}
            anchor={<button type="button">More</button>}
          />
        </div>
      )
    }
    render(<ShiftTab />)
    const row = screen.getByRole('treeitem')
    row.focus()
    fireEvent.keyDown(row, { key: 'ContextMenu' })
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(row)
  })
})
