import { useSessionFiles } from './composables/useSessionFiles.ts'
import { ARCHIVE_MAX_BYTES, ARCHIVE_MAX_DEPTH, archiveMimeType, type ArchiveReference, type ArchiveMember,
  type ArchiveRequest, type ArchiveResult } from './archive-format.ts'

async function requestArchive(apiBase: string, sessionId: string, folderId: string | undefined,
  archive: ArchiveReference, mode: ArchiveRequest['mode'], signal: AbortSignal, sessionWorkspace = false): Promise<ArchiveResult> {
  signal.throwIfAborted()
  if (archive.members.length > ARCHIVE_MAX_DEPTH) throw new Error('Nested archives are limited to four levels. Download this archive to browse it locally.')
  const file = await useSessionFiles(apiBase, folderId, sessionWorkspace).readBlob(sessionId, archive.path, signal, ARCHIVE_MAX_BYTES)
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./archive-worker.ts', import.meta.url), { type: 'module' })
    const dispose = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate() }
    const fail = (error: Error) => { dispose(); reject(error) }
    const abort = () => fail(signal.reason)
    const timer = setTimeout(() => fail(new Error('Archive operation timed out. Download the archive to browse it locally.')), 30_000)
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = () => fail(new Error('Could not start the archive decoder. Retry or download the archive.'))
    worker.onmessageerror = () => fail(new Error('Could not read the archive decoder response. Retry.'))
    worker.onmessage = (event: MessageEvent<ArchiveResult | { error: string }>) => {
      if ('error' in event.data) fail(new Error(event.data.error))
      else { dispose(); resolve(event.data) }
    }
    try {
      worker.postMessage({ file, name: archive.path.split('/').at(-1)!, members: [...archive.members], mode } satisfies ArchiveRequest)
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error('Could not send this archive to the decoder.'))
    }
  })
}

export async function listArchive(apiBase: string, sessionId: string, folderId: string | undefined,
  archive: ArchiveReference, signal: AbortSignal, sessionWorkspace = false): Promise<ArchiveMember[]> {
  const result = await requestArchive(apiBase, sessionId, folderId, archive, 'list', signal, sessionWorkspace)
  if (!('entries' in result)) throw new Error('Invalid archive directory response.')
  return result.entries
}

export async function readArchiveEntry(apiBase: string, sessionId: string, folderId: string | undefined,
  archive: ArchiveReference, signal: AbortSignal, sessionWorkspace = false): Promise<Blob> {
  const result = await requestArchive(apiBase, sessionId, folderId, archive, 'read', signal, sessionWorkspace)
  if (!('bytes' in result)) throw new Error('Invalid archive file response.')
  return new Blob([result.bytes], { type: archiveMimeType(archive.members.at(-1) ?? '') })
}
