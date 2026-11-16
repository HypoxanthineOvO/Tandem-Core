import { clientBundle } from '../tsdown.client.ts'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = clientBundle(import.meta.dirname, ['lib/types/index.js'])

export default ((options) => bundle(options).map(config => ({
  ...config,
  plugins: [{
    name: 'account-onboarding-assets',
    resolveId(source: string) {
      if (!/^\.\/assets\/[^/]+\.(?:svg|png|webp)(\?raw)?$/.test(source)) return null
      const url = new URL(`./src/client/assets/${basename(source)}`, import.meta.url)
      return fileURLToPath(url) + url.search
    },
    async load(id: string) {
      if (!/\/ui-settings-account\/src\/client\/assets\/[^/]+\.(?:svg|png|webp)(\?raw)?$/.test(id.replaceAll('\\', '/'))) return null
      const path = id.replace(/\?raw$/, '')
      this.addWatchFile(path)
      const data = await readFile(path)
      const assetBase = process.env.DSH_ACCOUNT_ASSET_BASE
      if ((/\.(?:png|webp)$/.test(path)) && assetBase !== undefined && !id.endsWith('?raw')) {
        if (!assetBase.startsWith('/') || !assetBase.endsWith('/')) throw new Error('Account asset base must be an absolute URL path ending in a slash')
        const name = `${createHash('sha256').update(data).digest('hex').slice(0, 12)}-${basename(path)}`
        this.emitFile({ type: 'asset', fileName: `assets/${name}`, source: data })
        return `export default ${JSON.stringify(assetBase + name)}`
      }
      if (id.endsWith('?raw')) return `export default ${JSON.stringify(data.toString('utf8'))}`
      return `export default ${JSON.stringify(`data:${path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/svg+xml'};base64,${data.toString('base64')}`)}`
    },
  }, ...(config.plugins ?? [])],
}))) satisfies typeof bundle
