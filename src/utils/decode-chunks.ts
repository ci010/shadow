import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { isWindows } from './runtime.ts'

/**
 * Detect the active OEM code page on Windows (e.g. 936 -> 'gbk', 949 -> 'euc-kr').
 * Returns undefined on non-Windows or if detection fails.
 */
const oemEncoding: string | undefined = (() => {
  if (!isWindows) return undefined
  const cpToEncoding: Record<string, string> = {
    '437': 'ibm866',
    '866': 'ibm866',
    '932': 'shift_jis',
    '936': 'gbk',
    '949': 'euc-kr',
    '950': 'big5',
    '1252': 'windows-1252',
    '65001': 'utf-8',
  }
  try {
    const result = spawnSync('cmd', ['/c', 'chcp'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error) return undefined
    const output = (result.stdout as Buffer).toString('utf8')
    const match = output.match(/(\d+)\s*$/)
    if (match) {
      return cpToEncoding[match[1]]
    }
  } catch {
    // Ignore detection failures; UTF-8 decoding will still be attempted.
  }
  return undefined
})()

const decoderCache = new Map<string, TextDecoder>()

function getDecoder(encoding: string): TextDecoder {
  let dec = decoderCache.get(encoding)
  if (!dec) {
    dec = new TextDecoder(encoding)
    decoderCache.set(encoding, dec)
  }
  return dec
}

/**
 * Concatenate chunk arrays and decode to string.
 *
 * Uses lazy encoding: tries UTF-8 first for all shells. If the result
 * contains U+FFFD replacement characters (indicating invalid UTF-8 bytes)
 * and an OEM encoding is available, falls back to the OEM code page.
 */
export function decodeChunks(chunks: Uint8Array[], _shell?: unknown): string {
  let totalLen = 0
  for (const c of chunks) totalLen += c.length
  const buf = new Uint8Array(totalLen)
  let offset = 0
  for (const c of chunks) {
    buf.set(c, offset)
    offset += c.length
  }

  const text = getDecoder('utf-8').decode(buf)

  if (!text.includes('\uFFFD') || !oemEncoding || oemEncoding === 'utf-8') {
    return text
  }

  return getDecoder(oemEncoding).decode(buf)
}
