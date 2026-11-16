/** Continuity row layout: one-line summaries shrink and ellipsize in a narrow (about 420px) column. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sheet = readFileSync(new URL('../src/client/continuity/Continuity.module.css', import.meta.url), 'utf8')
const rule = (name: string) => new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? ''

describe('Continuity.module.css', () => {
  it('lets the row summary shrink to an ellipsis', () => {
    expect(rule('rowSummary')).toMatch(/min-width: 0/)
    expect(rule('rowSummary')).toMatch(/overflow: hidden/)
    expect(rule('rowSummary')).toMatch(/text-overflow: ellipsis/)
    expect(rule('rowSummary')).toMatch(/white-space: nowrap/)
    expect(rule('chatRow')).toMatch(/max-width: 100%/)
  })

  it('wraps long detail text instead of widening the column', () => {
    expect(rule('detailItem')).toMatch(/overflow-wrap: anywhere/)
    expect(rule('fieldKey')).toMatch(/max-width: 50%/)
    expect(rule('fieldKey')).toMatch(/text-overflow: ellipsis/)
    expect(rule('outcome')).toMatch(/overflow-wrap: anywhere/)
  })

  it('keeps the branch action and its failure line readable at 420px', () => {
    expect(rule('bringBackWrap')).toMatch(/min-width: 0/)
    expect(rule('bringBackOutcome')).toMatch(/min-width: 0/)
    expect(rule('bringBackOutcome')).toMatch(/overflow-wrap: anywhere/)
  })

  it('uses theme tokens only', () => {
    expect(sheet).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})
