/** Web subagent catalog, navigation, and addressed-session composer owner. */
import type { Context as ClientContext, Fiber } from '@deepseek-ai/cordis'
import type { HeaderPresentationSettings } from '../index.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SubagentCatalogAction, SubagentHeaderLineage, type SubagentCatalogInjected } from './SubagentHeaderLineage.tsx'
import {
  SubagentReadOnlyComposer, type SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'
import { registerSidebarChat, subagentChatAddress } from './sidebar-chat/index.tsx'
import { registerContinuity } from './continuity/register.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { en, NS, zh, type SubagentKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Subagent catalog and read-only composer copy. */
    'subagent': SubagentKey
  }
}

export type {
  SubagentCatalogActionProps, SubagentCatalogInjected, SubagentHeaderLineageProps,
} from './SubagentHeaderLineage.tsx'
export type {
  SubagentReadOnlyComposerProps, SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'

/** Required services for subagent presentation and navigation. */
export const inject = ['sessions', 'uiWorkspace', 'slots', 'locale', 'sidebarRight', 'configForms']

/** Claim the composer for one-shot history or an unavailable continuation owner. */
function selectReadOnlySubagent(owner: ComposerChainProps): SubagentReadOnlyMatch | null {
  const subagent = owner.session?.subagent
  if (subagent === undefined || subagent === null) return null
  if (subagent.address.mode === 'unknown') return { reason: 'unknown' }
  if (subagent.address.mode === 'one-shot') return { reason: 'one-shot' }
  // Until a Host summary establishes parent availability, keep the normal
  // disabled composer instead of claiming that the parent is offline.
  if (subagent.parentAvailable !== false) return null
  // A RUNNING parent-offline continuable child keeps the default composer:
  // its input is disabled there, but the same primary Stop stays available so
  // the child can be interrupted. Once it stops, this takeover returns.
  return owner.session?.running === true ? null : { reason: 'parent-unavailable' }
}

/**
 * Client plugin body: register the subagent catalog and read-only composer seats.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-subagent: dictionaries')
  ctx.inject(['resources', 'sidebarRightTabs'], (scope) => {
    registerSidebarChat(scope, ctx.locale.bind(NS))
  })
  // A composition without the subagents Remote or a Conversation shell simply
  // leaves the continuity surfaces unregistered.
  ctx.inject(['remote', 'remote.subagents', 'sessions', 'uiConversation'], (scope) => {
    registerContinuity(scope)
  })
  const catalogActions = (_parentSessionId: SessionId): SubagentCatalogInjected => ({
    openChild(address: SubagentAddress) {
      ctx.uiWorkspace.openSession(address)
    },
    openChildAside(address: SubagentAddress) {
      ctx.sidebarRight.openResource(subagentChatAddress(address), {
        kind: 'subagentchat',
        preferNewPane: true,
      })
    },
    refreshProjection(parentSessionId: SessionId) {
      void ctx.sessions.refreshProjections(parentSessionId)
    },
  })
  // Host Loader config is not part of the browser module graph. Settings owns
  // the validated deployment values and their invalidation feed.
  const presentation = ctx.configForms.get<HeaderPresentationSettings>('ui-subagent')
  let headerFiber: Fiber | undefined
  const syncHeader = (): void => {
    const snapshot = presentation.getSnapshot()
    if (snapshot.status === 'loading') return
    const visible = snapshot.value?.headerPresentation !== 'none'
    if (!visible) {
      void headerFiber?.dispose()
      headerFiber = undefined
      return
    }
    if (headerFiber !== undefined) return
    headerFiber = ctx.plugin((header: ClientContext) => {
      header.slots.inject(
        'conversation.session.header.lineage',
        () => header.slots.register({
          name: 'conversation.session.header.lineage',
          locale: NS,
          inject: catalogActions,
        }, SubagentHeaderLineage),
      )
      header.slots.inject(
        'conversation.session.header.actions',
        () => header.slots.register({
          name: 'conversation.session.header.actions',
          id: 'subagent-catalog',
          // Between the preset label (-10) and background tasks (20), after Team
          // navigation (-20).
          order: 10,
          locale: NS,
          inject: catalogActions,
        }, SubagentCatalogAction),
      )
    })
  }
  ctx.effect(() => presentation.subscribe(syncHeader), 'ui-subagent: header presentation')
  syncHeader()
  ctx.slots.inject(
    'conversation.composer',
    () => ctx.slots.register({
      name: 'conversation.composer',
      priority: -10,
      locale: NS,
      select: selectReadOnlySubagent,
    }, SubagentReadOnlyComposer),
  )
}
