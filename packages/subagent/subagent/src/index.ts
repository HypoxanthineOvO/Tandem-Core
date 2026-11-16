/**
 * Service Definition for the subagent capability seam (`ctx.subagents`): a named-provider registry plus a
 * capability-validating asynchronous start API. Providers establish a
 * child before returning its run, so fulfillment is the single publication and
 * ownership-transfer boundary.
 *
 * Multiple providers coexist: each registers under a unique name and callers
 * select one by name.
 *
 * This package owns the Service Definition role of the capability seam. Service Providers
 * (`@deepseek-ai/dsh-subagent-spawn-in-process`, `-fork`, `-acp`) and the model-facing
 * consumer (`@deepseek-ai/dsh-tool-subagent`) are separate packages.
 *
 * `startActivation` establishes every child under the activation manager, which
 * owns execution, result delivery, and resource release. Local providers seed
 * resumable Agents; external providers return a single execution handle.
 * `sendMessage` steers between same-tree local Agents without exposing
 * whether a child is resident. Discovery combines real child Sessions with
 * parent-owned records for external executions.
 * Direct discovery reads parent catalogs; descendants recursively read reachable
 * child catalogs. External entries are leaves without local Sessions.
 *
 * Same-process providers are trusted typed collaborators. Requests, provider
 * descriptors, results, and lifecycle payloads are borrowed immutable values;
 * serialization and hostile-input validation belong at real process, worker,
 * persistence, and model boundaries.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import type { Volatile } from '@deepseek-ai/cordis'

import { SubagentSessionAcquisition } from './session-acquisition.ts'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-attachment'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { DEFAULT_PENDING_NOTIFICATION_LIMITS } from '@deepseek-ai/dsh-continuity'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveTreeTarget } from './tree-routing.ts'
import type { SubagentTargetResolution } from './control-types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { Remote, RemoteError, TypertRemoteService, principalOf, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import {
  rejectPrompt, validateControlRequest,
} from './control.ts'
import type {
  SubagentDelivery,
  SubagentInterruptReceipt,
  SubagentPromptReceipt,
  SubagentPromptRequest,
  SubagentPromptRequestId,
} from './control-types.ts'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  SubagentCapabilities,
  SubagentActivation,
  SubagentActivationSpec,
  SubagentLiveAcquisition,
  SubagentInterruptAuthority,
  SubagentProvider,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentSendMessageOptions,
  SubagentStartRequest,
} from './types.ts'
import { SubagentError } from './error.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import { createActivationObserver, createLifecycleEmitter } from './lifecycle.ts'
import type { ActivationObserver, LifecycleEmitter } from './lifecycle.ts'
import SubagentManager from './manager.ts'
import { listChildren as listSubagentChildren, listDescendants as listSubagentDescendants } from './list-children.ts'
import type { SubagentDescendantListEntry } from './list-children.ts'
import { installSubagentArchiveAdmission } from './archive-admission.ts'
import type { SubagentCatalogEntry } from './projection-types.ts'
import { subagentIdentityProjectionDefinition, subagentTimingProjectionDefinition } from './projection.ts'
import { subagentCatalogProjectionDefinition } from './catalog.ts'
import { deliverSubagentPrompt } from './internal.ts'
import { ContinuityController } from './continuity/controller.ts'
import type { ContinuityCommitReceipt, ContinuityCommitRequest, ContinuityPendingItem, ContinuityProcessNowResult, ContinuityStatus } from './continuity-types.ts'

export type {} from './catalog.ts'
export { SubagentAdmissionPolicy, SubagentHumanTurnObserver } from './admission.ts'
export type { SubagentAdmissionSource, SubagentAdmissionRequest, SubagentAdmissionDecision, SubagentQuotaGroup, SubagentDirectHumanTurn } from './admission.ts'
export { SubagentRouteEquivalence } from './route-equivalence.ts'
export type { SubagentModelRoute } from './route-equivalence.ts'
export * from './out-of-process.ts'
export { AssistantOutputFold, finalAssistantOutput } from './assistant-output.ts'
export { SubagentRunId } from './types.ts'
export type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  SubagentCapabilities,
  SubagentActivation,
  SubagentActivationSpec,
  SubagentLiveAcquisition,
  SubagentInterruptAuthority,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentSendMessageOptions,
  SubagentStartRequest,
  ResolvedSubagentStartRequest,
  SubagentStopReason,
  SubagentStopReasonMap,
} from './types.ts'
export {
  foldSubagentDescriptor,
  snapshotSubagentDescriptor,
  SUBAGENT_DESCRIPTOR_VERSION,
} from './descriptor.ts'
export type {
  ContinuableSubagentDescriptorData,
  ContinuableSubagentDescriptorInput,
  OneShotSubagentDescriptorData,
  SubagentDescriptorData,
} from './descriptor.ts'
export { STRUCTURED_OUTPUT_TOOL } from './structured.ts'
export { SubagentError } from './error.ts'
export { assertSubagentMaxDepth, delegationDepthOf } from './depth.ts'
export {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  parentAgentOptionsForDelegation,
  resolveChildAgentOptions,
  resolveChildDepth,
  SubagentDepthError,
} from './child-agent.ts'
export type { ChildComposition, DelegatedPolicyOverrides } from './child-agent.ts'
export type { AgentMessageSource, SubagentSettledMessageSource } from './continuation-messages.ts'
export type * from './control-types.ts'
export type { SubagentDescendantListEntry } from './list-children.ts'
export type { SubagentRunEndInfo, SubagentRunInfo } from './types.ts'
export type { SubagentCatalogEntry, SubagentIdentityProjection, SubagentTimingProjection } from './projection-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentRuntime
  }

  interface Events {
    /**
     * A provider became resolvable in the registry.
     * @param provider - the registered provider.
     * @mode emit
     */
    'subagent/provider-added'(provider: SubagentProvider): void
    /**
     * A provider left the registry. Accepted runs remain holder-owned.
     * @param name - the provider name that no longer resolves.
     * @mode emit
     */
    'subagent/provider-removed'(name: string): void
    /**
     * A provider established a published child. For in-process providers,
     * `ctx.agents.get(info.id)` resolves during this notification.
     * Scope-filtered dispatch keys the carrier by the delegating parent, so a
     * parent-scoped listener observes only its own delegations. Paired with
     * `subagent/end`.
     * @param info - the provider and published child identity.
     * @mode emit
     */
    'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void
    /**
     * A published child settled. Scope-filtered dispatch uses the same delegating
     * parent carrier as `subagent/start`, so the lifecycle pair reaches the
     * same scoped audience.
     * @param info - the run identity and terminal outcome.
     * @mode emit
     */
    'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void
  }
}

