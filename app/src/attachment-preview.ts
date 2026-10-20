/** Read attachment text without buffering an unbounded download. Authorization stays on /api/media. */
export async function readAttachmentBytes(url: string, signal: AbortSignal, limit = 65536): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Attachment unavailable (${response.status})`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Attachment unavailable')
  const output = new Uint8Array(limit + 1)
  let size = 0
  try {
    while (size < output.length) {
      const { done, value } = await reader.read()
      if (done) break
      const count = Math.min(value.length, output.length - size)
      output.set(value.subarray(0, count), size)
      size += count
    }
  } finally { await reader.cancel() }
  return { bytes: output.slice(0, Math.min(size, limit)), truncated: size > limit }
}
