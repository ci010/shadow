import { diagnosticEndpoint, diagnosticId, DIAGNOSTIC_ID_HEADER } from './api-request-diagnostic.ts'

/** One bounded reporter per proxy instance. Fixed labels/numbers only. */
export function createForwardDiagnostics(side: 'main' | 'child', report: (message: string) => void = console.warn,
  now: () => number = () => performance.now()) {
  let windowStart = now()
  let count = 0
  return (path: string) => {
    // Keep this targeted: no stream interception for other routes (including SSE).
    if (diagnosticEndpoint(path.split(/[?#]/, 1)[0]!) !== 'sessions/summary') return undefined
    if (now() - windowStart >= 60_000) { windowStart = now(); count = 0 }
    if (count++ >= 60) return undefined
    const start = now()
    const elapsed = () => Math.max(0, Math.round(now() - start))
    let proofMs: number | undefined
    let headersMs: number | undefined
    let status: number | undefined
    let id: string | undefined
    let bytes = 0
    let terminal = false
    const emit = (stage: 'headers' | 'terminal', completion?: 'eof' | 'cancel' | 'abort' | 'error' | 'bodyless') => {
      try { report(`API forward ${JSON.stringify({ side, endpoint: 'sessions/summary', id, stage, status, proofMs, headersMs, bytes, elapsedMs: elapsed(), completion })}`) } catch { /* diagnostic only */ }
    }
    const finish = (completion: 'eof' | 'cancel' | 'abort' | 'error' | 'bodyless') => {
      if (terminal) return
      terminal = true
      emit('terminal', completion)
    }
    return {
      proofReady() { proofMs = elapsed() },
      fail(signal: AbortSignal) { finish(signal.aborted ? 'abort' : 'error') },
      response(response: Response, signal: AbortSignal): Response {
        status = response.status
        id = diagnosticId(response.headers.get(DIAGNOSTIC_ID_HEADER))
        headersMs = elapsed()
        emit('headers')
        if (!response.body) { finish('bodyless'); return response }
        const reader = response.body.getReader()
        const cleanup = () => signal.removeEventListener('abort', abort)
        const end = (completion: 'eof' | 'cancel' | 'abort' | 'error') => { cleanup(); finish(completion) }
        const abort = () => { end('abort') }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        const body = new ReadableStream<Uint8Array>({
          async pull(output) {
            try {
              const part = await reader.read()
              if (part.done) { end(signal.aborted ? 'abort' : 'eof'); output.close() }
              else { bytes += part.value.byteLength; output.enqueue(part.value) }
            } catch (error) { end(signal.aborted ? 'abort' : 'error'); output.error(error) }
          },
          cancel(reason) { end(signal.aborted ? 'abort' : 'cancel'); return reader.cancel(reason) },
        }, { highWaterMark: 0 })
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      },
    }
  }
}
