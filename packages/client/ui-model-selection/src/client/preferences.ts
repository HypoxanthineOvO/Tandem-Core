/** Optional deployment-owned stars; they never alter the underlying model catalog. */
export interface ModelPreferences {
  readonly ids: readonly string[]
  readonly names: readonly string[]
}

/** Read the public preferences injected by the Hypo deployment plugin. */
export function readModelPreferences(): ModelPreferences | undefined {
  return (globalThis as { __HYPO_MODEL_PREFERENCES__?: ModelPreferences }).__HYPO_MODEL_PREFERENCES__
}

/** Compare exact provider-independent model ids and explicitly configured display names. */
export function isStarred(preferences: ModelPreferences | undefined, id: string, name: string): boolean {
  const modelId = id.split('/').at(-1)?.toLowerCase() ?? ''
  return preferences?.ids.some(candidate => candidate.toLowerCase() === modelId) === true
    || preferences?.names.some(candidate => candidate.toLowerCase() === name.trim().toLowerCase()) === true
}
