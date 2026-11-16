/** Consumer-neutral requests and deployment-owned delegation permissions. */
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivationSpec, SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ModelSelectionPolicy } from './model-selection.ts'
import type { PresetSelectionConfig } from './preset-selection.ts'

/** Deployment configuration registered by a tool or orchestration plugin, never model JSON. */
export interface DelegationConfig extends PresetSelectionConfig {
  /** Default registered backend, such as spawn or fork. */
  readonly provider: string
  /** Explicit alternate backend used only for inheritContext=true; omission forbids switching. */
  readonly forkProvider?: string
  /** Child defaults merged with compatible parent route values. */
  readonly agentOptions?: AgentOptions
  /** Deployment depth cap; omission reads the current Host setting. */
  readonly maxDepth?: number | 'provider-managed'
  /** Whether callers may request child LLM overrides. */
  readonly modelSelectionEnabled?: boolean
  /** Sample Host model permissions before new matching Agents make their first request. */
  readonly modelSelectionSettings?: boolean
  /** Captured Session allowlist; the Session's own durable policy also applies. */
  readonly modelSelectionPolicy?: ModelSelectionPolicy
}

/** Opaque registration permission, valid only while its registering Context remains mounted. */
export interface DelegationPolicy {
  /** Instance-local token, not a tool name. */
  readonly token: symbol
}

/** One task with no model-facing schema or tool-registry dependency. */
export interface DelegationRequest {
  /** Task content; text becomes a single text block. */
  readonly prompt: string | readonly ContentBlock[]
  /** Human-readable child task name. */
  readonly label: string
  /** Optional independent child preset, restricted to the registered allowlist. */
  readonly agentPreset?: string
  /** Optional exact route override; provider and model must be supplied together. */
  readonly provider?: string
  readonly model?: string
  /** Omission keeps compatible reasoning effort or uses the changed route's default. */
  readonly reasoningEffort?: string
  /** Choose the registered context-inheriting backend, without inheriting permissions. */
  readonly inheritContext?: boolean
  /** Optional initial directory; omission captures the parent's current directory. */
  readonly cwd?: string
  /** Optional local child id; omission allocates an id when reservation hooks are used. */
  readonly childId?: SessionId
  /** Optional object-rooted output schema, passed to the structured-output runtime. */
  readonly outputSchema?: ObjectJsonSchema
  /** Default parent notification, or caller-owned workflow result collection. */
  readonly delivery?: 'parent' | 'caller'
  /** Admission attribution; omission identifies a direct service consumer. */
  readonly source?: 'tool' | 'workflow' | 'remote' | 'service'
}

/** Resolved, single-use permission to start one child; mutation does not change the owned spec. */
export interface DelegationSpec {
  /** Backend selected by the registered configuration. */
  readonly provider: string
  /** Optional caller-supplied reserved local identity. */
  readonly childId?: SessionId
}

/** Identity preparation hooks; both are awaited before initial task submission. */
export interface DelegationStartHooks {
  /**
   * Prepare external identity/policy state under the reserved local id before creation.
   * Return a disposer for temporary state; it runs on success, failure, and cancellation.
   */
  readonly onChildReserved?: (childId: SessionId) => void | (() => void) | Promise<void | (() => void)>
  /** Append and flush child-owned identity records before its first model request. */
  readonly beforeChildStart?: (child: Agent, signal: AbortSignal) => void | Promise<void>
}

/** Private resolved state retained by the service, not accepted from callers. */
export interface ResolvedDelegation {
  readonly activation: Omit<SubagentActivationSpec, 'signal'>
  readonly policy: DelegationPolicy
  readonly parent: Agent
  readonly provider: SubagentProvider
}
