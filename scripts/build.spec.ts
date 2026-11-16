import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { buildGates, parseBuildArguments } from './build.ts'

const root = resolve(import.meta.dirname, '..')

const artifactGraph = {
  'native': [],
  'host-src': ['native'],
  'host-bundle': ['host-src'],
  'host-runtime-smoke': ['host-bundle'],
  'desktop-bundle': ['host-bundle'],
  'client-src': ['desktop-bundle'],
  'client-bundle': ['client-src'],
  'web': ['client-bundle'],
}

function graph(gates: ReturnType<typeof buildGates>): Record<string, string[] | undefined> {
  return Object.fromEntries(gates.map(gate => [gate.id, gate.needs]))
}

describe('repository build CLI', () => {
  // The sentinel makes parseArgs fail fast if the check ever stops running first.
  it('rejects a Node process without TypeScript type stripping before any build step', () => {
    const result = spawnSync(
      process.execPath,
      ['--no-experimental-strip-types', '--import', 'tsx/esm', resolve(root, 'scripts/build.ts'), '--spec-sentinel'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('build: Node.js TypeScript type stripping is unavailable')
  })

  it('rejects the removed artifacts-only flag before any build step', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', resolve(root, 'scripts/build.ts'), '--artifacts-only'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Unknown option '--artifacts-only'")
  })

  it('selects the complete build by default and one step set by scope', () => {
    expect(parseBuildArguments([])).toEqual({ scope: 'complete', profile: undefined })
    expect(parseBuildArguments(['--scope', 'artifacts', '--profile', 'official'])).toEqual({ scope: 'artifacts', profile: 'official' })
    expect(parseBuildArguments(['--scope', 'check'])).toEqual({ scope: 'check', profile: undefined })
    expect(parseBuildArguments(['--scope', 'typecheck'])).toEqual({ scope: 'typecheck', profile: undefined })
  })

  it.each([
    [['--scope', 'complete'], '--scope must be artifacts, check, or typecheck'],
    [['--scope', 'lib'], '--scope must be artifacts, check, or typecheck'],
    [['--scope', 'check', '--profile', 'official'], '--profile selects artifact values and does not apply to --scope check'],
    [['--scope', 'typecheck', '--profile', 'official'], '--profile selects artifact values and does not apply to --scope typecheck'],
  ])('rejects %j', (args, message) => {
    expect(() => parseBuildArguments(args)).toThrow(message)
  })
})

describe('repository build steps', () => {
  it('keeps artifact steps in serial dependency order', () => {
    expect(graph(buildGates(root, 'artifacts'))).toEqual(artifactGraph)
  })

  it('checks both aggregate programs without artifact predecessors', () => {
    const gates = buildGates(root, 'check')
    expect(graph(gates)).toEqual({ 'host-check': [], 'client-check': [] })
    expect(gates.map(gate => gate.args.slice(-2))).toEqual([
      ['-p', 'tsconfig.host.json'],
      ['-p', 'tsconfig.client.json'],
    ])
  })

  it('starts each aggregate check after its own package compilation in the complete build', () => {
    expect(graph(buildGates(root, 'complete'))).toEqual({
      ...artifactGraph,
      'host-check': ['host-src'],
      'client-check': ['client-src'],
    })
  })

  it('type-checks every program with the source-only Typert pass beside Host compilation', () => {
    const gates = buildGates(root, 'typecheck')
    expect(graph(gates)).toEqual({
      'host-src': [],
      'host-typert': [],
      'client-src': ['host-src', 'host-typert'],
      'host-check': ['host-src'],
      'client-check': ['client-src'],
    })
    expect(gates.find(gate => gate.id === 'host-typert')?.args.at(-1)).toBe(resolve(root, 'scripts/generate-typert.ts'))
    expect(gates.filter(gate => gate.id.endsWith('-check')).map(gate => gate.args.slice(-2))).toEqual([
      ['-b', 'tsconfig.host.json'],
      ['-b', 'tsconfig.client.json'],
    ])
  })

  it('applies the environment overlay and removes Node loader hooks only from the plain import smoke', () => {
    const environment = { DSH_CLIENT_TITLE: 'Title', DSH_BUILD_CLIENT_PROFILE: undefined, NODE_OPTIONS: '--import=tsx/esm' }
    for (const gate of buildGates(root, 'complete', environment)) {
      expect(gate.env).toEqual(gate.id === 'host-runtime-smoke' ? { ...environment, NODE_OPTIONS: undefined } : environment)
    }
  })
})

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-built-continuity-'))
  try {
    for (const face of ['host', 'client']) writeFileSync(join(directory, `tsconfig.${face}.json`), JSON.stringify({ compilerOptions: { noEmit: true }, files: [], references: [{ path: './leaf' }] }))
    mkdirSync(join(directory, 'leaf'))
    writeFileSync(join(directory, 'leaf/tsconfig.json'), '{"compilerOptions":{"composite":true},"files":["index.ts"]}')
    writeFileSync(join(directory, 'leaf/index.ts'), 'export {}')
    run(directory)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

function artifactFixture(directory: string, missing?: string): void {
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}')
  for (const name of ['continuity/continuity', 'subagent/subagent', 'compaction/compaction-basic']) {
    if (name === missing) continue
    const output = join(directory, 'packages', name, 'lib')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'index.js'), 'export const loaded = true\n')
  }
}