/**
 * Durable attribution of one browser-authored follow-up. The Session
 * Controller declares this `user-rpc` message source and depends on this
 * package, so the fields are spelled here: `MessageSource`'s `user` member
 * accepts the record and the correlation id rides the durable message the
 * Client reconciles its optimistic prompt against.
 */
interface BrowserPromptSource {
  readonly kind: 'user'
  readonly rpcId: SubagentPromptRequestId
  readonly clientTimeZone?: string
  /** Caller that submitted this follow-up, written only when it is not the owner; absent means the owner. */
  readonly principal?: Principal
}

/** Host configuration for continuable delegation and continuity notifications. */
export interface Config {
  /** Maximum live children sharing uninterrupted continuable parent links; defaults to 8. */
  maxActiveSubagents: Volatile<number>
  /** Additional tree-wide capacity by group id; absent means no configured groups. */
  quotaGroups?: Volatile<Record<string, {
    /** Maximum live children assigned to this quota group; a positive safe integer. */
    max: number
  }>>
  /** Preset-to-group assignment; policy decisions take precedence. */
  presetQuotaGroups?: Volatile<Record<string, string>>
  /** Default delegation depth for tools without an explicit limit; defaults to 1. */
  maxDepth: Volatile<number>
  /** Bind every human-prompted continuable child as a managed continuity branch. */
  continuityAutoBind: Volatile<boolean>
  /** Preset ids excluded from automatic continuity binding, e.g. evaluation presets. */
  continuityExcludedPresets?: Volatile<string[]>
  /** Maximum characters in one rendered continuity value or reason, including truncation marker; defaults to 512. */
  continuityNotificationValueChars?: Volatile<number>
  /** Maximum characters in a complete pending-decision notification, including labels and remainder count; defaults to 8192. */
  continuityNotificationMaxChars?: Volatile<number>
}

