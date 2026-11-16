/**
 * Browser-side owner of one Session's continuity status: reads the Host's
 * addressed status and pending list through the `subagents` Remote while a
 * component subscribes, and forwards the user's "process now" request.
 *
 * Each open conversation owns one source so the addressed Session never leaks
 * into another main line's or branch's answer.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContinuityPendingItem } from '@deepseek-ai/dsh-subagent/continuity-types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-subagent/remote'

/**
 * Re-read cadence while a continuity surface is mounted. The Host pushes no
 * change event for the pending list or the branch binding, so the source
 * polls; it stops when the last subscriber leaves.
 */
const REFRESH_MS = 3000

/** Pending items shown at most; the header count still reports the full total. */
const PENDING_LIMIT = 20

/** Remote calls this source needs, narrowed from the generated `subagents` namespace. */
export type ContinuityRemote = Pick<
  ClientContext['remote']['subagents'],
  'continuityStatus' | 'continuityPending' | 'continuityProcessNow'
>

/** One pending row as the dock renders it. */
export interface PendingRow {
  readonly id: string
  readonly summary: string
  readonly state: 'delivering' | 'wake' | 'defer' | 'proposal'
}

/** Outcome of the latest "process now" request, shown under the list. */
export type ProcessNowState = 'idle' | 'sending' | 'queued' | 'next-step' | 'empty' | 'failed'

/** Which side of the continuity ledger the addressed Session is. */
export type ContinuityRole = 'main' | 'branch' | 'none'

/** Immutable snapshot published to the continuity surfaces. */
export interface PendingSnapshot {
  /** Main Session this answer belongs to; undefined while disabled or unread. */
  readonly mainSessionId: string | undefined
  /** Whether the addressed Session is the main line, a managed branch, or neither. */
  readonly role: ContinuityRole
  /** Unacknowledged items, including ones already delivered but not yet confirmed. */
  readonly count: number
  readonly rows: readonly PendingRow[]
  readonly processNow: ProcessNowState
}

const EMPTY: PendingSnapshot = {
  mainSessionId: undefined, role: 'none', count: 0, rows: [], processNow: 'idle',
}

function rowOf(item: ContinuityPendingItem): PendingRow {
  const state = item.deliveredAt !== undefined ? 'delivering'
    : item.kind === 'proposal' ? 'proposal'
      : item.mode
  return { id: item.id, summary: item.summary, state }
}

/**
 * Live, Session-addressed continuity projection with an explicit lifetime: the
 * first subscriber starts reading, the last one stops it, and `dispose` ends it
 * for good.
 */
export class ContinuityPendingSource {
  private snapshot: PendingSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private disposed = false

  /** The observable face bound to a continuity surface's hook. */
  readonly state: HostObservable<PendingSnapshot> = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener) => {
      this.listeners.add(listener)
      if (this.listeners.size === 1) this.start()
      return () => {
        this.listeners.delete(listener)
        if (this.listeners.size === 0) this.stop()
      }
    },
  }

  /**
   * @param remote - the `subagents` Remote namespace.
   * @param sessionId - the addressed Session whose status and pending answer this source owns.
   * @param requestId - mints one idempotency key per user request.
   */
  constructor(
    private readonly remote: ContinuityRemote,
    private readonly sessionId: SessionId,
    private readonly requestId: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * Ask the addressed main line to take the pending batch now. A request
   * already in flight is not repeated.
   * @returns after the outcome is published.
   */
  async processNow(): Promise<void> {
    if (this.snapshot.processNow === 'sending') return
    this.publish({ ...this.snapshot, processNow: 'sending' })
    const result = await this.remote.continuityProcessNow({
      requestId: this.requestId(),
      sessionId: this.sessionId,
    })
    if (this.disposed) return
    const processNow: ProcessNowState = !result.ok ? 'failed'
      : result.value.disposition === 'empty' ? 'empty'
        : result.value.disposition === 'next-safe-step' ? 'next-step'
          : 'queued'
    this.publish({ ...this.snapshot, processNow })
    await this.refresh()
  }

  /** Forget the Host's answer after a connection replacement; subscribers re-read. */
  reset(): void {
    this.generation += 1
    this.publish(EMPTY)
    if (this.listeners.size > 0) {
      this.stop()
      this.start()
    }
  }

  /** Stop reading and release every timer. */
  dispose(): void {
    this.disposed = true
    this.stop()
    this.listeners.clear()
  }

  private start(): void {
    void this.refresh().then(() => { this.schedule() })
  }

  private stop(): void {
    this.generation += 1
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (this.disposed || this.listeners.size === 0 || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh().then(() => { this.schedule() })
    }, REFRESH_MS)
  }

  /** Read the addressed status once, then the pending list only for a main line. */
  private async refresh(): Promise<void> {
    const generation = this.generation
    const status = await this.remote.continuityStatus({ sessionId: this.sessionId })
    if (generation !== this.generation || this.disposed) return
    // A failed read keeps the last answer: the surfaces never show transport errors.
    if (!status.ok) return
    const role: ContinuityRole = !status.value.enabled ? 'none'
      : status.value.branchSessionId === this.sessionId ? 'branch'
        : status.value.mainSessionId === this.sessionId ? 'main'
          : 'none'
    // A branch polls only for its role; the main-side pending list is not that
    // Session's presentation.
    if (role !== 'main' || status.value.pendingCount === 0) {
      this.publish({
        mainSessionId: status.value.mainSessionId,
        role,
        count: 0,
        rows: [],
        processNow: this.snapshot.processNow === 'sending' ? 'sending' : 'idle',
      })
      return
    }
    const pending = await this.remote.continuityPending(PENDING_LIMIT, { sessionId: this.sessionId })
    if (generation !== this.generation || this.disposed || !pending.ok) return
    this.publish({
      ...this.snapshot,
      mainSessionId: status.value.mainSessionId,
      role,
      count: status.value.pendingCount,
      rows: pending.value.map(rowOf),
    })
  }

  private publish(next: PendingSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
