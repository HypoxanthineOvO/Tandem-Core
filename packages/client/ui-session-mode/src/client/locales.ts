/** `sessionMode` namespace dictionaries for the composer mode chip. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'sessionMode'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'mode.work': '工作模式',
  'mode.direct': '直接模式',
  'chip.aria': '当前是{mode}，点击切换到{next}',
  'chip.failed': '切换模式失败',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<SessionModeKey, string> = {
  'mode.work': 'Work mode',
  'mode.direct': 'Direct mode',
  'chip.aria': 'Current mode: {mode}. Switch to {next}.',
  'chip.failed': 'Mode switch failed',
}

/** Key domain of the `sessionMode` namespace (zh is the source of truth). */
export type SessionModeKey = keyof typeof zh
