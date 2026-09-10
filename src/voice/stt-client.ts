export interface SttResponse {
  model: string
  duration: number
  text: string
  segments: Array<{
    id: number
    speaker: string
    start: number
    end: number
    text: string
  }>
}

export interface SttResult {
  text: string
  duration?: number
}

export class SttClient {
  constructor(private sttUrl: string, private timeoutMs = 30_000) {}

  async transcribe(
    audioData: Uint8Array,
    filename: string,
    mimeType?: string,
  ): Promise<SttResult> {
    const form = new FormData()
    form.append(
      'file',
      new Blob([audioData.buffer as ArrayBuffer], { type: mimeType ?? 'application/octet-stream' }),
      filename,
    )

    const res = await fetch(this.sttUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!res.ok) {
      throw new Error(`STT request failed: ${res.status} ${res.statusText}`)
    }

    const json = (await res.json()) as SttResponse
    return {
      text: json.text,
      duration: json.duration,
    }
  }
}
