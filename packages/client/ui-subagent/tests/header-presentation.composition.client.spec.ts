// @vitest-environment jsdom
/** Deployment configuration reaches header contributions through the native Settings mirror. */
import { describe, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import type { SettingsDescribeView } from '../../ui-settings/src/client/settings-mirror.ts'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { Config } from '../src/index.ts'

const it = createClientTest({ roster: webApp })
const PACKAGE = '@deepseek-ai/dsh-client-ui-subagent'

describe('assembled subagent header presentation', () => {
  for (const headerPresentation of ['default', 'none'] as const) {
    it(`honors ${headerPresentation} without removing composer or continuity`, async ({ mock, start }) => {
      const source = `import { describeHeaderProfile } from ${JSON.stringify(pathToFileURL(resolve('packages/client/ui-subagent/tests/header-profile.host.ts')).href)}; process.stdout.write(JSON.stringify(await describeHeaderProfile(${JSON.stringify(Config.toJSON())}, ${JSON.stringify(headerPresentation)})))`
      const described: SettingsDescribeView = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source], { cwd: process.cwd(), encoding: 'utf8' }))
      const namespace = described.namespaces.find(view => view.ns === 'ui-subagent')
      expect(namespace?.value).toEqual({ headerPresentation })
      expect(namespace?.autoGenerate).toBe(true)
      expect(described.namespaces.find(view => view.ns === 'vsp-presentation')?.autoGenerate).toBe(false)
      mock.unary('settings/describe', () => ok(described))
      const c = await start()
      await vi.waitFor(() => {
        expect(c.ctx.configForms.get('ui-subagent').getSnapshot().status).toBe('ready')
      })
      const visible = headerPresentation === 'default'
      expect(c.ctx.slots.entries('conversation.session.header.lineage').length > 0).toBe(visible)
      expect(c.ctx.slots.entries('conversation.session.header.actions')
        .some(entry => entry.options.id === 'subagent-catalog')).toBe(visible)
      expect(c.ctx.slots.entries('conversation.composer')
        .some(entry => entry.options.priority === -10)).toBe(true)
      expect(c.ctx.slots.entries('conversation.input.right')
        .some(entry => entry.options.id === 'continuity-bring-back')).toBe(true)
      expect(c.ctx.slots.entries('conversation.input.dock')
        .some(entry => entry.options.id === 'continuity-pending')).toBe(true)
      await c.unload(PACKAGE)
      expect(c.ctx.slots.entries('conversation.session.header.lineage')).toEqual([])
      expect(c.ctx.slots.entries('conversation.session.header.actions')
        .some(entry => entry.options.id === 'subagent-catalog')).toBe(false)
    }, 60_000)
  }
})
