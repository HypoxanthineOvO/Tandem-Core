/** Install and probe a target archive in an owned temporary directory. */
import { mkdtemp, readdir, lstat, readFile, rm, writeFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'

const archive = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('usage: node smoke-core.mjs <archive> [report.json]')
const archiveName = basename(archive)
const checksum = (await readFile(`${archive}.sha256`, 'utf8')).split(/\s/)[0]
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== checksum) throw new Error('Archive checksum mismatch')
const pnpmEntry = process.env.TANDEM_PNPM_ENTRY ?? resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/pnpm/bin/pnpm.cjs')
const temporary = await mkdtemp(join(tmpdir(), 'tandem-core-smoke-'))
let server
let closed
let result
try {
  await run('tar', ['-xzf', archive, '-C', temporary])
  const roots = await readdir(temporary)
  if (roots.length !== 1) throw new Error('Archive must contain one installation directory')
  const installation = join(temporary, roots[0])
  const manifest = JSON.parse(await readFile(join(installation, 'tandem-install.json'), 'utf8'))
  if (manifest.target !== targetFromName(archiveName)) throw new Error('Archive target does not match tandem-install.json')
  if (manifest.nodeMajor !== Number(process.versions.node.split('.')[0])) throw new Error('Unsupported Node major version')
  const started = performance.now()
  const installLog = await run(process.execPath, [pnpmEntry, ...manifest.installArgs], installation)
  for (const step of manifest.postInstall) await run(step.command === 'node' ? process.execPath : step.command, step.args, installation)
  const installSeconds = Number(((performance.now() - started) / 1000).toFixed(2))
  const storePackages = await readdir(join(installation, 'node_modules/.pnpm'))
  const electronPackages = storePackages.filter(name => name.startsWith('electron@'))
  const installedBytes = await treeBytes(installation)
  let flock = 'windows-native-locking'
  if (process.platform !== 'win32') {
    const flockEntry = await import(pathToFileURL(join(installation, 'native/system/packages/entry/lib/flock.js')).href)
    const lockFile = await open(join(temporary, 'flock-smoke.lock'), 'a+')
    try { await flockEntry.tryLockExclusive(lockFile.fd); flock = 'acquired' } finally { await lockFile.close() }
  }
  let selectedPort
  for (let port = 3190; port <= 3199; port++) {
    if (await portAvailable(port)) { selectedPort = port; break }
  }
  if (selectedPort === undefined) throw new Error('No free smoke port in 3190-3199')
  server = spawn(process.execPath, ['apps/cli/lib/bin.js', 'web', '--host', '127.0.0.1', '--port', String(selectedPort), '--no-open'], {
    cwd: installation,
    env: { ...process.env, DSH_HOME: join(temporary, 'home'), DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  closed = once(server, 'close')
  let output = ''
  server.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  server.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const origin = `http://127.0.0.1:${selectedPort}`
  let response
  let cookie
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const token = output.match(/\?token=([^\s]+)/)?.[1]
    if (token) {
      const login = await fetch(`${origin}/?token=${token}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
      response = await fetch(`${origin}/`, { headers: cookie ? { cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(5000) })
      if (response.status === 200) break
      throw new Error(`Homepage HTTP ${response.status}`)
    }
    if (server.exitCode !== null) throw new Error(`Web process exited ${server.exitCode}:\n${output}`)
    await delay(250)
  }
  if (response?.status !== 200 || !cookie) throw new Error('Web startup timed out')
  const api = await fetch(`${origin}/api/session/list`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ type: 'client-request', rpcId: 'core-smoke', method: 'session/list', payload: { args: { _request: {} } } }),
  })
  if (api.status !== 200 || (await api.json()).result?.ok !== true) throw new Error('Session list probe failed')
  result = { archive: archiveName, sha256: checksum, platform: process.platform, arch: process.arch, node: process.version, homepage: response.status, api: api.status, port: selectedPort, installSeconds, installedBytes, electronPackages, flock, packageCount: storePackages.length, installOutputTail: installLog.split(/\r?\n/).slice(-10).join('\n') }
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM')
    const stopped = await Promise.race([closed.then(() => true), delay(10_000, false, { ref: false })])
    if (!stopped) { server.kill('SIGKILL'); await closed }
  }
  if (result) result.shutdown = { exitCode: server.exitCode, signal: server.signalCode }
  // Only this invocation's mkdtemp directory is removed, after the server has closed.
  if (dirname(temporary) !== tmpdir() || !basename(temporary).startsWith('tandem-core-smoke-')) throw new Error('Unexpected cleanup path')
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
result.cleaned = true
console.log(JSON.stringify(result, null, 2))
if (process.argv[3]) await writeFile(resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n')

function targetFromName(name) {
  const match = /^tandem-core-0\.1\.0-(.+)\.tar\.gz$/.exec(name)
  if (!match) throw new Error(`Unexpected archive name: ${name}`)
  return match[1]
}
function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun(output) : reject(new Error(`${command} exited ${code}:\n${output}`)))
  })
}
function portAvailable(port) {
  return new Promise(resolvePort => {
    const socket = createServer()
    socket.once('error', () => resolvePort(false))
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolvePort(true)))
  })
}
async function treeBytes(directory) {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(directory, entry.name)
    total += entry.isDirectory() ? await treeBytes(path) : (await lstat(path)).size
  }
  return total
}
