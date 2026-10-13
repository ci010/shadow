import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'

export const remoteSchema = z.object({
  baseUrl: z.string().url(), model: z.string().min(1).max(200),
  voice: z.string().min(1).max(200).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
}).strict().superRefine((value, ctx) => {
  const url = new URL(value.baseUrl)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) ctx.addIssue({ code: 'custom', message: 'Audio API requires HTTPS (HTTP only on loopback), no URL credentials/query/hash' })
})
export type RemoteConfig = z.infer<typeof remoteSchema>
export class RemoteAudio {
  constructor(private readonly transport: typeof fetch = fetch, private readonly env: NodeJS.ProcessEnv = process.env) {}
  async request(config: RemoteConfig, task: 'asr' | 'tts', value: string, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted()
    const key = config.apiKeyEnv && this.env[config.apiKeyEnv]
    if (config.apiKeyEnv && !key) throw new Error('Configured audio API key environment variable is unavailable')
    const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {}
    let body: BodyInit
    if (task === 'asr') {
      if ((await stat(value)).size > 25 * 1024 ** 2) throw new Error('Audio API input exceeds 25 MiB')
      const form = new FormData()
      form.set('model', config.model)
      form.set('file', new Blob([new Uint8Array(await readFile(value))]), basename(value))
      body = form
    } else {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify({ model: config.model, input: value, voice: config.voice ?? 'alloy', response_format: 'wav' })
    }
    let response: Response
    try {
      response = await this.transport(config.baseUrl.replace(/\/$/, '') + (task === 'asr' ? '/audio/transcriptions' : '/audio/speech'), {
        method: 'POST', headers, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      })
    } catch { signal?.throwIfAborted(); throw new Error('Audio API transport failed (details withheld to protect credentials)') }
    if (!response.ok) throw new Error(`Audio API request failed: HTTP ${response.status}`)
    return response
  }
  async transcribe(config: RemoteConfig, input: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request(config, 'asr', input, signal)
    const body = await boundedBody(response, 1024 * 1024)
    try {
      const data: unknown = JSON.parse(body.toString('utf8'))
      return z.object({ text: z.string() }).parse(data).text
    } catch { throw new Error('Audio API returned an invalid transcription response (body withheld)') }
  }
  async speak(config: RemoteConfig, text: string, signal?: AbortSignal): Promise<Buffer> {
    return boundedBody(await this.request(config, 'tts', text, signal), 32 * 1024 ** 2)
  }
}
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('Empty audio API response')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks)
      size += value.byteLength
      if (size > limit) throw new Error('Audio API response exceeds size limit')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
}
