import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import fixture from './fixtures/session-image-limits.json'
import { PiAiAdapter, type ImageRecoveryDetail } from '../src/adapter.ts'
import { toPiContext } from '../src/context.ts'
import { imageDimensionLimit, limitRequestImages, resolveImageLimits } from '../src/image-limits.ts'
import { resolveProfiles } from '../src/config.ts'
import { isImageLimitError } from '../src/stream.ts'
import { memoryAuth } from './auth-double.ts'
import { anthropicFrame, anthropicMessageStart, anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

const refs: ImageAttachmentRef[] = fixture.images.map(({ attachment }) => ({
  ...attachment, attachmentId: AttachmentId(attachment.attachmentId), mediaType: attachment.mediaType as ImageAttachmentRef['mediaType'],
}))
const messages = refs.map(attachment => createUserMessage({ content: [{ type: 'image', attachment }], source: { kind: 'user' } }))
const toolHistory: RequestMessage[] = fixture.images.filter(row => row.eventType !== 'agent/inbox/spliced').flatMap(({ event, eventType, attachment }): RequestMessage[] => {
  const ref: ImageAttachmentRef = { ...attachment, attachmentId: AttachmentId(attachment.attachmentId), mediaType: attachment.mediaType as ImageAttachmentRef['mediaType'] }
  if (eventType === 'user/message') return [createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } })]
  const id = ToolCallId(`fixture-${event}`)
  return [createAssistantMessage({ source: { provider: 'gateway', model: 'm' }, content: [{ type: 'tool-call', id, name: 'read_image', arguments: '{}' }] }),
    createToolResultMessage({ callId: id, isError: false, content: [{ type: 'image', attachment: ref }] })]
})
const limits = resolveImageLimits('anthropic-messages')
const access = (ref: ImageAttachmentRef) => ({ readonlyPath: `/images/${ref.name}` })

class RequestStore extends AttachmentStore {
  readonly imageLimits = { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] as const }
  readonly targets: ImageRequestTarget[] = []
  validateImage(): Promise<void> { throw new Error('not used') }
  saveImage(): Promise<ImageAttachmentRef> { throw new Error('not used') }
  readImage(): Promise<never> { throw new Error('not used') }
  override async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget): Promise<RequestImageAttachment> {
    this.targets.push(target)
    return { attachment: ref, variantId: ImageVariantId(String(ref.attachmentId)), data: Uint8Array.of(1), bytes: 1,
      width: target.width, height: target.height, mediaType: ref.mediaType, depth: 'uchar', space: 'srgb', hasAlpha: false }
  }
}
afterEach(closeMockServers)

