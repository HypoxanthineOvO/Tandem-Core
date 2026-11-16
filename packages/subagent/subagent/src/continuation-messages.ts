/**
 * Model-visible messages owned by continuable-subagent orchestration.
 *
 * @module @deepseek-ai/dsh-subagent/continuation-messages
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SubagentMessageMetadata } from './control-types.ts'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from './types.ts'
import type { SubagentRouteEquivalence } from './route-equivalence.ts'

/** Durable attribution for one model-authored message between Agents. */
export interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the Agent whose tool call produced the message. */
  readonly senderSessionId: SessionId
  /** Absent in historical adjacent messages; current tree messages carry correlation. */
  readonly message?: {
    readonly messageId: MessageId
    readonly source: SessionId
    readonly target: SessionId
    readonly kind: NonNullable<SubagentMessageMetadata['kind']>
    readonly replyTo?: MessageId
    readonly reportKind?: string
    readonly resultStatus?: string
  }
  /** Stable delivery identity; omitted by historical callers. */
  readonly effectId?: string
  /** Runtime-only permission embedded in a queued direct-human-turn reminder. */
  readonly summaryPermit?: { readonly childId: SessionId; readonly target: SessionId; readonly effectId: string }
}

/**
 * Durable attribution for the runtime's own account of a continuable child
 * settling. Deliberately a different kind from
 * {@link AgentMessageSource}: an Agent message is content the sender chose,
 * while this message is the manager stating what became of the child, and a
 * transcript that merged them would credit the child with words it never wrote.
 */
export interface SubagentSettledMessageSource {
  readonly kind: 'subagent-settled'
  /** A runtime account shown without expanding the row (`notice` context form). */
  readonly form: 'notice'
  /** One-line account of how the child ended. */
  readonly summary: string
  /** Session id of the child that settled. */
  readonly senderSessionId: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-message': AgentMessageSource
    'subagent-settled': SubagentSettledMessageSource
  }
}

/** Build durable attribution for one adjacent-Agent message. */
function agentMessageSource(sender: Agent): AgentMessageSource {
  return {
    kind: 'agent-message',
    form: 'relay',
    senderSessionId: sender.id,
  }
}

/**
 * Build the model-visible and durable representation of one tree message.
 * @param sender - exact live Agent that authored the message.
 * @param content - model-visible message blocks supplied by the sender.
 * @param target - recipient id; omission retains historical source-only attribution.
 * @param metadata - correlation fields; omission uses an ordinary message without an effect id.
 * @returns the durable user-message representation delivered to the recipient.
 */
export function createAgentMessage(
  sender: Agent,
  content: ContentBlock[],
  target?: SessionId,
  metadata: SubagentMessageMetadata = {},
): ReturnType<typeof createUserMessage> {
  const message = createUserMessage({
    content: [
      { type: 'text' as const, text: `Agent ${sender.id} sent a message: ` },
      ...content,
    ],
    source: agentMessageSource(sender),
  })
  if (target === undefined) return message
  return {
    ...message,
    source: {
      ...agentMessageSource(sender),
      ...(metadata.effectId === undefined ? {} : { effectId: metadata.effectId }),
      message: {
        messageId: message.id, source: sender.id, target, kind: metadata.kind ?? 'message',
        ...(metadata.replyTo === undefined ? {} : { replyTo: metadata.replyTo }),
        ...(metadata.reportKind === undefined ? {} : { reportKind: metadata.reportKind }),
        ...(metadata.resultStatus === undefined ? {} : { resultStatus: metadata.resultStatus }),
      },
    },
  }
}

/**
 * Append adjacent-Agent return guidance to a continuable child's initial task.
 * @param parentId - durable parent session id named in the guidance.
 * @param prompt - initial model-visible task blocks.
 * @returns task blocks followed by the continuable return guidance.
 */
export function withContinuableReturnGuidance(
  parentId: SessionId,
  prompt: ContentBlock[],
): ContentBlock[] {
  const encodedParentId = JSON.stringify(parentId)
  return [
    ...prompt,
    {
      type: 'text',
      text: `Your parent agent id is ${encodedParentId}. Before you finish, send your result to that agent with `
        + `send_message({ agent_id: ${encodedParentId}, message: "<self-contained result>" }). The parent shares `
        + 'your workspace but does not automatically receive your transcript, tool output, or reasoning. Send '
        + 'earlier messages as well when a finding changes what the parent should do next; sending a message '
        + 'does not end your turn.',
    },
  ]
}

