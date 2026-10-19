import type { TextEncoding } from '../execution/filesystem/text-encoding.ts'

/** Strict text decoding: only an actual byte cap may leave a pending code point. */
export function decodeReadText(bytes: Uint8Array, requested: TextEncoding, truncated: boolean) {
  const encoding = requested !== 'auto' ? requested
    : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  const binary = () => new Error('Binary file cannot be read as text. Use a tool for its format.')
  if (!encoding.startsWith('utf-16') && bytes.subarray(0, 8192).includes(0)) throw binary()
  let content: string
  try {
    content = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated })
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new Error(`Cannot decode file as ${encoding}. Retry read with the file's encoding, e.g. encoding="gb18030" or encoding="shift_jis" (or utf-16le/utf-16be). Default auto uses BOM or strict UTF-8; it does not guess legacy encodings. Original file unchanged.`)
  }
  if (content.slice(0, 8192).includes('\0')) throw binary()
  return { content, encoding }
}
