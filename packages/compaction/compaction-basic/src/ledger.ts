/**
 * Deterministic continuity-ledger compaction strategy.
 *
 * Replaces the selected history span with the ledger fixed area rendered from
 * the same session's `continuity/transaction` events. No model call is made;
 * the compaction summary records the deterministic renderer identity instead.
 *
 * @module @deepseek-ai/dsh-compaction-basic/ledger
 */

import type { Context } from '@deepseek-ai/cordis'
import { foldLedgerEvents, renderFixedArea } from '@deepseek-ai/dsh-continuity'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { compactSurfaceRegion, selectCompactableRange } from './region.ts'
import type { SummaryResult, SummarizationInput } from './summarizer.ts'
import { BasicCompactionEngine } from './index.ts'
import type { BasicCompactionConfig } from './index.ts'

/** Whether one session already carries continuity ledger transactions. */
export function sessionHasLedger(session: Session): boolean {
  return ledgerOf(session).rev > 0
}

/** Fold the continuity ledger from one session's ordered event log. */
export function ledgerOf(session: Session): ReturnType<typeof foldLedgerEvents> {
  // Existing Session history read; migration deferred.
  // oxlint-disable-next-line typescript/no-deprecated
  return foldLedgerEvents(session.header.id, session.snapshotEvents(), session.header.parentSession)
}

/**
 * Compaction backend that renders the continuity fixed area instead of calling
 * a summarizer. Load it in place of `BasicCompactionEngine` for a main-line
 * continuity session; a session without ledger transactions fails loud rather
 * than being summarized through this strategy.
 */
export class LedgerCompactionEngine extends BasicCompactionEngine {
  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx, config)
  }

  /** Include any earlier ledger checkpoint so the new fixed area replaces it. */
  protected override selectRange(
    session: Session,
    measurement: TokenMeasurement,
    retainTokens: number,
  ): { start: SessionSeq; end: SessionSeq } | null {
    return selectCompactableRange(session, measurement, retainTokens, true)
  }

  /** Render the fixed area deterministically; never call a model. */
  protected override async summarize(
    _input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    signal?.throwIfAborted()
    const ledger = ledgerOf(agent.session)
    if (ledger.rev === 0) {
      throw new Error('ledger compaction requires at least one committed continuity transaction')
    }
    const fixed = renderFixedArea(ledger, { tokenBudget: this.config.ledgerFixedAreaTokens })
    const summary: ContentBlock[] = [{ type: 'text', text: fixed.text }]
    return { summary, provider: 'dsh-continuity', model: 'fixed-area-renderer-1', rawOutput: summary }
  }

  /** Mark the replacement checkpoint as the protected ledger fixed area. */
  protected override regionDependencies(): Parameters<typeof compactSurfaceRegion>[0] {
    return { ...super.regionDependencies(), checkpointStrategy: () => true }
  }
}