describe('historical request image limits', () => {
  it('bounds every historical preview and leaves all source metadata unchanged', async () => {
    const before = JSON.stringify(messages)
    const store = new RequestStore(new Context())
    await toPiContext({ provider: 'cpa-alias', model: 'm', messages }, {
      attachments: store, resolveImageAccess: access, limits,
    })
    expect(store.targets).toHaveLength(21) // 22 raw parts include one repeated inbox attachment.
    expect(store.targets.every(target => Math.max(target.width, target.height) <= 2000)).toBe(true)
    expect(JSON.stringify(messages)).toBe(before)
    expect(refs.some(ref => ref.width === 1158 && ref.height === 3072)).toBe(true)
    expect(imageDimensionLimit(limits, 1, 0)).toBe(8000)
    expect(imageDimensionLimit(limits, 22, 1)).toBe(1568)
  })

  it('handles 100 and 101 repeated occurrences and hard encoded-byte overflow', async () => {
    expect(limitRequestImages(Array.from({ length: 101 }, () => messages[0]!), limits, 0, access).flatMap(message => message.content).filter(block => block.type === 'image')).toHaveLength(100)
    const store = new RequestStore(new Context())
    const read = store.readImageRequest.bind(store)
    store.readImageRequest = async (ref, target) => ({ ...await read(ref, target), bytes: 2, data: Uint8Array.of(1, 2) })
    const context = await toPiContext({ provider: 'p', model: 'm', messages: [messages[0]!] }, { attachments: store, resolveImageAccess: access, limits: { maxImageBytes: 1 } })
    expect(JSON.stringify(context)).not.toContain('"type":"image"')
  })

  it('retains newest occurrences by count and preserves a recovery path', () => {
    const bounded = limitRequestImages(messages, { maxImages: 2 }, 0, access)
    expect(bounded.slice(0, -2).every(message => message.content[0]?.type === 'text')).toBe(true)
    expect(bounded.at(-1)?.content[0]).toEqual(messages.at(-1)?.content[0])
    expect(JSON.stringify(bounded[0])).toContain('/images/s1.png')
    expect(JSON.stringify(bounded[0])).toContain('2142x1020')
    expect(JSON.stringify(bounded[0])).toContain('read_image')
    expect(limitRequestImages(messages, limits, 2, access).every(message => message.content.every(block => block.type !== 'image'))).toBe(true)
  })

  it('counts duplicate occurrences and exact base64 bytes, including tiny budgets', async () => {
    const store = new RequestStore(new Context())
    const input = [messages[0]!, messages[0]!, messages[1]!]
    const context = await toPiContext({ provider: 'p', model: 'm', messages: input }, {
      attachments: store, resolveImageAccess: access, limits: { maxImages: 2, maxTotalBytes: 4 },
    })
    expect(JSON.stringify(context).match(/"type":"image"/g)).toHaveLength(1)
    const empty = await toPiContext({ provider: 'p', model: 'm', messages: input }, {
      attachments: store, resolveImageAccess: access, limits: { maxImageBytes: 1, maxTotalBytes: 1 },
    })
    expect(JSON.stringify(empty)).not.toContain('"type":"image"')
  })

  it('validates deployment knobs and applies defaults by actual protocol', () => {
    expect(resolveImageLimits('openai-completions')).toEqual({})
    expect(resolveImageLimits('anthropic-messages', { manyImageMaxDimension: 1000 }).manyImageMaxDimension).toBe(1000)
    expect(() => resolveProfiles({ anthropic: { requestImageLimits: { maxImages: 0 } } })).toThrow('requestImageLimits.maxImages')
    expect(isImageLimitError('400 invalid_request_error: At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels')).toBe(true)
    expect(isImageLimitError('400 too many images')).toBe(true)
    expect(isImageLimitError('500 image dimensions exceed maximum')).toBe(false)
    expect(isImageLimitError('image dimensions exceed maximum')).toBe(false)
    expect(isImageLimitError('400 invalid tool schema')).toBe(false)
  })

  it.each([1, 2, 3])('uses bounded progressive repair for %i provider rejection(s)', async (failures) => {
    const server = await mockServer([
      ...Array.from({ length: failures }, () => ({ status: 400, body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels' } }) })),
      { events: anthropicTextEvents },
    ])
    const store = new RequestStore(new Context())
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ gateway: { api: 'anthropic-messages', baseURL: server.url, models: [{ id: 'm', input: ['text', 'image'] }] } }),
      resolveApiKey: async () => 'test-key', auth: memoryAuth(), resolveAttachments: () => store,
      resolveImageAccess: (_store, ref) => access(ref),
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: 'gateway', model: 'm', messages: toolHistory })) chunks.push(chunk)
    expect(server.requests).toHaveLength(Math.min(failures + 1, 3))
    expect(JSON.stringify(server.requests[0])).toContain('"type":"tool_result"')
    const counts = server.requests.map(request => (JSON.stringify(request).match(/"type":"image"/g) ?? []).length)
    expect(counts).toEqual(failures === 1 ? [21, 20] : [21, 20, 0])
    expect(store.targets.slice(21).every(target => Math.max(target.width, target.height) <= 1568)).toBe(true)
    const finish = chunks.findLast(chunk => chunk.type === 'finish')
    if (failures < 3) expect(finish).toMatchObject({ reason: { kind: 'stop' } })
    else expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: expect.stringContaining('recovery failed after 3') } } })
    expect(chunks.filter(chunk => chunk.type === 'usage')).toHaveLength(1)
  })

  it.each([
    { name: 'HTTP 500 with invalid-request image wording', response: { status: 500, body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'image dimensions exceed maximum' } }) }, expected: 'SERVER', requests: 1 },
    { name: 'status-less image invalid-request event', response: { events: [anthropicFrame({ type: 'error', error: { type: 'invalid_request_error', message: 'image dimensions exceed maximum' } })] }, expected: 'stop', requests: 2 },
    { name: 'HTTP 400 non-image invalid request', response: { status: 400, body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'invalid tool schema' } }) }, expected: 'INVALID_REQUEST', requests: 1 },
  ])('keeps terminal classification and request count for $name', async ({ response, expected, requests }) => {
    const server = await mockServer([response, { events: anthropicTextEvents }])
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ gateway: { api: 'anthropic-messages', baseURL: server.url, models: [{ id: 'm', input: ['text', 'image'] }] } }),
      resolveApiKey: async () => 'test-key', auth: memoryAuth(), resolveAttachments: () => new RequestStore(new Context()),
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: 'gateway', model: 'm', messages: [messages[0]!] })) chunks.push(chunk)
    const finish = chunks.findLast(chunk => chunk.type === 'finish')
    expect(finish?.type === 'finish' && finish.reason.kind === 'error' ? finish.reason.failure.code : finish?.reason.kind)
      .toBe(expected)
    expect(server.requests).toHaveLength(requests)
  })
  it.each([false, true])('does not replay ordinary failures or partial output (partial=%s)', async (partial) => {
    const body = JSON.stringify({ error: { type: 'invalid_request_error', message: 'invalid tool schema' } })
    const server = await mockServer(partial ? [{ events: [
      ...anthropicTextEvents.slice(0, 3),
      anthropicFrame({ type: 'error', error: { type: 'invalid_request_error', message: '400 invalid_request_error: too many images' } }),
    ] }] : [{ status: 400, body }])
    const store = new RequestStore(new Context())
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ gateway: { api: 'anthropic-messages', baseURL: server.url, models: [{ id: 'm', input: ['text', 'image'] }] } }),
      resolveApiKey: async () => 'test-key', auth: memoryAuth(), resolveAttachments: () => store,
    })
    for await (const _chunk of adapter.stream({ provider: 'gateway', model: 'm', messages })) { /* consume terminal error */ }
    expect(server.requests).toHaveLength(1)
  })

  it.each(['openai-responses', 'openai-completions'])('preserves default %s byte overflow and image rejection behavior', async (api) => {
    const server = await mockServer([{ status: 400, body: JSON.stringify({ error: { code: 400, type: 'invalid_request_error', message: '400 too many images', status: 'INVALID_ARGUMENT' } }) }])
    const store = new RequestStore(new Context())
    const recoveries: ImageRecoveryDetail[] = []
    const make = (maxRequestImageBytes: number) => new PiAiAdapter({
      profiles: () => resolveProfiles({ gateway: { api, baseURL: server.url, models: [{ id: 'm', input: ['text', 'image'] }], maxRequestImageBytes } }),
      resolveApiKey: async () => 'test-key', auth: memoryAuth(), resolveAttachments: () => store,
      onImageRecovery: detail => { recoveries.push(detail) },
    })
    await expect((async () => { for await (const _chunk of make(1).stream({ provider: 'gateway', model: 'm', messages: [messages[0]!] })) { /* consume */ } })()).rejects.toMatchObject({ code: 'IMAGE_OFFLOAD_REQUIRED' })
    expect(server.requests).toHaveLength(0)
    for await (const _chunk of make(1024).stream({ provider: 'gateway', model: 'm', messages: [messages[0]!] })) { /* consume */ }
    expect(server.requests).toHaveLength(1)
    expect(recoveries).toEqual([])
  })

  it('records sanitized recovery facts and aggregates rejected request usage', async () => {
    const server = await mockServer([{ events: [anthropicMessageStart,
      anthropicFrame({ type: 'error', error: { type: 'invalid_request_error', message: '400 too many images' } }),
    ] }, { events: anthropicTextEvents }])
    const store = new RequestStore(new Context())
    const recoveries: ImageRecoveryDetail[] = []
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ gateway: { api: 'anthropic-messages', baseURL: server.url, models: [{ id: 'm', input: ['text', 'image'] }] } }),
      resolveApiKey: async () => 'test-key', auth: memoryAuth(), resolveAttachments: () => store,
      onImageRecovery: detail => { recoveries.push(detail) },
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: 'gateway', model: 'm', messages: toolHistory })) chunks.push(chunk)
    expect(recoveries).toHaveLength(1)
    expect(recoveries[0]).toMatchObject({ provider: 'gateway', model: 'm', code: 'IMAGE_LIMIT', attempt: 2,
      stage: 'strict-preview', retainedImages: 20, omittedImages: 1, maxDimension: 1568 })
    expect(JSON.stringify(recoveries)).not.toContain('test-key')
    expect(JSON.stringify(recoveries)).not.toContain('base64')
    const usage = chunks.findLast(chunk => chunk.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage.inputTokens).toBe((recoveries[0]?.usage?.inputTokens ?? 0) + 3)
    expect(recoveries[0]?.usage?.inputTokens).toBeGreaterThan(0)
    expect(chunks.findLast(chunk => chunk.type === 'finish')).toMatchObject({ replayState: { response: { imageRecovery: { attempts: 1, stage: 'strict-preview', omittedImages: 1 } } } })
  })

})