/**
 * One line telling a parent that a background child is finished and why, in
 * the parent's own task vocabulary.
 * @param childId - the durable child the parent knows by id.
 * @param stopReason - how the child's last ordinary turn ended.
 * @param continuable - whether the child accepts a later message.
 * @returns the model-facing opening line of the settlement notice.
 */
function settlementSummary(childId: SessionId, stopReason: SubagentResult['stopReason'], continuable: boolean): string {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed':
      return continuable
        ? `${subject} finished and will do no further work unless you send it more.`
        : `${subject} finished. It cannot receive follow-up messages.`
    case 'aborted':
      return `${subject} was stopped before it finished.`
    case 'max-tokens':
      return `${subject} ran out of room before it finished.`
    // A pre-step rejection — a hook deny, a policy plugin — discarded input
    // the child had claimed, so the parent must not treat the task as done.
    case 'refusal':
      return `${subject} declined the task.`
    case 'error':
      return `${subject} failed before it finished.`
    /* v8 ignore next 4 -- `SubagentResult['stopReason']` is merge-extensible, so this arm
     * needs a backend that adds a variant; an unnameable ending is reported as unfinished
     * rather than silently as success. */
    default:
      return `${subject} ended abnormally (${String(stopReason)}) before it finished.`
  }
}

/**
 * Report the last recorded child request route, never its configured route as actual dispatch.
 * @param child - local child retaining its durable log; absent for external providers.
 * @param equivalence - optional routing-policy comparison; absence compares provider/model literally.
 * @returns one model-facing identity line, marking a nonequivalent selected route as fallback.
 */
export function settlementModelNotice(
  child?: Agent,
  equivalence?: Pick<SubagentRouteEquivalence, 'isSameRoute'>,
): string {
  if (child === undefined) return '实际模型：未核验（外部子代理未提供实际请求记录）。'
  const events = child.session.snapshotEvents().slice(child.session.inheritedEventCount)
  const actual = events.findLast(event => event.type === 'request/context')
  if (actual === undefined || actual.type !== 'request/context') return '实际模型：未核验（子会话没有实际请求记录）。'
  const selected = child.options
  const differs = selected.provider !== undefined && selected.model !== undefined
    && !(equivalence === undefined
      ? selected.provider === actual.data.provider && selected.model === actual.data.model
      : equivalence.isSameRoute({ provider: selected.provider, model: selected.model }, actual.data))
  return `实际模型：${actual.data.provider}/${actual.data.model}${differs
    ? `（备用；选定模型：${selected.provider}/${selected.model}）` : ''}。`
}

/**
 * Build the runtime-owned settlement notice from the child's nonempty closing text.
 * @param childId - durable child session id named in the notice.
 * @param terminal - recorded terminal state for the settled Activation.
 * @param continuable - whether the child can accept another task.
 * @param modelNotice - verified model identity or an explicit unavailable diagnostic.
 * @returns the durable user-message representation delivered to the parent.
 */
export function createSettlementMessage(
  childId: SessionId,
  terminal: SubagentResult,
  continuable = true,
  modelNotice?: string,
): ReturnType<typeof createUserMessage> {
  const summary = settlementSummary(childId, terminal.stopReason, continuable)
  // Parent providers receive this notice as a user message and may reject
  // nontext assistant blocks. Keep this conversion local so SDK/UI consumers
  // retain the complete child output.
  const closingText = terminal.output.flatMap(block =>
    block.type === 'text' && block.text.length > 0 ? [block] : [],
  )
  return createUserMessage({
    content: [
      { type: 'text' as const, text: summary },
      ...closingText.length === 0
        ? [{ type: 'text' as const, text: 'It left no closing message.' }]
        : [{ type: 'text' as const, text: 'Its closing message:' }, ...closingText],
      ...terminal.structured !== undefined
        ? [{ type: 'text' as const, text: `Structured result: ${JSON.stringify(terminal.structured)}` }] : [],
      ...terminal.diagnostic !== undefined
        ? [{ type: 'text' as const, text: terminal.diagnostic }] : [],
      ...modelNotice === undefined ? [] : [{ type: 'text' as const, text: modelNotice }],
    ],
    source: {
      kind: 'subagent-settled' as const,
      form: 'notice' as const,
      summary: boundContextSummary(summary),
      senderSessionId: childId,
    },
  })
}
