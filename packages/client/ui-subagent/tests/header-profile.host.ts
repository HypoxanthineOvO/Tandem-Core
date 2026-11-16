/** Source-only Host half of the header Settings/browser composition regression. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import { SettingsController } from '@deepseek-ai/dsh-api-settings-controller'

/**
 * Describe the supplied owning Config schema through a real profile, Loader and Remote provider.
 * @param schema - serialized owning Config, passed across the explicit compiler-face boundary.
 * @param presentation - actual profile value, not a preconstructed browser namespace.
 * @returns the unmodified settings/describe wire answer.
 */
export async function describeHeaderProfile(schema: ConstructorParameters<typeof z>[0], presentation: 'default' | 'none') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-header-profile-')))
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['header-fixture'])
  const bundle = join(dir, 'node_modules', 'header-fixture')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"header-test"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'header-fixture', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'ui-subagent', name: 'cordis:header', config: { headerPresentation: presentation } },
    { id: 'vsp-presentation', name: 'cordis:policy' },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['header-fixture'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, {
      editor: ConfigEditor, settings: Settings,
      header: { Config: new z(schema), apply() {} },
      policy: {
        Config: z.object({ enabled: z.boolean().default(true).volatile() }),
        apply(plugin: typeof ctx) {
          plugin.inject(['settings'], (scope) => {
            scope.effect(() => scope.settings.configure({ auto: false }, plugin.fiber))
          })
        },
      },
    })
  })
  try {
    const controller = new SettingsController(ctx)
    const answer = controller.describe()
    const policy = answer.namespaces.find(view => view.ns === 'vsp-presentation')
    if (policy?.autoGenerate !== false) throw new Error('fixture failed to apply instance-local auto:false')
    return answer
  } finally {
    await ctx.fiber.dispose()
    // The path is the checked mkdtemp root, never a user/profile directory.
    if (!home.startsWith(join(realpathSync(tmpdir()), 'subagent-header-profile-'))) throw new Error('unexpected test root')
    rmSync(home, { recursive: true, force: true })
  }
}
