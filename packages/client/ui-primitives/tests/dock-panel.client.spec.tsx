// @vitest-environment jsdom
/** Docked composer strip: header toggle, list rows, and footer. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DockPanel, DockPanelItem } from '../src/index.ts'

afterEach(cleanup)

describe('DockPanel', () => {
  it('shows only the header while closed and toggles through it', () => {
    const onToggle = vi.fn()
    render(
      <DockPanel icon={<i />} title="Pending" summary="2: First" open={false} onToggle={onToggle} footer={<button type="button">Act</button>}>
        <DockPanelItem glyph={<i />} content="First" />
      </DockPanel>,
    )
    expect(screen.getByText('Pending')).toBeTruthy()
    expect(screen.getByText('2: First')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Act' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('renders rows with an optional trailing note and the footer while open', () => {
    render(
      <DockPanel icon={<i />} title="Pending" summary="s" open onToggle={() => {}} footer={<button type="button">Act</button>} data-testid="dock">
        <DockPanelItem glyph={<i />} content="First" trailing="Soon" data-kind="a" />
        <DockPanelItem glyph={<i />} content="Second" />
      </DockPanel>,
    )
    expect(screen.getByTestId('dock').tagName).toBe('SECTION')
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['FirstSoon', 'Second'])
    expect(screen.getByText('First').getAttribute('title')).toBe('First')
    expect(screen.getByRole('button', { name: 'Act' })).toBeTruthy()
  })

  it('omits the list and footer when the owner supplies neither', () => {
    render(<DockPanel icon={<i />} title="T" summary="s" open onToggle={() => {}} />)
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
  })
})
