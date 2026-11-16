/**
 * Branch-side receipt for one `continuity_commit` call: whether the decision
 * was recorded for this group and whether it reached the main line, with the
 * recorded reason on the same line and the changed fields in the expanded layer.
 */
import { useState } from 'react'
import { DisclosureRow, IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContinuityCommitReceipt } from '@deepseek-ai/dsh-subagent/continuity-types'
import type { NS } from '../locales.ts'
import css from './Continuity.module.css'

/** Wire name the receipt view is registered under; matches the composition's `continuityToolName`. */
export const CONTINUITY_COMMIT_TOOL = 'continuity_commit'

/** Full props of the receipt view. */
export type ContinuityReceiptRowProps = ToolCallViewProps & PropsLocale<typeof NS>

type Translate = ContinuityReceiptRowProps['t']

/** Receipt state as this view presents it; `running` and `failed` come from the call itself. */
export type ReceiptState = ContinuityCommitReceipt['state'] | 'running' | 'failed'

const RECEIPT_STATES: ReadonlySet<string> = new Set<ContinuityCommitReceipt['state']>([
  'duplicate', 'conflict', 'no-op', 'committed-local', 'deferred', 'wake-queued', 'commit-uncertain',
])

function isReceiptState(value: unknown): value is ContinuityCommitReceipt['state'] {
  return typeof value === 'string' && RECEIPT_STATES.has(value)
}

/** The parts of the call arguments the receipt displays. */
export interface ReceiptArgs {
  readonly reason: string
  readonly proposal: boolean
  readonly fields: readonly { readonly key: string; readonly after: unknown }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the displayed argument parts from the recorded call JSON.
 * @param raw - recorded or streaming argument JSON.
 * @returns reason, proposal flag, and changed fields; empty while unreadable.
 */
export function receiptArgs(raw: string): ReceiptArgs {
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { return { reason: '', proposal: false, fields: [] } } // Streaming JSON is incomplete until the call starts.
  if (!isRecord(value)) return { reason: '', proposal: false, fields: [] }
  const fields = Array.isArray(value.patch)
    ? value.patch.flatMap((item: unknown) => isRecord(item) && typeof item.key === 'string' ? [{ key: item.key, after: item.after }] : [])
    : []
  return {
    reason: typeof value.reason === 'string' ? value.reason : '',
    proposal: value.proposal === true,
    fields,
  }
}

/**
 * Read the receipt state of a settled result: structured presentation
 * metadata when the Host records it, otherwise the state word that ends the
 * rendered result line.
 * @param meta - recorded presentation metadata.
 * @param text - rendered result text.
 * @returns the state, or undefined when neither carries one.
 */
export function receiptState(meta: unknown, text: string): ContinuityCommitReceipt['state'] | undefined {
  if (isRecord(meta) && isReceiptState(meta.state)) return meta.state
  const word = /:\s*([a-z-]+)\s*$/.exec(text)?.[1]
  return isReceiptState(word) ? word : undefined
}

/**
 * Read the fields a conflict requires reading again from presentation metadata.
 * @param meta - recorded presentation metadata.
 * @returns the conflicting field keys; empty when none are recorded.
 */
export function receiptConflictKeys(meta: unknown): readonly string[] {
  if (!isRecord(meta) || !Array.isArray(meta.conflictKeys)) return []
  return meta.conflictKeys.filter((key: unknown): key is string => typeof key === 'string')
}

/**
 * The two receipt clauses: what happened in this group, then what reached the main line.
 * @param state - receipt state.
 * @param proposal - whether the decision was submitted as a cross-scope proposal.
 * @param t - `subagent` translator.
 * @returns the leading title and the optional second clause.
 */
export function receiptClauses(state: ReceiptState, proposal: boolean, t: Translate): { title: string; detail?: string } {
  switch (state) {
    case 'running': return { title: t('continuity.receipt.running') }
    case 'failed': return { title: t('continuity.receipt.failed') }
    case 'conflict': return { title: t('continuity.receipt.conflict') }
    case 'no-op': return { title: t('continuity.receipt.noop') }
    case 'duplicate': return { title: t('continuity.receipt.duplicate') }
    case 'commit-uncertain': return { title: t('continuity.receipt.uncertain') }
    case 'committed-local': return { title: t('continuity.receipt.recorded'), detail: t('continuity.receipt.local') }
    case 'deferred': return {
      title: t('continuity.receipt.recorded'),
      detail: t(proposal ? 'continuity.receipt.proposal' : 'continuity.receipt.defer'),
    }
    case 'wake-queued': return {
      title: t('continuity.receipt.recorded'),
      detail: t(proposal ? 'continuity.receipt.proposal' : 'continuity.receipt.wake'),
    }
  }
}

/** Short display of one changed value; structured values read as "updated". */
function valueLabel(value: unknown, t: Translate): string {
  if (value === null || value === undefined) return t('continuity.receipt.cleared')
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return t('continuity.receipt.changed')
}

/**
 * Render the receipt row for every stage of the call.
 * @param props - Tool call stage data and translator.
 * @returns the receipt row.
 */
export function ContinuityReceiptRow(props: ContinuityReceiptRowProps) {
  const { t } = props
  const [open, setOpen] = useState(false)
  let raw = ''
  let state: ReceiptState = 'running'
  let conflictKeys: readonly string[] = []
  if (props.phase === 'start') raw = props.block.argsRaw
  else if (props.phase === 'result') {
    raw = props.block.call?.argsRaw ?? ''
    const text = props.block.content.map(item => item.type === 'text' ? item.text : '').join('\n')
    state = props.block.isError ? 'failed' : receiptState(props.block.meta, text) ?? 'failed'
    conflictKeys = receiptConflictKeys(props.block.meta)
  }
  const args = receiptArgs(raw)
  const { title, detail } = receiptClauses(state, args.proposal, t)
  const reason = args.reason === '' ? undefined : args.reason
  const line = detail !== undefined && reason !== undefined
    ? t('continuity.receipt.line', { detail, reason })
    : detail ?? reason
  const expandable = args.fields.length > 0 || state === 'conflict'
  return (
    <div className={css.chatRow} data-continuity="receipt" data-state={state} aria-label={t('continuity.receipt.title')}>
      <DisclosureRow
        icon={<IconBranchOutlineRegular />}
        title={title}
        running={state === 'running'}
        open={open && expandable}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setOpen(value => !value) }}
        collapsedContent={line === undefined ? undefined : (
          <span className={css.rowSummary}>
            <span className={css.separator} aria-hidden>{t('continuity.receipt.separator')}</span>
            {line}
          </span>
        )}
      >
        <div className={css.detail}>
          {state === 'conflict' && <p className={css.detailNote}>{t('continuity.receipt.conflictHint')}</p>}
          {state === 'conflict' && conflictKeys.length > 0 && (
            <>
              <p className={css.detailHeading}>{t('continuity.receipt.conflictKeys')}</p>
              <ul className={css.detailList}>
                {conflictKeys.map(key => <li key={key} className={css.detailItem}><span className={css.fieldKey}>{key}</span></li>)}
              </ul>
            </>
          )}
          {args.fields.length > 0 && (
            <>
              <p className={css.detailHeading}>{t('continuity.receipt.fields')}</p>
              <ul className={css.detailList}>
                {args.fields.map(field => (
                  <li key={field.key} className={css.detailItem}>
                    <span className={css.fieldKey}>{field.key}</span>
                    <span className={css.fieldValue}>{valueLabel(field.after, t)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
