/** "Synced" row at the top of the main-line reply that took in a pending batch. */
import { useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { DisclosureRow, IconCheckOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from '../locales.ts'
import type { ContinuitySyncedData } from './synced-definition.ts'
import css from './Continuity.module.css'

/** Full props of the keyed Chat renderer. */
export type ContinuitySyncedRowProps = PropsRuntime<'conversation.chat.node', 'continuity-synced'> & PropsLocale<typeof NS>

/**
 * One-line summary: the first decision, and the total when there are several.
 * @param data - acknowledged batch.
 * @param t - `subagent` translator.
 * @returns localized summary text.
 */
export function syncedSummary(data: ContinuitySyncedData, t: ContinuitySyncedRowProps['t']): string {
  const count = data.items.length
  const first = data.items.find(item => item.summary !== undefined)?.summary
  if (first === undefined) return t('continuity.synced.count', { count })
  return count > 1
    ? t('continuity.synced.other', { first, count })
    : t('continuity.synced.one', { first })
}

/**
 * Render the acknowledged batch as a collapsed process row that expands to
 * its decisions.
 * @param props - Chat node payload and translator.
 * @returns the row.
 */
export function ContinuitySyncedRow({ node, t }: ContinuitySyncedRowProps) {
  const [open, setOpen] = useState(false)
  const { data } = node
  return (
    <div className={css.chatRow} data-continuity="synced">
      <DisclosureRow
        icon={<IconCheckOutlineRegular />}
        title={t('continuity.synced.title')}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => { setOpen(value => !value) }}
        collapsedContent={<span className={css.rowSummary}>{syncedSummary(data, t)}</span>}
      >
        <ul className={css.detailList}>
          {data.items.map(item => (
            <li key={item.id} className={css.detailItem}>{item.summary ?? t('continuity.synced.unknownItem')}</li>
          ))}
        </ul>
      </DisclosureRow>
    </div>
  )
}
