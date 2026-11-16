/** Shared delegation resolution and activation, independent of visible tool definitions. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  assertSubagentMaxDepth, parentAgentOptionsForDelegation, resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentActivation, SubagentProvider } from '@deepseek-ai/dsh-subagent'
import {
  assertAllowedModelSelection, hasConfiguredLlmSelection, hasDelegationModelRequest,
  preflightChildLlmRoute, requestedAgentOptions,
} from './model-selection.ts'
import type { ModelSelectionPolicy } from './model-selection.ts'
import {
  recordSubagentModelSelection, subagentModelSelectionPolicy,
  subagentModelSelectionProjectionDefinition,
} from './model-selection-state.ts'
import { SubagentPresetSelection } from './preset-selection.ts'
import type {} from './model-selection-settings.ts'
import type {
  DelegationConfig, DelegationPolicy, DelegationRequest, DelegationSpec,
  DelegationStartHooks, ResolvedDelegation,
} from './types.ts'

export type { DelegationConfig, DelegationPolicy, DelegationRequest, DelegationSpec, DelegationStartHooks } from './types.ts'
export type { PresetSelectionConfig, PresetSelectionRequest } from './preset-selection.ts'
export { SubagentPresetSelection } from './preset-selection.ts'
export { SubagentModelSelectionConfig } from './model-selection-settings.ts'
export type { SubagentModelSelectionSettings, ModelSelectionSettingsConfig } from './model-selection-settings.ts'
export * from './model-selection.ts'
export * from './model-selection-state.ts'

interface RegisteredPolicy {
  readonly config: DelegationConfig
  readonly presets: SubagentPresetSelection
  readonly owner: Context
  registered: boolean
  holders: number
}

/** Expected refusal while resolving or starting a delegation. */
export class DelegationError extends Error {
  constructor(message: string, readonly code: 'UNREGISTERED_POLICY' | 'INVALID_SPEC' | 'UNSUPPORTED_CAPABILITY' | 'UNAUTHORIZED') {
    super(message)
    this.name = 'DelegationError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared native dispatch; no tool must be visible for consumers to use it. */
    subagentDelegation: SubagentDelegation
  }
}

/** Service Definition and Provider for all native delegation consumers. */
export default class SubagentDelegation extends Service {
  static inject = ['subagents', 'sessionProjections']
  private readonly policies = new Map<DelegationPolicy, RegisteredPolicy>()
  private readonly specs = new WeakMap<DelegationSpec, ResolvedDelegation>()
  private readonly reserved = new Map<SessionId, { signal: AbortSignal; before?: DelegationStartHooks['beforeChildStart'] }>()

  constructor(ctx: Context) {
    super(ctx, 'subagentDelegation')
    ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    ctx.on('agent/created', async ({ agent }) => {
      for (const entry of this.policies.values()) {
        if (entry.registered && entry.config.modelSelectionSettings === true && this.belongsToOwner(entry, agent)) {
          this.selectionPolicy(agent.session, true)
        }
      }
      const reservation = this.reserved.get(agent.id)
      if (reservation === undefined) return
      reservation.signal.throwIfAborted()
      await reservation.before?.(agent, reservation.signal)
      reservation.signal.throwIfAborted()
    })
  }

