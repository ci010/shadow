export const textEncodings = [
  { value: 'auto', label: 'Auto (UTF-8 / BOM)' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'shift_jis', label: 'Shift-JIS (Japanese)' },
  { value: 'gb18030', label: 'GB18030 (Chinese)' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
  { value: 'windows-1252', label: 'Windows-1252' },
] as const

export type TextEncoding = typeof textEncodings[number]['value']
export type DecodedTextEncoding = Exclude<TextEncoding, 'auto'>

export function isTextEncoding(value: unknown): value is TextEncoding {
  return textEncodings.some(encoding => encoding.value === value)
}

export function decodeTextPreview(bytes: Uint8Array, requested: TextEncoding, truncated: boolean): {
  binary: boolean
  encoding: DecodedTextEncoding
  content?: string
  encodingWarning?: string
} {
  const encoding = requested !== 'auto' ? requested
    : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  if (!encoding.startsWith('utf-16') && bytes.includes(0)) return { binary: true, encoding }
  try {
    return { binary: false, encoding, content: new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated }) }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return {
      binary: false, encoding,
      content: new TextDecoder(encoding).decode(bytes, { stream: truncated }),
      encodingWarning: `Some bytes are not valid ${encoding}. Choose the file's text encoding; for Japanese files, try Shift-JIS.`,
    }
  }
}
