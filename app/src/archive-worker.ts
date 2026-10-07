import wasmUrl from '7z-wasm/7zz.wasm?url'
import { createArchiveEngine, mountArchiveFile } from './archive-engine.ts'
import { ARCHIVE_MAX_BYTES, type ArchiveRequest } from './archive-format.ts'

self.onmessage = async ({ data }: MessageEvent<ArchiveRequest>) => {
  try {
    if (data.file.size > ARCHIVE_MAX_BYTES) throw new Error('Archives larger than 128 MB must be downloaded to browse locally.')
    const engine = await createArchiveEngine({ locateFile: () => wasmUrl })
    const path = mountArchiveFile(engine.module, data.file, data.name)
    const result = engine.run(path, data)
    self.postMessage(result, { transfer: 'bytes' in result ? [result.bytes.buffer] : [] })
  } catch (cause) {
    self.postMessage({ error: cause instanceof Error ? cause.message : 'Could not read this archive. Download it to browse locally.' })
  }
}