  /**
   * Register deployment permissions with reversible Context ownership. Unknown providers may
   * register later; incompatible available providers reject immediately.
   * @param config - Explicit backend, preset, route-selection and depth permissions.
   * @param owner - Plugin Context that owns and disposes the registration.
   * @returns An instance-local policy token; disposal revokes future resolve/start operations.
   */
  register(config: DelegationConfig, owner: Context): DelegationPolicy {
    if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
    const detached: DelegationConfig = {
      ...config,
      ...config.agentOptions === undefined ? {} : { agentOptions: { ...config.agentOptions } },
      ...config.allowedAgentPresets === undefined ? {} : { allowedAgentPresets: [...config.allowedAgentPresets] },
      ...config.modelSelectionPolicy === undefined ? {} : {
        modelSelectionPolicy: { routes: config.modelSelectionPolicy.routes.map(route => ({ ...route })) },
      },
    }
    const entry: RegisteredPolicy = { config: detached, presets: new SubagentPresetSelection(detached), owner, registered: true, holders: 0 }
    const validate = (provider: SubagentProvider): void => {
      if (provider.name === config.provider || provider.name === config.forkProvider) this.assertProvider(entry, provider)
    }
    for (const name of [config.provider, ...config.forkProvider === undefined ? [] : [config.forkProvider]]) {
      const provider = this.ctx.subagents.getProvider(name)
      if (provider !== undefined) validate(provider)
    }
    owner.on('subagent/provider-added', validate)
    const policy = Object.freeze({ token: Symbol('delegation-policy') })
    owner.effect(() => {
      this.policies.set(policy, entry)
      return () => {
        entry.registered = false
        if (entry.holders === 0) this.policies.delete(policy)
      }
    })
    return policy
  }

  /**
   * Retain an accepted holder-owned operation through consumer reload.
   * @param policy - Active deployment registration to retain before its owner unloads.
   * @returns Idempotent release; revoked registrations disappear after the last release.
   */
  retain(policy: DelegationPolicy): () => void {
    const entry = this.policies.get(policy)
    if (entry === undefined || !entry.registered) throw new DelegationError('delegation configuration is not registered', 'UNREGISTERED_POLICY')
    entry.holders += 1
    let released = false
    return () => {
      if (released) return
      released = true
      entry.holders -= 1
      if (!entry.registered && entry.holders === 0) this.policies.delete(policy)
    }
  }

  private belongsToOwner(entry: RegisteredPolicy, parent: Agent): boolean {
    const scope = scopeOf(entry.owner)
    return scope === undefined || scopeChainOf(scopeOf(parent.ctx)).includes(scope)
  }

  private expectPolicy(policy: DelegationPolicy, parent: Agent): RegisteredPolicy {
    const entry = this.policies.get(policy)
    if (entry === undefined) throw new DelegationError('delegation configuration is not registered', 'UNREGISTERED_POLICY')
    if (!this.belongsToOwner(entry, parent)) {
      throw new DelegationError('delegation configuration does not belong to the calling agent', 'UNAUTHORIZED')
    }
    return entry
  }

  private assertProvider(entry: RegisteredPolicy, provider: SubagentProvider): void {
    const { config, presets } = entry
    presets.assertProvider(provider)
    if (this.ctx.subagents.resolveMaxDepth(config.maxDepth) !== undefined && !provider.capabilities.depthLimit) {
      throw new Error(`tool-subagent: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`)
    }
    if (config.agentOptions !== undefined && !provider.capabilities.agentOptions) {
      throw new Error(`tool-subagent: provider "${provider.name}" does not support child agentOptions`)
    }
    if (config.modelSelectionEnabled === true && !provider.capabilities.agentOptions) {
      throw new Error(`tool-subagent: provider "${provider.name}" does not support child model selection`)
    }
  }

  /**
   * Capture the Host setting for a fresh root, or inherit the parent's durable allowed routes.
   * Existing Sessions without a recorded policy never sample a later Host preference.
   * @param target - Session receiving delegation permissions.
   * @param enabled - Whether the deployment opts into Host setting sampling.
   * @returns Captured selection permission, or undefined for a fixed-route composition.
   */
  selectionPolicy(target: Session, enabled: boolean): ModelSelectionPolicy | undefined {
    if (!enabled) return undefined
    const settings = this.ctx.get('subagentModelSelection')
    if (settings === undefined) {
      throw new Error('tool-subagent: `modelSelectionSettings` requires @deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope')
    }
    const freshSession = target.firstLiveSeq === 0
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      && target.eventAt(SessionSeq(0))?.type !== 'session/end-seed'
    let allowedModels = subagentModelSelectionPolicy(this.ctx.sessionProjections, target)
    if (allowedModels === undefined) {
      const parentId = target.header.origin === 'subagent' ? target.header.parentSession : undefined
      if (parentId !== undefined) {
        const sessions = this.ctx.get('sessions')
        if (sessions === undefined) throw new Error('tool-subagent: child model-selection inheritance requires the Session registry')
        const parent = sessions.get(parentId)
        allowedModels = parent === undefined ? undefined : subagentModelSelectionPolicy(this.ctx.sessionProjections, parent)
      } else if (freshSession) {
        const current = settings.current()
        allowedModels = current.enabled ? current.allowedModels : undefined
      }
    }
    if (allowedModels !== undefined) recordSubagentModelSelection(this.ctx.sessionProjections, target, allowedModels)
    return allowedModels === undefined ? undefined : { routes: allowedModels }
  }

