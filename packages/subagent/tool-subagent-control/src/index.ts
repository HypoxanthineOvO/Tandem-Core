/**
 * The globally named `send_message` and `interrupt` tools: thin
 * model-facing adapters over `ctx.subagents.sendMessage()` and
 * `ctx.subagents.interrupt()`. They perform no lifecycle routing of their own —
 * residency, cold resume, and interrupt authorization belong to the subagent
 * service — and they live apart from the provider-bound
 * `@deepseek-ai/dsh-tool-subagent` instances so multiple delegation tools share
 * one control API.
 * @module @deepseek-ai/dsh-tool-subagent-control
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { markAdjacentAgentSendMessageTool } from '@deepseek-ai/dsh-subagent/internal'

export const name = 'tool-subagent-control'
export const inject = ['tools', 'subagents']

/** Tool naming compatibility for persisted conversations. */
export interface Config {
  /** Also register interrupt_agent; absent or false exposes only interrupt. */
  legacyInterruptAgent?: boolean
}

export const Config = z.object({ legacyInterruptAgent: z.boolean().default(false) })

/** Empty model-supplied placeholders do not select a message destination. */
function messageTarget(value: string | null | undefined): string | undefined {
  return value?.trim() ? value : undefined
}

/**
 * Register same-tree messaging and direct-child interruption.
 * @param ctx - tool registry and execution service.
 * @param config - fixed tool-name compatibility; omission excludes the legacy alias.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.tools.register(markAdjacentAgentSendMessageTool(defineTool({
    name: 'send_message',
    description:
      'Send a message to any continuable agent in your tree. Use its unique name, id, parent, main, or self. A working agent receives it at its next step; an idle agent starts a new turn with it. '
      + 'Fill only one destination field. To reply to your parent, use to:"parent" and omit agent_id. '
      + 'Returns delivery confirmation, not the agent\'s answer.',
    parameters: {
      agent_id: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Exact session id. Fill only this or to; omit this field when using to:"parent".',
      },
      to: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Unique task name, exact session id, or parent/main/self. Reply to your parent with to:"parent"; omit agent_id.',
      },
      kind: { type: 'string', enum: ['message', 'question', 'answer', 'report', 'result'] as const, description: 'Message purpose; defaults to message.' },
      reply_to: { type: 'string', description: 'Message id being answered or the system reminder authorizing this report.' },
      report_kind: { type: 'string', description: 'Report category; human-summary requires a matching system reminder.' },
      result_status: { type: 'string', description: 'Optional outcome status for a result.' },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the agent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `message delivered to agent ${messageTarget(args.agent_id) ?? messageTarget(args.to)}`,
      }],
    },
    async execute(args, exec) {
      const sender = exec.agent
      if (!sender) {
        throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      }
      const agentId = messageTarget(args.agent_id)
      const to = messageTarget(args.to)
      const received = `agent_id=${JSON.stringify(args.agent_id)}, to=${JSON.stringify(args.to)}`
      if (agentId === undefined && to === undefined) {
        throw new Error(`send_message requires a non-empty agent_id or to; received ${received}. To reply to your parent, use to:"parent" and omit agent_id.`)
      }
      let targetId: SessionId
      if (agentId !== undefined && to === undefined) targetId = brandString<SessionId>(agentId)
      else {
        const resolved = await ctx.subagents.resolveTarget(sender, to!, exec.signal)
        if (resolved.kind !== 'resolved') throw new Error(`send_message target could not be resolved; received ${received}: ${JSON.stringify(resolved)}`)
        targetId = resolved.id
        if (agentId !== undefined) {
          const byId = await ctx.subagents.resolveTarget(sender, agentId, exec.signal)
          if (byId.kind !== 'resolved') throw new Error(`send_message target could not be resolved; received ${received}: ${JSON.stringify(byId)}`)
          if (byId.id !== targetId) {
            throw new Error(`send_message destinations conflict; received ${received}; agent_id resolves to ${JSON.stringify(byId.id)}, to resolves to ${JSON.stringify(targetId)}. Provide only one destination.`)
          }
        }
      }
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const messageId = await ctx.subagents.sendMessage(
        sender,
        targetId,
        message,
        { signal: exec.signal,
          ...(exec.callId === undefined ? {} : { effectId: `agent-message:${sender.id}:${exec.callId}` }),
          ...(args.kind === undefined ? {} : { kind: args.kind }),
          ...(args.reply_to === undefined ? {} : { replyTo: brandString<MessageId>(args.reply_to) }),
          ...(args.report_kind === undefined ? {} : { reportKind: args.report_kind }),
          ...(args.result_status === undefined ? {} : { resultStatus: args.result_status }),
        },
      )
      return { messageId }
    },
  })))

  for (const toolName of config.legacyInterruptAgent ? ['interrupt', 'interrupt_agent'] : ['interrupt']) {
    ctx.tools.register(defineTool({
      name: toolName,
      description:
        'Ask a subagent to stop its current work. This call returns without waiting for it to stop. '
        + 'You can continue a local direct child\'s conversation later with send_message. '
        + 'External executions stop permanently and cannot receive follow-ups. Subagents it started will keep running.',
      parameters: {
        agent_id: {
          type: 'string',
          required: true,
          description: 'The id of your direct child. You cannot stop siblings or deeper descendants.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            accepted: { type: 'boolean', required: true },
            reason: { type: 'string', enum: ['not-running'] },
          },
        },
        render: (args, value) => [{
          type: 'text',
          text: value.accepted ? `interrupt requested for agent ${args.agent_id}` : `agent ${args.agent_id} is not running; nothing to interrupt`,
        }],
      },
      execute(args, exec) {
        const caller = exec.agent
        if (!caller) {
          // Ancestor authority requires an exact live calling agent.
          throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`)
        }
        // The service authorizes the exact live caller against the target's
        // recorded lineage; the tool adds no authority of its own.
        return Promise.resolve(ctx.subagents.interrupt(brandString<SessionId>(args.agent_id), { kind: 'ancestor', agent: caller }))
      },
    }))
  }
}
