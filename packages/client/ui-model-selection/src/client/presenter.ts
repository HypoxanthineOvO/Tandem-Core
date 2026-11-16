import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Optional presentation owner for the native /model command. */
export interface ModelSelectionPresenter {
  /** Open this session's model chooser without submitting a model selection. */
  open(sessionId: SessionId): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelSelectionPresenter: ModelSelectionPresenter
  }
}