  /**
   * Resolve preset, exact LLM selection, live adapter preflight and current depth without creating a child.
   * @param parent - Exact live parent Agent; native activation checks it again at admission.
   * @param request - Consumer-neutral task and optional overrides.
   * @param policy - Token from this service's deployment registration.
   * @param signal - Cancellation through route preflight.
   * @returns A single-use spec; it can only be started by this service while the policy is registered.
   */
  async resolve(parent: Agent, request: DelegationRequest, policy: DelegationPolicy, signal: AbortSignal): Promise<DelegationSpec> {
    const entry = this.expectPolicy(policy, parent)
    const { config, presets } = entry
    const providerName = request.inheritContext === true ? config.forkProvider ?? config.provider : config.provider
    const provider = this.ctx.subagents.getProvider(providerName)
    if (provider === undefined) throw new Error(`no subagent provider registered for "${providerName}"`)
    if (request.inheritContext !== undefined && request.inheritContext !== provider.inheritsParentContext) {
      throw new DelegationError(`subagent provider "${providerName}" does not support the requested context inheritance`, 'UNSUPPORTED_CAPABILITY')
    }
    this.assertProvider(entry, provider)
    if (presets.configured) await presets.validate(this.ctx)
    const agentPreset = presets.resolve(request.agentPreset === undefined ? {} : { agent_preset: request.agentPreset })
    const modelRequest = {
      ...request.provider === undefined ? {} : { provider: request.provider },
      ...request.model === undefined ? {} : { model: request.model },
      ...request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort },
    }
    const parentOptions = parentAgentOptionsForDelegation(parent)
    const requiresPreflight = hasDelegationModelRequest(modelRequest) || hasConfiguredLlmSelection(config.agentOptions)
    const defaults = requiresPreflight && provider.agentRouteDefaults !== undefined
      ? { ...provider.agentRouteDefaults, ...config.agentOptions } : config.agentOptions
    const sampledPolicy = config.modelSelectionSettings === true ? this.selectionPolicy(parent.session, true) : undefined
    const selectionEnabled = config.modelSelectionSettings === true ? sampledPolicy !== undefined : config.modelSelectionEnabled === true
    const childOptions = requestedAgentOptions(parentOptions, defaults, modelRequest, selectionEnabled)
    assertAllowedModelSelection(sampledPolicy, parentOptions, childOptions, modelRequest)
    assertAllowedModelSelection(config.modelSelectionPolicy, parentOptions, childOptions, modelRequest)
    const durableRoutes = subagentModelSelectionPolicy(this.ctx.sessionProjections, parent.session)
    assertAllowedModelSelection(durableRoutes === undefined ? undefined : { routes: durableRoutes }, parentOptions, childOptions, modelRequest)
    if (requiresPreflight) {
      const llm = this.ctx.get('llm')
      if (llm === undefined) throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable')
      await preflightChildLlmRoute(llm, parentOptions, childOptions, signal, provider.agentRouteDefaults === undefined)
      if (this.ctx.subagents.getProvider(providerName) !== provider) {
        throw new Error(`subagent provider "${providerName}" changed while resolving the child LLM route; retry the delegation`)
      }
    }
    signal.throwIfAborted()
    const maxDepth = this.ctx.subagents.resolveMaxDepth(config.maxDepth)
    resolveChildDepth(parent, maxDepth)
    const spec = Object.freeze({ provider: providerName, ...request.childId === undefined ? {} : { childId: request.childId } })
    this.specs.set(spec, {
      policy, parent, provider,
      activation: {
        provider: providerName, label: request.label, delivery: request.delivery ?? 'parent',
        source: request.source ?? 'service',
        ...request.childId === undefined ? {} : { childId: request.childId },
        request: {
          parent,
          prompt: typeof request.prompt === 'string' ? [{ type: 'text', text: request.prompt }] : structuredClone([...request.prompt]),
          ...request.cwd === undefined ? {} : { cwd: request.cwd },
          ...agentPreset === undefined ? {} : { agentPreset },
          ...childOptions === undefined ? {} : { agentOptions: childOptions },
          ...maxDepth === undefined ? {} : { maxDepth },
          ...request.outputSchema === undefined ? {} : { outputSchema: structuredClone(request.outputSchema) },
        },
      },
    })
    return spec
  }

  /**
   * Start a resolved task. Local identity hooks finish before the child receives its initial task;
   * their failures reject creation. Temporary reservations always release, including on cancellation.
   * @param spec - Single-use spec resolved by this service.
   * @param signal - Cancellation before native inbox acceptance.
   * @param hooks - Optional local identity preparation and durable-record flush callbacks.
   * @returns The native activation, preserving caller/parent delivery and structured results.
   */
  async start(spec: DelegationSpec, signal: AbortSignal, hooks: DelegationStartHooks = {}): Promise<SubagentActivation> {
    const resolved = this.specs.get(spec)
    if (resolved === undefined) throw new DelegationError('delegation spec is unknown or already started', 'INVALID_SPEC')
    this.specs.delete(spec)
    this.expectPolicy(resolved.policy, resolved.parent)
    signal.throwIfAborted()
    const provider = this.ctx.subagents.getProvider(spec.provider)
    if (provider !== resolved.provider) {
      throw new Error(`subagent provider "${spec.provider}" changed while resolving the child LLM route; retry the delegation`)
    }
    const needsReservation = hooks.onChildReserved !== undefined || hooks.beforeChildStart !== undefined || spec.childId !== undefined
    if (needsReservation && provider?.prepareContinuable === undefined) {
      throw new DelegationError('reserved child ids require a local backend', 'UNSUPPORTED_CAPABILITY')
    }
    if (!needsReservation) return this.ctx.subagents.startActivation({ ...resolved.activation, signal })
    const childId = spec.childId ?? SessionId(randomUUID())
    if (this.reserved.has(childId)) throw new DelegationError(`subagent "${childId}" is already reserved`, 'INVALID_SPEC')
    this.reserved.set(childId, { signal, ...hooks.beforeChildStart === undefined ? {} : { before: hooks.beforeChildStart } })
    let release: void | (() => void) = undefined
    let outcome: { ok: true; activation: SubagentActivation } | { ok: false; error: unknown }
    try {
      release = await hooks.onChildReserved?.(childId)
      signal.throwIfAborted()
      outcome = { ok: true, activation: await this.ctx.subagents.startActivation({ ...resolved.activation, childId, signal }) }
    } catch (error: unknown) {
      outcome = { ok: false, error }
    } finally {
      this.reserved.delete(childId)
    }
    if (typeof release === 'function') {
      try { release() } catch (cleanupError: unknown) {
        const errors = outcome.ok ? [cleanupError] : [outcome.error, cleanupError]
        if (outcome.ok) {
          try { await outcome.activation.dispose() } catch (disposeError: unknown) { errors.push(disposeError) }
        }
        throw new AggregateError(errors, 'subagent identity cleanup failed; inspect caller identity state and any activation disposal errors before retrying')
      }
    }
    if (!outcome.ok) throw outcome.error
    return outcome.activation
  }
}
