/** Docked composer strip layout: every text line shrinks so a narrow column ellipsizes instead of overflowing. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('DockPanel.module.css', () => {
  it('keeps every text line shrinkable so a narrow column ellipsizes instead of overflowing', () => {
    const sheet = readFileSync(new URL('../src/DockPanel.module.css', import.meta.url), 'utf8')
    const rule = (name: string) => new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? ''
    for (const name of ['progress', 'content']) {
      expect(rule(name)).toMatch(/min-width: 0/)
      expect(rule(name)).toMatch(/text-overflow: ellipsis/)
      expect(rule(name)).toMatch(/white-space: nowrap/)
    }
    expect(rule('footer')).toMatch(/flex-wrap: wrap/)
  })
})
