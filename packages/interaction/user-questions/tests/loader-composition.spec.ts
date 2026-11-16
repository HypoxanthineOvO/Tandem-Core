/** Loader composition with real JSONL storage and a process-restart answer. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import UserQuestionService, { HumanInteractionPolicy, type HumanInteractionAdmission } from '../src/index.ts'

class Admission extends HumanInteractionPolicy {
  check({ agent }: HumanInteractionAdmission) { return { allowed: agent.id !== SessionId('worker'), reason: 'ask your parent' } }
}

/** A non-driving external caller; all persistence and question services are real. */
function caller(ctx: Context, session: Session): Agent {
  const queued: UserMessage[] = []
  return {
    id: session.id, session, ctx, options: {}, status: 'idle',
    inbox: { nextTurn: [], nextStep: queued, clear() {}, append() {}, prepend() {}, replace: () => false, remove: () => false, splice: () => [] },
    send() {}, followup() {}, inject() {}, cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    steer(message) {
      session.append('agent/inbox/spliced', { target: 'next-step', start: queued.length, inserted: [message] })
      queued.push(message)
    },
  }
}

async function load(root: string, path: string): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['session', SessionStore], ['agents', AgentRegistry], ['projections', SessionProjectionRegistry],
    ['persistence', JsonlPersistence], ['questions', UserQuestionService], ['admission', Admission],
  ])
  const moduleLoader: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    async import(name) {
      if (!modules.has(name)) throw new Error(`unexpected test module ${name}`)
      return modules.get(name)
    },
    register(): never { throw new Error('no HMR in this composition') },
    getOrCreateModuleJob(): never { throw new Error('no module jobs in this composition') },
    resolveSync(): never { throw new Error('no synchronous resolution in this composition') },
    load(): never { throw new Error('no module loading in this composition') },
  }
  ctx.loader.internal = moduleLoader
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  return ctx
}

describe('user questions through Loader and JSONL persistence', () => {
  it('restores staged answers and delivers one accepted batch to the restored child identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-user-questions-loader-'))
    const contexts: Context[] = []
    try {
      const configPath = join(root, 'cordis.yml')
      await writeFile(configPath, [
        '- name: session', '- name: agents', '- name: projections', '- name: persistence',
        '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
        '- name: admission', '- name: questions', '  config:', '    requirePolicy: true', '',
      ].join('\n'))
      const first = await load(root, configPath)
      contexts.push(first)
      const main = caller(first, first.sessions.create(SessionId('main'), { meta: { cwd: root } }))
      const session = first.sessions.create(SessionId('manager'), { meta: { cwd: root, parentSession: main.id } })
      const manager = caller(first, session)
      first.agents.enter(main, undefined)
      first.agents.enter(manager, main)
      const writer = await first.sessionPersistence.create(session.header)
      const callId = ToolCallId('restart-batch')
      session.append('user-question/batch', {
        sessionId: session.id, asker: session.id, callId, createdAt: 1, revision: 0, status: 'open', answers: [],
        questions: [{ id: 'a', question: 'First?' }, { id: 'b', question: 'Second?' }],
      })
      await first.userQuestions.stageAnswer(manager, callId, { id: 'a', selected: [], custom: 'saved' }, 0)
      await writer.close()
      await first.fiber.dispose()
      contexts.pop()

      const second = await load(root, configPath)
      contexts.push(second)
      const reader = await second.sessionPersistence.open(manager.id, 'read')
      const restored = await reader.read()
      await reader.close()
      const secondWriter = await second.sessionPersistence.open(manager.id, 'write')
      const resumeMarker: SessionEvent<'session/end-seed'> = {
        type: 'session/end-seed', seq: SessionSeq(restored.events.length), time: Date.now(), data: {},
      }
      await secondWriter.append([resumeMarker])
      const restoredMain = caller(second, second.sessions.create(main.id, { meta: { cwd: root } }))
      const restoredSession = second.sessions.create(manager.id, { seed: [...restored.events, resumeMarker], meta: { ...session.header } })
      const restoredManager = caller(second, restoredSession)
      second.agents.enter(restoredMain, undefined)
      second.agents.enter(restoredManager, restoredMain)
      expect(second.userQuestions.query(restoredSession)[0]?.answers).toEqual([{ id: 'a', selected: [], custom: 'saved' }])
      await second.userQuestions.stageAnswer(restoredManager, callId, { id: 'b', selected: [] }, 1)
      const receipts = await Promise.all([
        second.userQuestions.submitBatch(restoredManager, callId, { expectedRevision: 2 }),
        second.userQuestions.submitBatch(restoredManager, callId, { expectedRevision: 2 }),
      ])
      expect(receipts.map(receipt => receipt.status)).toEqual(['submitted', 'already-submitted'])
      expect(restoredMain.inbox.nextStep).toHaveLength(0)
      expect(restoredManager.inbox.nextStep).toHaveLength(1)
      const delivered = restoredManager.inbox.nextStep[0]!
      restoredSession.append('user/message', delivered, { surfaceOp: 'append' })
      await second.sessions.flush(restoredSession)
      const verification = await second.sessionPersistence.open(manager.id, 'read')
      const persisted = await verification.read()
      await verification.close()
      expect(persisted.events.filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(1)
      expect(second.userQuestions.listQuestions(restoredSession)).toEqual(expect.arrayContaining([
        expect.objectContaining({ questionId: 'a', status: 'answered', deliveredAt: expect.any(Number) }),
        expect.objectContaining({ questionId: 'b', status: 'skipped', deliveredAt: expect.any(Number) }),
      ]))
      await secondWriter.close()
    } finally {
      await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
      if (dirname(root) !== tmpdir() || !basename(root).startsWith('dsh-user-questions-loader-')) throw new Error('unexpected test root')
      await rm(root, { recursive: true, force: true })
    }
  })
})
