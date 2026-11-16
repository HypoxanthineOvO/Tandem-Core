import { existsSync } from 'node:fs'

// Release archives have no Git checkout or development hook dependency.
if (existsSync(new URL('../.git', import.meta.url)) && existsSync(new URL('../node_modules/lefthook/package.json', import.meta.url))) {
  await import('./install-lefthook.mjs')
}
