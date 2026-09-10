import { createReadStream } from 'node:fs'
import { isNotFoundError } from './runtime.ts'

export interface JsonlReadOptions {
  skipEmpty?: boolean
  onParseError?: (line: string, error: unknown) => void
}

/**
 * Stream a JSONL file line-by-line without loading the whole file into memory.
 */
export async function* streamJsonlLines(
  filePath: string,
  options: { skipEmpty?: boolean } = {},
): AsyncGenerator<string> {
  const { skipEmpty = true } = options

  // Probe the file with a stream so we can mirror the original error semantics
  // (silently return on ENOENT, otherwise rethrow). `createReadStream` is lazy
  // so we await the `open` event before iterating.
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        stream.off('error', onError)
        resolve()
      }
      const onError = (err: unknown) => {
        stream.off('open', onOpen)
        reject(err)
      }
      stream.once('open', onOpen)
      stream.once('error', onError)
    })
  } catch (err) {
    if (isNotFoundError(err)) return
    throw err
  }

  try {
    let buffer = ''
    for await (const chunk of stream as AsyncIterable<string>) {
      buffer += chunk

      while (true) {
        const newlineIdx = buffer.indexOf('\n')
        if (newlineIdx < 0) break

        const rawLine = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)

        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (skipEmpty && !line.trim()) continue
        yield line
      }
    }

    const tail = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
    if (!(skipEmpty && !tail.trim()) && tail.length > 0) {
      yield tail
    }
  } finally {
    stream.destroy()
  }
}

/**
 * Stream parsed JSON objects from a JSONL file.
 */
export async function* streamJsonlObjects<T = Record<string, unknown>>(
  filePath: string,
  options: JsonlReadOptions = {},
): AsyncGenerator<T> {
  const { skipEmpty = true, onParseError } = options

  for await (const line of streamJsonlLines(filePath, { skipEmpty })) {
    try {
      const parsed = JSON.parse(line) as T
      yield parsed
    } catch (error) {
      onParseError?.(line, error)
    }
  }
}
