// Conservative metadata signature, NOT a perceptual/visual hash.
// Different encodings/crops are intentionally not treated as the same image.
export function signature(data: Record<string, unknown>): string | null {
  const attachments = data.attachments
  if (!Array.isArray(attachments) || attachments.length !== 4) return null
  const images: string[] = []
  for (const raw of attachments) {
    const image = raw as Record<string, unknown>
    if (typeof image.content_type !== 'string' || !image.content_type.startsWith('image/') ||
      typeof image.width !== 'number' || image.width <= 0 ||
      typeof image.height !== 'number' || image.height <= 0 ||
      typeof image.size !== 'number' || image.size <= 0) return null
    images.push(JSON.stringify([image.content_type,image.width,image.height,image.size]))
  }
  const text = String(data.content ?? '').trim().toLowerCase().replace(/\s+/g,' ')
  return JSON.stringify([text,images.sort()])
}
