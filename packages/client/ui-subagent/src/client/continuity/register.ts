/**
 * Continuity presentation: the main-line pending strip, the "synced" Chat row,
 * the branch receipt for `continuity_commit` calls, and the branch button that
 * asks for a decision bring-back.
 *
 * Every surface is addressed by its own Session, so several managed branches
 * and main lines can be open at once without sharing an answer.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { BRING_BACK_COMMAND, NS } from '../locales.ts'
import { BringBackButton, type BringBackInjected } from './BringBackButton.tsx'
import { ContinuityPendingDock, type ContinuityPendingInjected } from './ContinuityPendingDock.tsx'
import { CONTINUITY_COMMIT_TOOL, ContinuityReceiptRow } from './ContinuityReceiptRow.tsx'
import { ContinuitySyncedRow } from './ContinuitySyncedRow.tsx'
import { ContinuityPendingSource } from './pending-source.ts'
import { ledgerIndexDefinition, syncedDefinition } from './synced-definition.ts'

/**
 * Send the branch's bring-back phrase as the user's own message; the branch
 * model then lays out the decisions and the user confirms them. The Session
 * face is reached through the already-injected `sessions` service rather than
 * the scope-addressed `conversation` service, which this plugin does not
 * declare and which a real Loader composition therefore refuses.
 * @param ctx - client scope owning the session bindings.
 * @param sessionId - the addressed managed branch.
 * @returns completion after the Host admits the message.
 */
async function sendBringBack(ctx: ClientContext, sessionId: SessionId): Promise<void> {
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) throw new Error('session-binding-unavailable')
  const result = await binding.session.prompt([{ type: 'text', text: BRING_BACK_COMMAND }], 'queue')
  if (!result.ok) throw new Error(result.error.message)
}

/**
 * Register every continuity surface for the caller's lifetime. Requires the
 * `subagents` Remote, the Session bindings, the Conversation registries, and
 * the slots service.
 * @param ctx - client scope holding `remote.subagents`, `sessions`, `uiConversation`, and `slots`.
 */
export function registerContinuity(ctx: ClientContext): void {
  const sources = new Map<SessionId, ContinuityPendingSource>()
  const sourceOf = (sessionId: SessionId): ContinuityPendingSource => {
    const existing = sources.get(sessionId)
    if (existing !== undefined) return existing
    const created = new ContinuityPendingSource(ctx.remote.subagents, sessionId)
    sources.set(sessionId, created)
    return created
  }
  ctx.effect(() => () => {
    for (const source of sources.values()) source.dispose()
    sources.clear()
  }, 'ui-subagent: continuity sources')
  ctx.on('connection/reset', () => {
    for (const source of sources.values()) source.reset()
  })
  ctx.uiConversation.events.register(ledgerIndexDefinition)
  ctx.uiConversation.events.register(syncedDefinition)
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'continuity-pending',
    // After the todo strip (0): the plan stays nearest the conversation.
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): ContinuityPendingInjected => {
      const source = sourceOf(sessionId)
      return {
        hooks: { continuityPending: source.state },
        processNow: () => { void source.processNow() },
      }
    },
  }, ContinuityPendingDock))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'continuity-bring-back',
    // Before the single-occupant model seat: the action sits with the send side.
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): BringBackInjected => {
      const source = sourceOf(sessionId)
      return {
        hooks: { continuityPending: source.state },
        bringBack: async () => { await sendBringBack(ctx, sessionId) },
      }
    },
  }, BringBackButton))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'continuity-synced',
    locale: NS,
  }, ContinuitySyncedRow))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: CONTINUITY_COMMIT_TOOL,
    locale: NS,
  }, ContinuityReceiptRow))
}
