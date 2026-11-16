import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { failedInputs } from '../src/failed-input.ts'

function failedSession() {
  const session = Session.create(SessionId('failed-recovery-history'))
  const message = createUserMessage({ content: [{ type: 'text', text: '完整原文\n第二段' }], source: { kind: 'user' } })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  session.append('turn/start', { turn: 1 })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  return { session, message }
}

describe('failed input recovery', () => {
  it('recovers historical preparation failures and does not duplicate a restored queue item', () => {
    const { session, message } = failedSession()
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'unknown', code: 'UNKNOWN_MODEL' } } })
    expect(failedInputs(session.snapshotEvents())).toEqual([message])
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    expect(failedInputs(session.snapshotEvents())).toEqual([])
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    expect(failedInputs(session.snapshotEvents())).toEqual([])
  })
  it('does not replay a message already admitted before the provider fails', () => {
    const { session, message } = failedSession()
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'offline', code: 'NETWORK_ERROR' } } })
    expect(failedInputs(session.snapshotEvents())).toEqual([])
  })
  it('does not resurrect input after an explicit user cancellation', () => {
    const { session } = failedSession()
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(failedInputs(session.snapshotEvents())).toEqual([])
  })
})
