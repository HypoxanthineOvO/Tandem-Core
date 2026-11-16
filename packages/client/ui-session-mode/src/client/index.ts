/**
 * Composer control for the durable conversational mode: one chip in the
 * composer tool row that shows the current mode and switches it over the
 * `sessionMode` Remote. The chip is display-only over the projection; the
 * Host appends the model-visible notification on the next admitted request.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionMode } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ctx.remote merge and the generated `sessionMode` namespace.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-renderer SlotRegistry merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SessionModeChip, type SessionModeInjected } from './SessionModeControl.tsx'
import { en, NS, zh, type SessionModeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Composer mode-chip copy. */
    'sessionMode': SessionModeKey
  }
}

/** Required services: the session-mode Remote and the composer control seat. */
export const inject = ['slots', 'remote', 'remote.sessionMode', 'locale']

/**
 * Register the persistent-mode chip into the composer tool row.
 * @param ctx - Client plugin context owning the dictionary and the seat.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-mode: dictionaries')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'session-mode',
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): SessionModeInjected => ({
      setMode: async (mode: SessionMode): Promise<void> => {
        const result = await ctx.remote.sessionMode.set({ sessionId, mode })
        if (!result.ok) throw new Error(result.error.message)
      },
    }),
  }, SessionModeChip))
}
