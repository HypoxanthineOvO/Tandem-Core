import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

/** Recover human inputs claimed by the latest failed turn but never admitted to a model request.
 * @param events - Durable session history, including inbox splices.
 * @returns Original messages not already pending, preserving their content and attachments.
 */
export function failedInputs(events: ReturnType<Session['snapshotEvents']>): UserMessage[] {
  const queues: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  const claimed = new Map<string, UserMessage>()
  let failed = false
  for (const event of events) {
    if (event.type === 'turn/start') { claimed.clear(); failed = false }
    if (event.type === 'agent/inbox/spliced') {
      const splice = event.data
      const removed = queues[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
      if (splice.outcome !== 'canceled') {
        for (const message of removed) if (message.source.kind === 'user') claimed.set(message.id, message)
      } else {
        for (const message of removed) claimed.delete(message.id)
      }
    }
    if (event.type === 'user/message') claimed.delete(event.data.id)
    if (event.type === 'turn/end') failed = event.data.reason.kind === 'error' || event.data.reason.kind === 'interrupted'
  }
  if (!failed) return []
  const pending = new Set([...queues['next-turn'], ...queues['next-step']].map(message => message.id))
  return [...claimed.values()].filter(message => !pending.has(message.id))
}
