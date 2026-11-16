/**
 * ui-session-mode browser half on a real SlotRegistry: the plugin occupies the
 * composer-declared `conversation.input.left` list with the mode chip, the
 * injected face persists switches through the `sessionMode` Remote, and
 * teardown empties the seat (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionModeChip, type SessionModeInjected } from '../src/client/SessionModeControl.tsx'
import { apply, inject } from '../src/client/index.ts'

const SID = 's-mode' as SessionId

/** Resolve a session-scoped inject face the registry types as an erased factory. */
function resolveFace<T>(entry: { inject?: ((...args: never[]) => Record<string, unknown>) | undefined }): (sessionId: SessionId) => T {
  const face = entry.inject
  if (face === undefined) throw new Error('registration has no inject face')
  return face as NonNullable<typeof face> & ((sessionId: SessionId) => T)
}

async function bench(
  answer: { ok: true; value: { mode: 'work' | 'direct' } } | { ok: false; error: { code: string; message: string } } = {
    ok: true,
    value: { mode: 'work' },
  },
) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: { 'conversation.input.left': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  const set = vi.fn(async () => answer)
  ctx.provide('remote', { sessionMode: { set } } as never)
  ctx.provide('remote.sessionMode', { set } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots, set }
}

describe('ui-session-mode browser apply', () => {
  it('registers the mode chip in the composer tool row', async () => {
    const { ctx, slots, set } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      const entry = slots.entries('conversation.input.left')[0]!
      expect(entry.component).toBe(SessionModeChip)
      expect(entry.options.id).toBe('session-mode')
      expect(entry.options.order).toBe(10)
      await resolveFace<SessionModeInjected>(entry)(SID).setMode('direct')
      expect(set).toHaveBeenCalledExactlyOnceWith({ sessionId: SID, mode: 'direct' })
    } finally {
      await fiber.dispose()
    }
    expect(slots.entries('conversation.input.left')).toHaveLength(0)
  })

  it('reports the Host refusal to the chip', async () => {
    const { ctx, slots } = await bench({
      ok: false,
      error: { code: 'session/not-found', message: '会话不存在' },
    })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      const entry = slots.entries('conversation.input.left')[0]!
      await expect(resolveFace<SessionModeInjected>(entry)(SID).setMode('work')).rejects.toThrow('会话不存在')
    } finally {
      await fiber.dispose()
    }
  })
})
