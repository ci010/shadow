import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { SttClient } from './stt-client.ts'

const SUPPORTED_AUDIO_FORMATS = new Set([
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.opus',
  '.m4a',
  '.aac',
  '.webm',
  '.mp4',
])

const MIME_MAP: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.mp4': 'audio/mp4',
}

export class VoicePipeline {
  private tmpDir: string

  constructor(
    private sttClient: SttClient,
    workspace: string,
    tmpDirName = 'tmp',
  ) {
    this.tmpDir = join(workspace, tmpDirName)
  }

  /**
   * Process a voice message:
   * 1. Check format support
   * 2. Save audio to tmp file
   * 3. Call STT service
   * 4. Delete tmp file
   * 5. Return transcribed text
   */
  async processVoice(
    audioData: Uint8Array,
    ext: string,
    sourceId: string,
  ): Promise<string> {
    if (!SUPPORTED_AUDIO_FORMATS.has(ext)) {
      return `[unsupported audio format: ${ext}]`
    }

    const filename = `voice_${sourceId}_${Date.now()}${ext}`
    const tmpPath = join(this.tmpDir, filename)

    try {
      await mkdir(this.tmpDir, { recursive: true })
      await writeFile(tmpPath, audioData)

      const result = await this.sttClient.transcribe(
        audioData,
        filename,
        MIME_MAP[ext],
      )

      return result.text || '[empty transcription result]'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        console.error(`[voice] STT timeout for ${sourceId}`)
        return '[voice transcription timeout]'
      }
      console.error(`[voice] STT failed for ${sourceId}`, err)
      return '[voice transcription failed]'
    } finally {
      try {
        await rm(tmpPath)
      } catch {
        // file may not exist if save failed
      }
    }
  }
}
