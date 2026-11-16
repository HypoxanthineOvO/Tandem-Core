import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, captureStableAria, compareOrRefreshGolden, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const fixture = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const golden = fileURLToPath(new URL('../../../snapshots/web/failed-input-retry/ui.expected.md', import.meta.url))
const mode = webSnapshotMode()
let scaffold: WebScaffold | undefined
let browser: Browser | undefined
afterEach(async () => { await browser?.close(); await scaffold?.close(); browser = undefined; scaffold = undefined })

it.skipIf(mode === 'record')('keeps failed input visible and retries it without retyping through the real web app', async () => {
  scaffold = await launchWebScaffold({ replayFixture: fixture, compareReplaySession: false })
  const events: SessionEvent[] = []
  scaffold.ctx.on('session/event', (_session, event) => { events.push(event) })
  const stopFailure = scaffold.ctx.on('agent/request', () => { throw new LlmError('Missing account model', 'UNKNOWN_MODEL') })
  browser = await chromium.launch(process.env.DSH_TEST_CHROME ? { executablePath: process.env.DSH_TEST_CHROME } : {})
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const prompt = 'Reply with a one-sentence description of event sourcing, then stop.'
  const failed = scaffold.whenTurnSettled()
  await page.locator('[data-composer-input]').first().fill(prompt)
  await page.locator('[data-composer-input]').first().press('Enter')
  await failed
  const retry = page.getByRole('button', { name: 'Retry this message' })
  await expect.poll(() => retry.isEnabled()).toBe(true)
  expect(await page.locator('[data-queue-dock]').innerText()).toContain(prompt)
  await compareOrRefreshGolden(golden, await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), mode)
  stopFailure()
  const completed = scaffold.whenTurnSettled()
  await retry.click()
  await completed
  expect(events.filter(e => e.type === 'turn/end').map(e => e.data.reason.kind)).toEqual(['error', 'completed'])
  expect(events.filter(e => e.type === 'user/message' && e.data.source.kind === 'user')).toHaveLength(1)
  expect(events.some(e => e.type === 'assistant/message')).toBe(true)
  await expect.poll(() => page.locator('[data-queue-dock]').count()).toBe(0)
})
