export const OUTPUT_PREVIEW_CHARS = 12_000
// Self-paginated reads and trusted receipts keep their normal format up to this
// ceiling. This measures UTF-16 code units, not tokens or transport bytes.
export const MODEL_TOOL_TEXT_CHARS = 64_000

export function safePrefix(text: string, end: number): string {
  const high = text.charCodeAt(end - 1)
  const low = text.charCodeAt(end)
  return text.slice(0, high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? end - 1 : end)
}

export function outputPreview(text: string, limit = OUTPUT_PREVIEW_CHARS): string {
  if (text.length <= limit) return text
  const prefix = safePrefix(text, limit)
  return `${prefix}\n...[truncated: ${text.length - prefix.length} chars remaining]\n`
}
