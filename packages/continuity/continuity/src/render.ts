/**
 * Deterministic fixed-area renderer for continuity checkpoints.
 *
 * @module @deepseek-ai/dsh-continuity/render
 */

import { createHash } from 'node:crypto'
import type { ContinuityDecision, FixedArea, LedgerState } from './types.ts'
import { openWorkItems } from './ledger.ts'

/** Fixed text-density estimate shared with the harness token meter. */
export const CHARS_PER_TOKEN = 4

/** Heuristic token price of one rendered text string. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Render the ledger fixed area. Field and record order is sorted, so the same
 * ledger state always renders byte-identical text and hash. An optional token
 * budget first folds the oldest committed decision details to one-line
 * references; goal and constraint fields (`goal.*`, `risk.constraint.*`) stay
 * verbatim.
 * @param state - complete folded ledger.
 * @param options - optional fixed-area token budget.
 * @returns deterministic text, SHA-256 hash, truncation marker, and version.
 */
export function renderFixedArea(state: LedgerState, options: { tokenBudget?: number } = {}): FixedArea {
  const lines: string[] = [
    '# Continuity ledger',
    `renderer: 1`,
    `main: ${state.mainSessionId}`,
    ...state.branchSessionId === undefined ? [] : [`branch: ${state.branchSessionId}`],
    `rev: ${state.rev}`,
    '## Goal and constraints',
  ]
  const constraintKeys = Object.keys(state.fields).filter(key => key === 'goal' || key.startsWith('goal.') || key.startsWith('risk.constraint.')).sort()
  if (constraintKeys.length === 0) lines.push('(none)')
  for (const key of constraintKeys) lines.push(`${key}: ${stableScalar(state.fields[key])}`)
  lines.push('## Committed decisions')
  const decisions = Object.values(state.decisions)
    .filter(decision => decision.status !== 'proposed')
    .sort(compareDecisions)
  appendDecisions(lines, decisions, options.tokenBudget)
  lines.push('## Open work items')
  const work = openWorkItems(state)
  if (work.length === 0) lines.push('(none)')
  for (const item of work) {
    lines.push(`${item.id}: owner=${item.owner.id} close=${item.closePolicy}${item.taskRefs.length === 0 ? '' : ` tasks=${item.taskRefs.join(',')}`}`)
  }
  lines.push('## Artifact pointers')
  const artifacts = Object.keys(state.fields).filter(key => key === 'artifact' || key.startsWith('artifact.')).sort()
  if (artifacts.length === 0) lines.push('(none)')
  for (const key of artifacts) lines.push(`${key}: ${stableScalar(state.fields[key])}`)
  const text = `${lines.join('\n')}\n`
  return { text, hash: sha256(text), truncated: lines.some(line => line.includes('[truncated]')), rendererVersion: 1 }
}

function appendDecisions(lines: string[], decisions: readonly ContinuityDecision[], tokenBudget: number | undefined): void {
  if (decisions.length === 0) {
    lines.push('(none)')
    return
  }
  if (tokenBudget === undefined) {
    for (const decision of decisions) appendDecisionDetail(lines, decision)
    return
  }
  const references: string[] = []
  const details: string[] = []
  let used = estimateTextTokens(lines.join('\n'))
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]!
    const detail: string[] = []
    appendDecisionDetail(detail, decision)
    const cost = estimateTextTokens(detail.join('\n'))
    if (used + cost <= tokenBudget) {
      details.unshift(...detail)
      used += cost
    } else {
      references.unshift(`${decision.id}: rev ${decision.rev} [truncated]`)
    }
  }
  lines.push(...details, ...references)
}

function appendDecisionDetail(lines: string[], decision: ContinuityDecision): void {
  lines.push(`- ${decision.id} (rev ${decision.rev}, at ${decision.at}) ${decision.reason}`)
  for (const patch of decision.patch) {
    lines.push(`  ${patch.key}: ${stableScalar(patch.before)} -> ${stableScalar(patch.after)}`)
  }
}

function compareDecisions(a: ContinuityDecision, b: ContinuityDecision): number {
  return a.at - b.at || a.id.localeCompare(b.id)
}

function stableScalar(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'null'
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