/** Named provider registry with managed activations, durable discovery, and local child messaging. */
export class SubagentRuntime extends TypertRemoteService {
  static Config = z.object({
    maxDepth: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(1).volatile(),
    maxActiveSubagents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8).volatile(),
    quotaGroups: z.dict(z.object({ max: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER) })).default({}).volatile(),
    presetQuotaGroups: z.dict(z.string()).default({}).volatile(),
    continuityAutoBind: z.boolean().default(false).volatile(),
    continuityExcludedPresets: z.array(z.string()).default([]).volatile(),
    continuityNotificationValueChars: z.number().step(1).min(16).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_PENDING_NOTIFICATION_LIMITS.valueMaxChars).volatile(),
    continuityNotificationMaxChars: z.number().step(1).min(256).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_PENDING_NOTIFICATION_LIMITS.maxChars).volatile(),
  })
  static inject = ['workingDirectory']
  private providers = new Map<string, SubagentProvider>()
  private manager: SubagentManager | undefined
  /**
   * The contained lifecycle-edge publisher. Built here because scoped dispatch
   * keys its carrier by this exact service instance, whose own context filter
   * composes into the carrier.
   */
  private readonly emitLifecycle: LifecycleEmitter
  private readonly continuityController: ContinuityController

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagents')
    new SubagentSessionAcquisition(ctx, this)
    this.continuityController = new ContinuityController(ctx, {}, () => ({
      valueMaxChars: this.config.continuityNotificationValueChars?.get() ?? DEFAULT_PENDING_NOTIFICATION_LIMITS.valueMaxChars,
      maxChars: this.config.continuityNotificationMaxChars?.get() ?? DEFAULT_PENDING_NOTIFICATION_LIMITS.maxChars,
    }))
    this.emitLifecycle = createLifecycleEmitter(this.ctx, parent => scopeTarget(this, parent))
    ctx.inject(['agents'], (childCtx: Context) => {
      const manager = new SubagentManager(childCtx, {
        startExternal: (name, request) => {
          const provider = this.expectProvider(name) as SubagentProvider & Required<Pick<SubagentProvider, 'start'>>
          return provider.start(request)
        },
        prepareContinuable: (name, request) => this.prepareContinuable(name, request),
        observeActivation: (provider, childId, parent) => this.observeActivation(provider, childId, parent),
        continuity: {
          ...this.continuityController.integration,
          acceptedHumanPrompt: (parent, child) => {
            if (!this.config.continuityAutoBind.get()) return
            const preset = childCtx.get('sessionProjections')?.stateOf(child.session, 'agentPreset')
            if (preset !== null && preset !== undefined && this.config.continuityExcludedPresets?.get().includes(preset)) return
            this.continuityController.bindIfAbsent(parent, child.id)
          },
        },
      }, () => this.config.maxActiveSubagents.get(), (preset) => {
        const id = preset === undefined ? undefined : this.config.presetQuotaGroups?.get()[preset]
        if (id === undefined) return undefined
        const group = this.config.quotaGroups?.get()[id]
        if (group === undefined) throw new SubagentError(`unknown subagent quota group "${id}"`, 'INVALID_QUOTA_GROUP')
        return { id, max: group.max }
      })
      this.manager = manager
      childCtx.effect(() => () => {
        /* v8 ignore else -- one injected binding owns the slot until its fiber disposes. */
        if (this.manager === manager) this.manager = undefined
      }, 'subagents.managerBinding()')
    })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(subagentCatalogProjectionDefinition)
      projectionCtx.sessionProjections.register(subagentTimingProjectionDefinition)
      projectionCtx.sessionProjections.register(subagentIdentityProjectionDefinition)
    })
    // Archive admission: this runtime is the owner that knows which live
    // children descend from a Session and how a parent stops them.
    ctx.inject(['agents'], (agentsCtx: Context) => { installSubagentArchiveAdmission(agentsCtx) })
  }

  /** Continuity owner bound to this runtime; Remote and tool surfaces delegate here. */
  get continuity(): ContinuityController {
    return this.continuityController
  }

  /**
   * Bind one live main session to one continuable branch session.
   * @param request - main and branch durable session identities.
   * @returns acknowledgement after the binding is accepted.
   * @throws {RemoteError} `subagent/parent-unavailable` when the main session is not live.
   */
  @Remote('continuityBind')
  continuityBind(request: { mainSessionId: SessionId; branchSessionId: SessionId }): { accepted: true } {
    const parent = this.ctx.get('agents')?.get(request.mainSessionId)
    if (parent === undefined) {
      throw new RemoteError('subagent/parent-unavailable', `parent session "${request.mainSessionId}" is not live`, { parentSessionId: request.mainSessionId })
    }
    this.continuityController.bind(parent, request.branchSessionId)
    return { accepted: true }
  }

  /**
   * Commit one structured decision from a bound branch.
   * @param request - branch source, optimistic revision, and confirmed patch.
   * @returns durable commit receipt, conflict, or uncertain persistence outcome.
   */
  @Remote('continuityCommit')
  continuityCommit(request: ContinuityCommitRequest): Promise<ContinuityCommitReceipt> {
    return this.continuityController.commit({
      eventId: request.eventId,
      ...request.baseRev === undefined ? {} : { baseRev: request.baseRev },
      actor: { kind: request.actorKind, id: request.actorId },
      source: { sessionId: request.sourceSessionId, turnId: request.sourceTurnId },
      patch: request.patch.map(item => ({ key: item.key, before: item.before ?? null, after: item.after ?? null })),
      reason: request.reason,
      ...request.at === undefined ? {} : { at: request.at },
      ...request.proposal === undefined ? {} : { proposal: request.proposal },
    })
  }

  /**
   * Read continuity status for one main line or branch.
   * @param request - addressed Session; optional only for one bound main line.
   * @returns current binding, revision, pending counts, and latest acknowledgement.
   */
  @Remote('continuityStatus')
  continuityStatus(request?: { sessionId: SessionId }): ContinuityStatus {
    return this.continuityController.status(request?.sessionId)
  }

  /**
   * Read pending continuity decisions in durable order.
   * @param limit - maximum returned items.
   * @param request - addressed Session; optional only for one bound main line.
   * @returns unacknowledged decisions and proposals.
   */
  @Remote('continuityPending')
  continuityPending(limit?: number, request?: { sessionId: SessionId }): readonly ContinuityPendingItem[] {
    return this.continuityController.pending(limit, request?.sessionId)
  }

  /**
   * Process a pending batch at the next safe step on user request.
   * @param request - processing identity and addressed main line or branch.
   * @returns whether processing was queued or no work remains.
   */
  @Remote('continuityProcessNow')
  continuityProcessNow(request: { requestId: string; sessionId?: SessionId }): ContinuityProcessNowResult {
    return this.continuityController.processNow(request.requestId, request.sessionId)
  }

  /**
   * Confirm one cross-scope proposal on its main line.
   * @param request - proposal, confirmation identity, and addressed Session.
   * @returns the confirmation commit receipt.
   */
  @Remote('continuityConfirmProposal')
  continuityConfirmProposal(request: { proposalEventId: string; requestId: string; sessionId?: SessionId }): Promise<ContinuityCommitReceipt> {
    return this.continuityController.confirmProposal(request.proposalEventId, request.requestId, request.sessionId)
  }

  /**
   * Resolve a delegation tool's depth policy against the current user setting.
   * @param configured - Explicit tool limit, or provider-managed for external delegation.
   * @returns The numeric limit, or undefined when the provider owns depth enforcement.
   */
  resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined {
    if (configured === 'provider-managed') return undefined
    if (configured !== undefined) return configured
    const depth = this.config.maxDepth.get()
    assertSubagentMaxDepth(depth)
    return depth
  }

  /**
   * Start a local child under its reserved identity.
   * @param spec - local task, reserved child id, and result recipient.
   * @returns activation with its accepted initial message id.
   */
  startActivation(spec: SubagentActivationSpec & { readonly childId: SessionId }):
  Promise<SubagentActivation & { readonly messageId: MessageId }>
  /**
   * Start a local or external child.
   * @param spec - task, backend, and result recipient.
   * @returns activation with a message id only for local children.
   */
  startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
  /**
   * Establish a managed child with backend-specific execution capabilities.
   * @param spec - task, backend, and result recipient.
   * @returns identities, execution result, and exact-activation disposal. A reserved
   * childId requires a local backend and guarantees an accepted messageId.
   */
  async startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation> {
    const provider = this.expectProvider(spec.provider)
    if (spec.childId !== undefined && provider.prepareContinuable === undefined) {
      throw new SubagentError('reserved child ids require a local backend', 'UNSUPPORTED_CAPABILITY')
    }
    assertSubagentMaxDepth(spec.request.maxDepth)
    this.assertCapabilities(provider, { ...spec.request, signal: spec.signal })
    const manager = this.requireManager()
    if (this.ctx.get('agents')?.get(spec.request.parent.id) !== spec.request.parent) {
      throw new SubagentError('subagent creation requires the exact live parent agent', 'UNAUTHORIZED')
    }
    if (spec.request.outputSchema !== undefined) assertObjectJsonSchema(spec.request.outputSchema)
    return provider.prepareContinuable === undefined
      ? manager.startExternal(spec)
      : manager.startLocal(spec)
  }

  /**
   * Join progressing descendants without cancelling them. Idle descendants whose
   * inboxes require a later wake stay resident and do not delay host completion.
   * @param parent - the exact parent whose descendant work is observed.
   * @returns whether work was joined; hosts recheck parent idle after true.
   */
  async waitForChildren(parent: Agent): Promise<boolean> {
    return this.manager?.waitForChildren(parent) ?? false
  }

  /**
   * Steer one model-authored message inside the sender's true root tree.
   * A running target admits it at the nearest step boundary; an idle target
   * starts a turn. A cold target restores through its real parent chain. The service derives durable sender attribution from the exact
   * live sender. Caller cancellation stops only pre-acceptance work.
   * @param sender - exact live Agent authorizing and originating the message.
   * @param targetId - durable root or continuable node in the same tree.
   * @param content - model-authored content to deliver.
   * @param options - caller cancellation before inbox acceptance.
   * @returns the accepted message's inbox id.
   * @throws when continuation services are unavailable, tree membership is rejected,
   *   or the message was not admitted.
   */
  async sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: SubagentSendMessageOptions,
  ): Promise<MessageId> {
    return this.requireManager().sendMessage(sender, targetId, content, options)
  }

  /**
   * Acquire an exact live Agent for a trusted Host operation without sending input.
   * Same-tree callers may restore continuable nodes through their actual parent chain;
   * undefined requester identifies a trusted Host acting for the user. The real root
   * must already be live. This capability is neither a model tool nor a browser RPC.
   * @param requester - exact live same-tree caller, or undefined for the trusted Host.
   * @param sessionId - target Session identity.
   * @param signal - cancellation until the acquisition returns; callers always release afterward.
   * @returns exact live Agent and an idempotent hold release; explicit teardown may revoke residency.
   * @throws SubagentError with ROOT_NOT_LIVE, UNAUTHORIZED, NOT_RESUMABLE, or capacity/admission failure.
   */
  acquireLive(requester: Agent | undefined, sessionId: SessionId, signal: AbortSignal): Promise<SubagentLiveAcquisition> {
    return this.requireManager().acquireLive(requester, sessionId, signal)
  }

  /**
   * Resolve a target inside the caller's true root tree, without resuming it.
   * @param sender - exact live caller.
   * @param target - parent/main/self, exact session id, or unique label.
   * @param signal - caller cancellation.
   * @returns resolved id or explicit failure with name candidates when ambiguous.
   */
  resolveTarget(sender: Agent, target: string, signal: AbortSignal): Promise<SubagentTargetResolution> {
    return resolveTreeTarget(this.ctx, sender, target, signal)
  }

  /**
   * Deliver one host-protocol message to a direct continuable child.
   * Symbol-keyed so host adapters can preserve their own source descriptors without
   * widening the public Service Definition or impersonating an Agent sender.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - host-authored content to deliver.
   * @param source - durable host-protocol source descriptor.
   * @param signal - caller cancellation before inbox acceptance.
   * @param delivery - Queue as a distinct turn or Steer at the nearest step.
   * @returns the accepted message's inbox id.
   */
  private [deliverSubagentPrompt](
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
    delivery: SubagentDelivery,
  ): Promise<MessageId> {
    return delivery === 'steer'
      ? this.requireManager().steerPrompt(parent, childId, content, source, signal)
      : this.requireManager().queuePrompt(parent, childId, content, source, signal)
  }

  /**
   * Queue one idempotent managed-effect prompt through the activation manager.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - model-visible prompt blocks.
   * @param source - durable attribution carrying the same effectId.
   * @param effectId - stable managed-effect identity.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted or previously persisted durable message id.
   */
  queueManagedEffect(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    effectId: string,
    signal: AbortSignal,
  ): Promise<MessageId> {
    return this.requireManager().queueManagedEffect(parent, childId, content, source, effectId, signal)
  }

  /**
   * Interrupt one live child's current execution under a human parent
   * address or an exact live direct-parent Agent. Fire-and-return: the cancel
   * signal is issued before this returns, but the target may keep running
   * until it observes the signal. Unclaimed pending inbox work, the Activation,
   * and published descendants are preserved; claimed work is not requeued.
   * Once the interrupted Agent is idle, a waking send resumes the parked FIFO
   * queue. External backends stop their single execution. An inactive direct child returns not-running; unknown or indirect targets reject.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - the human parent address or exact live direct-parent Agent.
   * @returns Whether a running direct child received cancellation, or not-running.
   * @throws {SubagentError} `UNAUTHORIZED` for unknown or non-direct targets.
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): SubagentInterruptReceipt {
    return this.manager?.interrupt(targetSessionId, authority) ?? { accepted: false, reason: 'not-running' }
  }

  /**
   * Close subagent admission below exact live parent Agents, stop only their
   * visible descendant Activations synchronously, then await admitted scoped
   * materializations and release those forests child-first. The scoped cutoff
   * lasts until each exact parent leaves the registry; unrelated parent trees
   * remain live.
   * @param parents - exact host-owned parent Agents entering teardown.
   * @returns once every retained descendant activation released its execution handle.
   * @throws an aggregate error after all branches settle when any failed.
   */
  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    const manager = this.manager
    // An absent activation manager cannot own materialized children.
    if (manager === undefined) return
    await manager.drainDescendants(parents)
  }

  /**
   * Release selected resident direct children of one exact live
   * parent. Other children of the same parent remain admitted and resident.
   * Absent targets and a manager-less composition are accepted no-ops.
   * @param parent - exact live direct parent authorizing the selected release.
   * @param childIds - durable direct-child ids to release when resident.
   * @returns once every selected activation released its execution handle.
   * @throws {SubagentError} `UNAUTHORIZED` when a resident target belongs to a
   *   different parent or the supplied parent identity is stale.
   */
  async drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    const manager = this.manager
    if (manager === undefined) return
    await manager.drainChildren(parent, childIds)
  }

  /**
   * Read the parent's durable direct-child catalog without loading or resuming an Agent.
   * The service owns and releases the live-preferred Session observation.
   * @param parentSessionId - parent whose direct children are requested.
   * @param signal - cancellation forwarded to the Session query.
   * @returns catalog children in parent event order.
   * @throws {@link SubagentError} when query or catalog projection is unavailable.
   * @throws SessionQueryError when the parent cannot be read or the query is cancelled.
   */
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]> {
    return listSubagentChildren(this.ctx, parentSessionId, signal)
  }

  /**
   * Recursively list reachable parent catalogs in stable pre-order, preserving
   * each catalog's event order. Each row carries its catalog parent and depth;
   * external children are leaves; one-shot and unknown-mode children remain
   * traversal nodes. Unknown modes
   * produce unsupported diagnostics. Unreadable child catalogs produce corrupt
   * or unavailable diagnostics and stop only that branch. Root read failures,
   * missing services or projections, and cancellation reject the whole listing.
   * Each catalog is observed once and released before the next read. No Agent
   * is loaded or resumed; Sessions absent from reachable catalogs are omitted.
   * @param rootSessionId - session whose catalog starts descendant discovery.
   * @param signal - cancellation forwarded to and checked around each catalog read.
   * @returns children and branch diagnostics in parent-catalog pre-order.
   * @throws {@link SubagentError} when listing dependencies are unavailable or the caller cancels.
   * @throws SessionQueryError when the root catalog cannot be read.
   */
  listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]> {
    return listSubagentDescendants(this.ctx, rootSessionId, signal)
  }

  /**
   * Deliver one browser-authored message to a continuable child through the
   * exact live direct parent, retaining the caller-minted request identity and
   * validated browser zone on the accepted message. Success identifies the
   * message the child's inbox accepted; later execution is independent of this
   * call. Queue delivery targets a later turn; steer delivery targets the
   * nearest step and retains the Agent loop's best-effort fallback semantics.
   * Image parts are admitted and persisted through the attachment store
   * before delivery, and the child's model must accept image input.
   * Cold resume at capacity rejects with `subagent/delivery-unavailable`.
   * @param request - durable address, delivery, minted identity, content, and optional browser zone.
   * @param signal - carrier cancellation, owning the call until inbox acceptance.
   * @returns the accepted message's inbox identity.
   * @throws {RemoteError} `gateway/bad-request`, `subagent/attachment-invalid`,
   *   `subagent/invalid-time-zone`, `subagent/parent-unavailable`,
   *   `subagent/not-resumable`, `subagent/unauthorized`,
   *   `subagent/delivery-unavailable`, `gateway/cancelled`, or `gateway/internal`.
   */
  @Remote('prompt')
  async prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt> {
    const { parentSessionId, childSessionId, clientTimeZone, delivery } = request
    validateControlRequest('subagent.prompt', request)
    const canonicalTimeZone = clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(clientTimeZone)
    if (clientTimeZone !== undefined && canonicalTimeZone === undefined) {
      throw new RemoteError(
        'subagent/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: clientTimeZone },
      )
    }
    const parent = this.ctx.get('agents')?.get(parentSessionId)
    if (parent === undefined) {
      throw new RemoteError(
        'subagent/parent-unavailable',
        `parent session "${parentSessionId}" is not live`,
        { parentSessionId },
      )
    }
    const principal = principalOf(this.ctx.invocation)
    const source: BrowserPromptSource = {
      kind: 'user',
      rpcId: request.requestId,
      ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
      ...(principal === undefined ? {} : { principal }),
    }
    try {
      // Admission precedes delivery: image parts become durable references
      // here, so the child inbox only ever accepts Host-persisted attachments.
      let content: ContentBlock[]
      if (request.content.every((part): part is { readonly type: 'text'; readonly text: string } => part.type === 'text')) {
        content = request.content.map(part => ({ type: 'text', text: part.text }))
      } else {
        const attachments = this.ctx.get('attachments')
        if (attachments === undefined) throw new Error('subagent image prompt requires an attachment store')
        content = await attachments.admitPromptContent(request.content)
      }
      return {
        messageId: await this[deliverSubagentPrompt](
          parent,
          childSessionId,
          content,
          source,
          signal,
          delivery,
        ),
      }
    } catch (error: unknown) {
      return rejectPrompt(error, childSessionId, signal)
    }
  }

  /**
   * Remote face of {@link interrupt} under one durable parent address.
   * Live targets are authorized against their Activation even if the parent
   * Agent is offline. Nonresident targets require the parent's attached durable
   * catalog; missing ownership evidence rejects without restoring any Agent.
   * @param childSessionId - durable child session id to interrupt.
   * @param parentSessionId - durable direct parent whose authority is claimed.
   * @param mode - required continuable-address discriminator.
   * @returns acknowledgement that the cancel signal was admitted, not that the target is quiescent.
   * @throws {RemoteError} `gateway/bad-request` for an empty id,
   *   `subagent/unauthorized` when the address does not own the live target,
   *   otherwise `gateway/internal`.
   */
  @Remote('interruptByParent')
  interruptByParent(
    childSessionId: SessionId,
    parentSessionId: SessionId,
    mode: 'continuable',
  ): SubagentInterruptReceipt {
    validateControlRequest('subagent.interrupt', { childSessionId, parentSessionId, mode })
    try {
      return this.interrupt(childSessionId, { kind: 'user', parentSessionId })
    } catch (error: unknown) {
      if (error instanceof SubagentError && error.code === 'UNAUTHORIZED') {
        throw new RemoteError(
          'subagent/unauthorized',
          'subagent does not belong to this parent',
          { childSessionId },
          { cause: error },
        )
      }
      throw new RemoteError('gateway/internal', 'subagent interrupt failed', {}, { cause: error })
    }
  }

  /**
   * Register a provider under its name. Registration is effect-scoped and HMR
   * safe; removing a provider blocks new starts but does not revoke runs that
   * were already returned to their holders. Providers without either execution
   * method are rejected with UNSUPPORTED_CAPABILITY before registration.
   * @param provider - the trusted provider implementation.
   * @returns the exact Cordis effect disposer.
   */
  registerProvider(provider: SubagentProvider): () => void {
    const name = provider.name
    if (provider.start === undefined && provider.prepareContinuable === undefined) {
      throw new SubagentError(`subagent provider "${name}" must implement start or prepareContinuable`, 'UNSUPPORTED_CAPABILITY')
    }
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous disposer
    return this.ctx.effect(function* (this: SubagentRuntime) {
      if (this.providers.has(name)) {
        throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(name, provider)
      yield () => {
        this.providers.delete(name)
        this.emitLifecycle('subagent/provider-removed', name)
      }
      // A throwing added-listener unwinds the yielded rollback, matching the
      // repository's fail-loud registration semantics.
      this.ctx.emit('subagent/provider-added', provider)
    }.bind(this), 'subagents.registerProvider()')
  }

  /**
   * Look up a provider by name.
   * @param name - the provider name.
   * @returns the provider, or undefined when absent.
   */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * List registered provider names in insertion order.
   * @returns the registered names.
   */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Resolve one provider's detached continuable-creation contribution. Method
   * presence on the provider IS the capability, so a provider without it is
   * rejected before the manager reserves any child resources.
   */
  private async prepareContinuable(
    name: string,
    request: ContinuableCreateRequest,
  ): Promise<ContinuableCreateSpec> {
    const provider = this.expectProvider(name) as SubagentProvider & Required<Pick<SubagentProvider, 'prepareContinuable'>>
    return provider.prepareContinuable(request)
  }

  /** Look up a provider for dispatch or fail loud. */
  private expectProvider(name: string): SubagentProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    return provider
  }

  /** Resolve the subagent manager or fail loud. */
  private requireManager(): SubagentManager {
    if (this.manager === undefined) {
      throw new SubagentError(
        'continuable subagents require the agents service',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return this.manager
  }

  /**
   * Build the lifecycle observer for one continuable Activation's residency
   * epoch, so the manager publishes its edges without owning event dispatch.
   */
  private observeActivation(
    provider: string,
    childId: SessionId,
    parent: Agent,
  ): ActivationObserver {
    return createActivationObserver(this.emitLifecycle, provider, childId, parent)
  }

  /** Reject the first requested capability that the provider lacks. */
  private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
    if (request.agentPreset !== undefined && !provider.capabilities.agentPreset) {
      throw new SubagentError(
        `subagent provider "${provider.name}" does not support independent agent preset selection`,
        'UNSUPPORTED_CAPABILITY',
      )
    }
    const needs: { when: boolean; cap: keyof SubagentCapabilities }[] = [
      { when: request.agentOptions !== undefined, cap: 'agentOptions' },
      { when: request.outputSchema !== undefined, cap: 'outputSchema' },
      { when: request.maxDepth !== undefined, cap: 'depthLimit' },
    ]
    for (const { when, cap } of needs) {
      if (when && !provider.capabilities[cap]) {
        throw new SubagentError(
          `subagent provider "${provider.name}" does not support the "${cap}" capability`,
          'UNSUPPORTED_CAPABILITY',
        )
      }
    }
  }

}

export default SubagentRuntime
