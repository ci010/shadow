import { t } from './i18n.ts'
/** SSE framing is independent of network chunks (including split CRLF and UTF-8). */
export function createSseParser(deliver: (type: string, data: string) => void) {
  let line = ''
  let event = ''
  let data: string[] = []
  let cr = false
  let size = 0
  const consume = () => {
    if (!line) {
      if (data.length) deliver(event || 'message', data.join('\n'))
      event = ''; data = []; size = 0
    } else if (!line.startsWith(':')) {
      const separator = line.indexOf(':')
      const field = separator < 0 ? line : line.slice(0, separator)
      const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
      if (field === 'event') event = value
      if (field === 'data') data.push(value)
    }
    line = ''
  }
  return (chunk: string) => {
    for (const character of chunk) {
      if (cr && character === '\n') { cr = false; continue }
      cr = false
      if (++size > 2 * 1024 * 1024) throw new Error(t('Live frame exceeds the mobile limit.'))
      if (character === '\r' || character === '\n') { consume(); cr = character === '\r' }
      else line += character
    }
  }
}

export function createFetchEventSource(url: string, request: typeof fetch = fetch) {
  const events = new EventTarget()
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  void (async () => {
    try {
      const response = await request(url, { headers: { accept: 'text/event-stream' }, signal: controller.signal, cache: 'no-store' })
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error(t('Live connection unavailable.'))
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parse = createSseParser((type, data) => {
        if (!controller.signal.aborted) events.dispatchEvent(new MessageEvent(type, { data }))
      })
      while (!controller.signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) break
        parse(decoder.decode(chunk.value, { stream: true }))
      }
      if (!controller.signal.aborted) events.dispatchEvent(new Event('error'))
    } catch {
      if (!controller.signal.aborted) events.dispatchEvent(new Event('error'))
    } finally { reader?.releaseLock() }
  })()
  return {
    addEventListener: events.addEventListener.bind(events),
    close() { controller.abort(); void reader?.cancel().catch(() => {}) },
  }
}
