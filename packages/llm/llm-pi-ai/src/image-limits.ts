/** Provider request-image limits and immutable history projection. */
import type { RequestMessage, ImageAttachmentAccessResolver } from '@deepseek-ai/dsh-llm'
import { offloadedImageText } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

/** Wire limits, configurable per route independently of attachment admission. */
export interface RequestImageLimits {
  /** Maximum long edge for a single image. */
  maxDimension?: number
  /** Requests above this occurrence count use manyImageMaxDimension. */
  manyImageThreshold?: number
  /** Maximum long edge for many-image requests. */
  manyImageMaxDimension?: number
  /** Maximum image occurrences, retaining the newest. */
  maxImages?: number
  /** Hard encoded-byte bound on each prepared image. */
  maxImageBytes?: number
  /** Hard aggregate base64-byte bound on retained image occurrences. */
  maxTotalBytes?: number
  /** Long-edge cap after a provider image-limit rejection. */
  recoveryMaxDimension?: number
  /** Newest image occurrences retained after an image-limit rejection. */
  recoveryMaxImages?: number
}

/** Conservative Anthropic wire limits, also applied to aliased Anthropic routes. */
const ANTHROPIC_IMAGE_LIMITS: RequestImageLimits = {
  maxDimension: 8000,
  manyImageThreshold: 1,
  manyImageMaxDimension: 2000,
  maxImages: 100,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  recoveryMaxDimension: 1568,
  recoveryMaxImages: 20,
}

/** Resolve actual wire protocol defaults and deployment overrides. */
export function resolveImageLimits(api: string, configured?: RequestImageLimits): RequestImageLimits {
  return { ...api === 'anthropic-messages' ? ANTHROPIC_IMAGE_LIMITS : {}, ...configured }
}

/** Count image occurrences, including repeated attachments, rather than unique objects. */
export function imageCount(messages: readonly RequestMessage[]): number {
  return messages.reduce((count, message) => count + message.content.filter(block => block.type === 'image' && !block.offloaded).length, 0)
}

/** Determine the long-edge cap from the complete request and recovery stage. */
export function imageDimensionLimit(limits: RequestImageLimits, count: number, recovery: number): number | undefined {
  const caps = [limits.maxDimension]
  if (count > (limits.manyImageThreshold ?? 1)) caps.push(limits.manyImageMaxDimension)
  if (recovery > 0) caps.push(limits.recoveryMaxDimension ?? 1568)
  const present = caps.filter((value): value is number => value !== undefined)
  return present.length === 0 ? undefined : Math.min(...present)
}

function omitted(ref: ImageAttachmentRef, access: ImageAttachmentAccessResolver): { type: 'text'; text: string } {
  return { type: 'text', text: `${offloadedImageText(ref, access(ref))} Image dimensions ${ref.width}x${ref.height}px. Use read_image on the saved path to inspect it again when needed.` }
}

/** Replace oldest or over-budget occurrences only in this request, preserving source events. */
export function limitRequestImages(
  messages: readonly RequestMessage[],
  limits: RequestImageLimits,
  recovery: number,
  access: ImageAttachmentAccessResolver,
  versions?: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>,
): readonly RequestMessage[] {
  const maxImages = recovery >= 2 ? 0 : recovery === 1
    ? Math.min(limits.maxImages ?? Infinity, limits.recoveryMaxImages ?? 20)
    : limits.maxImages ?? Infinity
  let remaining = maxImages
  let bytes = 0
  return messages.toReversed().map(message => ({
    ...message,
    content: message.content.toReversed().map(block => {
      if (block.type !== 'image' || block.offloaded) return block
      const version = versions?.get(block.attachment.attachmentId)
      const encoded = version === undefined ? 0 : 4 * Math.ceil(version.bytes / 3)
      const fits = remaining > 0
        && (version === undefined || version.bytes <= (limits.maxImageBytes ?? Infinity))
        && bytes + encoded <= (limits.maxTotalBytes ?? Infinity)
      if (!fits) return omitted(block.attachment, access)
      remaining--
      bytes += encoded
      return block
    }).toReversed(),
  })).toReversed()
}