function runImportSmoke(directory: string) {
  const gate = buildGates(directory, 'artifacts').find(gate => gate.id === 'host-runtime-smoke')!
  return spawnSync(gate.command, gate.args, { cwd: directory, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--import=missing-test-loader', ...gate.env }, timeout: 10_000 })
}

describe('plain Node artifact import smoke', () => {
  it('loads built entries without TypeScript stripping or inherited loader hooks', () => withDirectory(directory => {
    artifactFixture(directory)
    const result = runImportSmoke(directory)
    expect(result.status, result.stderr).toBe(0)
  }))

  it('rejects a missing artifact corpus instead of skipping it', () => withDirectory(directory => {
    const result = runImportSmoke(directory)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND')
  }))

  it.each(['continuity/continuity', 'subagent/subagent', 'compaction/compaction-basic'])('requires the %s artifact', missing => withDirectory(directory => {
    artifactFixture(directory, missing)
    const result = runImportSmoke(directory)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND')
  }))

  it.each(['export const value: number = 1', 'export class Value { constructor(readonly code: string) {} }'])('rejects an artifact reaching TypeScript source: %s', source => withDirectory(directory => {
    artifactFixture(directory)
    const sourceDir = join(directory, 'packages/continuity/continuity/src')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'pending.ts'), source)
    writeFileSync(join(directory, 'packages/continuity/continuity/lib/index.js'), 'export * from "../src/pending.ts"')
    const result = runImportSmoke(directory)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/)
  }))
})

describe('continuity erasable source compiler gate', () => {
  it.each([
    ['explicit fields', 'export class Value { readonly code: string; constructor(code: string) { this.code = code } }', false],
    ['ambient namespace', 'declare namespace Types { interface Value { code: string } }; export {}', false],
    ['parameter properties', 'export class Value { constructor(readonly code: string) {} }', true],
    ['enum', 'export enum Value { One = 1 }', true],
    ['value namespace', 'export namespace Value { export const one = 1 }', true],
  ])('checks %s with the package compiler setting', (_name, source, rejected) => withDirectory(directory => {
    const config = ts.getParsedCommandLineOfConfigFile(resolve(root, 'packages/continuity/continuity/tsconfig.json'), {}, {
      ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) },
    })
    if (config?.options.erasableSyntaxOnly !== true) throw new Error('continuity must enable erasableSyntaxOnly')
    const input = join(directory, 'fixture.ts')
    writeFileSync(input, String(source))
    const program = ts.createProgram([input], { erasableSyntaxOnly: config.options.erasableSyntaxOnly, noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext })
    const failures = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.code === 1294)
    expect(failures.length > 0).toBe(rejected)
  }))
})
