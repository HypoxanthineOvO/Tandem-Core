/** ui-subagent browser half: continuity surface registration. */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContinuityStatus } from '@deepseek-ai/dsh-subagent/continuity-types'
import { BringBackButton, type BringBackInjected } from '../src/client/continuity/BringBackButton.tsx'
import { ContinuityPendingDock, type ContinuityPendingInjected } from '../src/client/continuity/ContinuityPendingDock.tsx'
import { ContinuityReceiptRow } from '../src/client/continuity/ContinuityReceiptRow.tsx'
import { ContinuitySyncedRow } from '../src/client/continuity/ContinuitySyncedRow.tsx'
import { ledgerIndexDefinition, syncedDefinition } from '../src/client/continuity/synced-definition.ts'
import { BRING_BACK_COMMAND } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

const MAIN = 'main-session' as SessionId

/** Resolve a session-scoped inject face the registry types as an erased factory. */
function resolveFace<T>(entry: { inject?: ((...args: never[]) => Record<string, unknown>) | undefined }): (sessionId: SessionId) => T {
  const face = entry.inject
  if (face === undefined) throw new Error('registration has no inject face')
  return face as NonNullable<typeof face> & ((sessionId: SessionId) => T)
}

const ok = <T,>(value: T) => ({ ok: true as const, value })

function status(over: Partial<ContinuityStatus> = {}): ContinuityStatus {
  return { enabled: false, ledgerRev: 0, pendingCount: 0, pendingWakeCount: 0, ...over }
}

async function bench(withSubagents: boolean) {
  const ctx = new Context()
  const registered: unknown[] = []
  const bindings = new Map<SessionId, { session: { prompt: ReturnType<typeof vi.fn> } }>()
  const subagents = {
    continuityStatus: vi.fn(async (_request?: { sessionId: SessionId }) => ok(status())),
    continuityPending: vi.fn(async (_limit?: number, _request?: { sessionId: SessionId }) => ok([])),
    continuityProcessNow: vi.fn(async (_request: { requestId: string; sessionId?: SessionId }) =>
      ok({ accepted: false, disposition: 'empty' as const })),
  }
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({}), subscribe: () => () => {} },
    binding: (sessionId: SessionId) => bindings.get(sessionId),
  } as never)
  ctx.provide('uiWorkspace', {} as never)
  ctx.provide('sidebarRight', {} as never)
  class FakeRemote extends Service {
    constructor(scope: Context) { super(scope, 'remote') }
    $on = () => () => {}
  }
  await ctx.plugin(FakeRemote)
  if (withSubagents) await ctx.plugin({ apply(child: Context) { child.provide('remote.subagents', subagents as never) } })
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  ctx.provide('uiConversation', { events: { register: (definition: unknown) => { registered.push(definition) } } } as never)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, registered, subagents, bindings, fiber }
}

describe('continuity registration', () => {
  it('registers the pending strip, the branch action, the synced row, the receipt view, and both Definitions', async () => {
    const { ctx, registered, subagents, fiber } = await bench(true)
    expect(registered).toEqual([ledgerIndexDefinition, syncedDefinition])
    const dock = ctx.slots.entries('conversation.input.dock').find(entry => entry.component === ContinuityPendingDock)!
    expect(dock.options.id).toBe('continuity-pending')
    expect(dock.options.order).toBe(10)
    expect(ctx.slots.entries('conversation.input.right').some(entry => entry.component === BringBackButton)).toBe(true)
    expect(ctx.slots.entries('conversation.chat.node').some(entry => entry.component === ContinuitySyncedRow)).toBe(true)
    const receipt = ctx.slots.entries('tool.call.toolview').find(entry => entry.component === ContinuityReceiptRow)!
    expect((receipt.options as { key?: string }).key).toBe('continuity_commit')

    const face = resolveFace<ContinuityPendingInjected>(dock)(MAIN)
    face.processNow()
    await vi.waitFor(() => { expect(subagents.continuityProcessNow).toHaveBeenCalledOnce() })
    const unsubscribe = face.hooks.continuityPending.subscribe(() => {})
    await vi.waitFor(() => { expect(subagents.continuityStatus).toHaveBeenCalled() })
    const calls = subagents.continuityStatus.mock.calls.length
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(subagents.continuityStatus.mock.calls.length).toBeGreaterThan(calls) })
    unsubscribe()
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.input.dock')).toEqual([])
    expect(ctx.slots.entries('conversation.input.right')).toEqual([])
  })

  it('sends the bring-back phrase through the bound Session face', async () => {
    const { ctx, subagents, bindings, fiber } = await bench(true)
    const prompt = vi.fn(async () => ok({ accepted: true as const }))
    bindings.set(MAIN, { session: { prompt } })
    subagents.continuityStatus.mockResolvedValue(ok(status({
      enabled: true, mainSessionId: 'main-owner' as SessionId, branchSessionId: MAIN, ledgerRev: 2,
    })) as never)
    try {
      const entry = ctx.slots.entries('conversation.input.right').find(entry => entry.component === BringBackButton)!
      const face = resolveFace<BringBackInjected>(entry)(MAIN)
      const unsubscribe = face.hooks.continuityPending.subscribe(() => {})
      await vi.waitFor(() => {
        expect(face.hooks.continuityPending.getSnapshot().role).toBe('branch')
      })
      await face.bringBack()
      expect(prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: BRING_BACK_COMMAND }], 'queue')
      unsubscribe()
    } finally {
      await fiber.dispose()
    }
  })

  it('reports an unavailable Session binding instead of dropping the phrase', async () => {
    const { ctx, fiber } = await bench(true)
    try {
      const entry = ctx.slots.entries('conversation.input.right').find(entry => entry.component === BringBackButton)!
      const face = resolveFace<BringBackInjected>(entry)(MAIN)
      await expect(face.bringBack()).rejects.toThrow('session-binding-unavailable')
    } finally {
      await fiber.dispose()
    }
  })

  it('surfaces the Host refusal of the phrase send', async () => {
    const { ctx, bindings, fiber } = await bench(true)
    const prompt = vi.fn(async () => ({ ok: false as const, error: { code: 'subagent/busy', message: '会话忙碌' } }))
    bindings.set(MAIN, { session: { prompt } })
    try {
      const entry = ctx.slots.entries('conversation.input.right').find(entry => entry.component === BringBackButton)!
      const face = resolveFace<BringBackInjected>(entry)(MAIN)
      await expect(face.bringBack()).rejects.toThrow('会话忙碌')
    } finally {
      await fiber.dispose()
    }
  })

  it('leaves continuity unregistered without the subagents Remote', async () => {
    const { ctx, registered } = await bench(false)
    expect(registered).toEqual([])
    expect(ctx.slots.entries('conversation.input.dock')).toEqual([])
    expect(ctx.slots.entries('conversation.input.right')).toEqual([])
  })
})
