import { imageFromBytes, MAX_IMAGE_BYTES } from '../utils/image-input.ts'
import { ToolOutcomeUnknownError } from '../tools/tool.ts'

export const OPENROUTER_IMAGES_URL = 'https://openrouter.ai/api/v1/images'
const MAX_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
const MAX_RESPONSE_BYTES = MAX_BASE64 + 64 * 1024

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty image response')
  const reader = response.body.getReader()
  try {
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('Oversized image response')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let size = 0
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return JSON.parse(text + decoder.decode())
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('Oversized image response')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Single, non-retried POST; never follows redirects or fetches URLs in the response. */
export async function generateOpenRouterImage(apiKey: string, model: string, prompt: string, signal: AbortSignal,
  send: typeof fetch = fetch) {
  signal.throwIfAborted()
  let status: number | undefined
  try {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    const response = await send(OPENROUTER_IMAGES_URL, {
      method: 'POST', redirect: 'error', signal: requestSignal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, response_format: 'b64_json' }),
    })
    status = response.status
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error('OpenRouter returned an error')
    }
    const result = await readBoundedJson(response) as { data?: { b64_json?: unknown; media_type?: unknown }[] } | null
    requestSignal.throwIfAborted()
    const image = Array.isArray(result?.data) && result.data.length === 1 ? result.data[0] : undefined
    const encoded = image?.b64_json
    if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
      (image?.media_type !== undefined && typeof image.media_type !== 'string')) throw new Error('Invalid image response')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded) throw new Error('Invalid base64 encoding')
    return imageFromBytes(bytes, image?.media_type as string | undefined).part
  } catch {
    // Never surface remote payloads, headers, fetch causes, or credentials. A POST
    // may already have incurred charges even if no usable image was received.
    throw new ToolOutcomeUnknownError(`OpenRouter did not return a usable image${status === undefined ? '' : ` (HTTP ${status})`}. Charges may have occurred. Do not retry automatically.`)
  }
}
