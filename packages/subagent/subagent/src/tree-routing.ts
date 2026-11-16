/** Durable parent-chain and name resolution for tree messaging.
 * @module @deepseek-ai/dsh-subagent/tree-routing
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentTargetResolution } from './control-types.ts'
import { foldSubagentDescriptor } from './descriptor.ts'
import type { ContinuableSubagentDescriptorData } from './descriptor.ts'
import { listDescendants } from './list-children.ts'
import { SubagentError } from './error.ts'

/** Detached restoration data, read only from the node's own persisted history. */
export interface TreeNode {
  readonly id: SessionId
  readonly parentId: SessionId | undefined
  readonly label: string
  readonly depth: number
  readonly preset: string | undefined
  readonly descriptor: ContinuableSubagentDescriptorData | undefined
}

function node(header: SessionHeader, events: readonly SessionEvent[], inherited: number): TreeNode {
  const own = events.slice(inherited)
  const descriptor = foldSubagentDescriptor(own)
  let preset: string | undefined
  for (const event of own) {
    if (event.type === 'subagent/descriptor') break
    if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
  }
  return {
    id: header.id, parentId: header.origin === 'subagent' ? header.parentSession : undefined, depth: header.delegationDepth ?? 0,
    label: descriptor?.label ?? header.id, preset,
    descriptor: descriptor?.mode === 'continuable' ? descriptor : undefined,
  }
}

/**
 * Read the exact durable chain; a missing or cyclic ancestor rejects, never becomes a root.
 * @param ctx - live registry and detached query owner.
 * @param id - addressed node.
 * @param signal - caller cancellation.
 * @returns root-first detached chain.
 */
export async function treePath(ctx: Context, id: SessionId, signal: AbortSignal): Promise<TreeNode[]> {
  const path: TreeNode[] = []
  const seen = new Set<SessionId>()
  let next: SessionId | undefined = id
  while (next !== undefined) {
    signal.throwIfAborted()
    if (seen.has(next)) throw new SubagentError('cyclic subagent parent chain', 'NOT_RESUMABLE')
    seen.add(next)
    const live = ctx.get('agents')?.get(next)?.session
    let entry: TreeNode
    if (live !== undefined) entry = node(live.header, live.snapshotEvents(), live.inheritedEventCount)
    else {
      const query = ctx.get('sessionQuery')
      if (query === undefined) throw new SubagentError('tree messaging requires session query for cold nodes', 'CONTINUATION_UNAVAILABLE')
      try {
        using observation = await query.observeSession(next, { signal })
        entry = node(observation.header, observation.events, observation.inheritedEventCount)
      } catch (error: unknown) {
        signal.throwIfAborted()
        throw new SubagentError(`agent "${next}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
      }
    }
    path.unshift(entry)
    next = entry.parentId
  }
  return path
}

/**
 * Resolve reserved names, exact ids, then unique labels inside the caller's real tree.
 * @param ctx - discovery and query services.
 * @param sender - exact live caller.
 * @param target - reserved name, id, or label.
 * @param signal - caller cancellation.
 * @returns explicit resolution or candidates with root-first name segments.
 */
export async function resolveTreeTarget(ctx: Context, sender: Agent, target: string, signal: AbortSignal): Promise<SubagentTargetResolution> {
  if (ctx.get('agents')?.get(sender.id) !== sender) throw new SubagentError('target resolution requires the exact live sender', 'UNAUTHORIZED')
  const path = await treePath(ctx, sender.id, signal)
  const root = path[0]!
  const reserved = target === 'self' ? sender.id : target === 'main' ? root.id
    : target === 'parent' ? sender.session.header.parentSession : undefined
  if (target === 'parent' && reserved === undefined) return { kind: 'not-found', target }
  const candidate = reserved ?? brandString<SessionId>(target)
  try {
    const exact = await treePath(ctx, candidate, signal)
    if (exact[0]!.id !== root.id) return { kind: 'outside-tree', target }
    const leaf = exact.at(-1)!
    return leaf.parentId !== undefined && leaf.descriptor === undefined
      ? { kind: 'not-continuable', target } : { kind: 'resolved', id: leaf.id }
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (!(error instanceof SubagentError) || error.code !== 'NOT_RESUMABLE') throw error
  }
  const rows = await listDescendants(ctx, root.id, signal)
  const matches = rows.filter(row => row.kind === 'child' && row.label === target)
  if (matches.length === 0) return { kind: 'not-found', target }
  if (matches.length === 1) {
    const row = matches[0]!
    return row.kind === 'child' && row.mode === 'continuable'
      ? { kind: 'resolved', id: row.id } : { kind: 'not-continuable', target }
  }
  const candidates = await Promise.all(matches.map(async row => ({
    id: row.id, path: (await treePath(ctx, row.id, signal)).map(entry => entry.label),
  })))
  return { kind: 'ambiguous', candidates }
}
