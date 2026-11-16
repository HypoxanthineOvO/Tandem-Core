/** Bounded, redacted decision details appended to the main-line conversation. */
import type { ContinuityInboxItem, LedgerState } from './types.ts'
import { stableJson } from './ledger.ts'

/** Character limits for one displayed value/reason and the complete notification, including labels. */
export interface PendingNotificationLimits {
  readonly valueMaxChars: number
  readonly maxChars: number
}

/** Defaults exposed by the subagent runtime's validated configuration. */
export const DEFAULT_PENDING_NOTIFICATION_LIMITS: PendingNotificationLimits = { valueMaxChars: 512, maxChars: 8192 }

/** Rendering failure that leaves its source inbox items unacknowledged. */
export class PendingNotificationError extends Error {
  readonly code: 'CONTINUITY_DECISION_MISSING' | 'CONTINUITY_DECISION_TOO_LARGE'

  /**
   * @param code - stable missing-record or single-decision size failure.
   * @param message - actionable display text.
   */
  constructor(code: PendingNotificationError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'PendingNotificationError'
  }
}

const secretNames = '(?:api[_-]?key|x-api-key|(?:access|refresh|id)[_-]?token|token|(?:client[_-]?)?secret|authorization|proxy-authorization|password|credentials?)'
const secretField = new RegExp(`${secretNames}(?:$|\\.)`, 'i')
const redacted = '[已脱敏]'
const truncated = '…（已截断）'

/**
 * Render authoritative decision patches, not inbox summaries or current field values.
 * Redaction precedes clipping; structured secret fields are masked in full. The
 * result includes field names, before/after values, reason, and source branch.
 * Whole decisions fill the complete notification in order; deferred items remain
 * unacknowledged. Missing decisions or one oversized decision fail before delivery.
 * @param state - ledger containing the original decisions addressed by the inbox.
 * @param items - pending items in their selected delivery order.
 * @param limits - validated character limits supplied by the runtime configuration.
 * @returns compact Chinese text and only the inbox identities actually included; the ledger remains unchanged.
 */
export function renderPendingDecisions(state: LedgerState, items: readonly ContinuityInboxItem[], limits: PendingNotificationLimits): { text: string; inboxIds: readonly string[] } {
  const byEvent = new Map(Object.values(state.decisions).map(decision => [decision.eventId, decision]))
  const lines = ['待带入决议（字段值：前 → 后）：']
  const inboxIds: string[] = []
  const pendingCount = Object.values(state.inbox).filter(item => item.ackedAt === undefined).length
  const footer = (delivered: number) => pendingCount > delivered ? `还有 ${pendingCount - delivered} 条待带入，下次继续。` : ''
  for (const item of items) {
    const decision = byEvent.get(item.eventId)
    if (decision === undefined) throw new PendingNotificationError('CONTINUITY_DECISION_MISSING', '待带入决议缺少原始字段改动，请检查连续性账本记录。')
    const detail = [`- ${item.kind === 'proposal' ? '提案（尚未采纳）' : '决议'}（版本 ${decision.rev}）；来源支线：${stableJson(redactText(decision.source.sessionId))}`]
    for (const patch of decision.patch) {
      const value = (input: unknown) => clip(stableJson(secretField.test(patch.key) ? redacted : redactValue(input ?? null)), limits.valueMaxChars)
      detail.push(`  ${stableJson(redactText(patch.key))}：${value(patch.before)} → ${value(patch.after)}`)
    }
    detail.push(`  原因：${clip(stableJson(redactText(decision.reason)), limits.valueMaxChars)}`)
    const candidate = [...lines, ...detail, ...footer(inboxIds.length + 1) ? [footer(inboxIds.length + 1)] : []].join('\n')
    if (candidate.length > limits.maxChars) {
      if (inboxIds.length === 0) throw new PendingNotificationError('CONTINUITY_DECISION_TOO_LARGE', '单条待带入决议超过通知长度上限；请提高 continuityNotificationMaxChars 后重试。')
      break
    }
    lines.push(...detail)
    inboxIds.push(item.id)
  }
  const remaining = footer(inboxIds.length)
  return { text: [...lines, ...remaining ? [remaining] : []].join('\n'), inboxIds }
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [redactText(key), secretField.test(key) ? redacted : redactValue(child)]))
}

/** Credential assignments, authorization schemes, opaque token prefixes, and URL credentials use the routing diagnostic rules. */
function redactText(text: string): string {
  const quoted = new RegExp(String.raw`(["']?${secretNames}["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`, 'gi')
  const bare = new RegExp(String.raw`(["']?${secretNames}["']?\s*[:=]\s*)[^\s,"';&}\]]+`, 'gi')
  const escaped = new RegExp(String.raw`((?:\\+["'])${secretNames}(?:\\+["'])\s*[:=]\s*)(?:\\+["'])[\s\S]*`, 'gi')
  return text.replace(escaped, `$1${redacted}`).replace(quoted, `$1"${redacted}"`)
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>;,}]+/gi, match => `${match.split(/\s/, 1)[0]} ${redacted}`)
    .replace(bare, `$1${redacted}`)
    .replace(/\b(?:sk-|eyJ)[A-Za-z0-9_.-]+/g, redacted)
    .replace(/https?:\/\/[^\s]+/gi, url => url.replace(/([?&][^=]+)=([^&#]*)/g, `$1=${redacted}`).replace(/\/\/[^/@]+@/, `//${redacted}@`))
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let prefix = ''
  for (const character of text) {
    if (prefix.length + character.length + truncated.length > maxChars) break
    prefix += character
  }
  return prefix + truncated
}
