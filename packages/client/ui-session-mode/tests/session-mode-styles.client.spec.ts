/** Mode chip layout: the label collapses in a narrow (about 420px) composer row. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sheet = readFileSync(new URL('../src/client/SessionModeControl.module.css', import.meta.url), 'utf8')
const rule = (name: string) => new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? ''

describe('SessionModeControl.module.css', () => {
  it('collapses the label before a 420px composer row overflows', () => {
    // The sibling composer chips collapse at 460px; the mode chip never waits
    // for the narrower 420px case.
    expect(sheet).toMatch(/@container \(max-width: 460px\)/)
    expect(sheet).toMatch(/@container \(max-width: 460px\)[\s\S]*?\.label \{[\s\S]*?display: none/)
  })

  it('lets the label shrink to an ellipsis instead of widening the row', () => {
    expect(rule('chip')).toMatch(/min-width: 0/)
    expect(rule('label')).toMatch(/min-width: 0/)
    expect(rule('label')).toMatch(/overflow: hidden/)
    expect(rule('label')).toMatch(/text-overflow: ellipsis/)
    expect(rule('label')).toMatch(/white-space: nowrap/)
  })

  it('uses theme tokens only', () => {
    expect(sheet).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})
