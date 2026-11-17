import { writePrivateFile } from '../utils/private-file.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { MaintenanceGate } from '../agent/learning/maintenance-gate.ts'
import { archivePathSchema } from '../agent/learning/maintenance-contracts.ts'
import { readSafe, safePath } from './service.ts'
import { dirname } from 'node:path'
import { isUtf8 } from 'node:buffer'

/** Exact native-revision replacement for existing Wiki documents. Does not
 * create missing sources, permit linked paths, append, or guess old revisions.
 * Shared admission serializes supported writers, not arbitrary external OS edits. */
export class WikiDocumentStore {
  constructor(private readonly home: string) {}
  replace(path: string, expectedRevision: string, bytes: Buffer): string {
    archivePathSchema.parse(path)
    if (!path.startsWith('memory/')) throw new Error('Wiki document path required')
    if (!isUtf8(bytes) || bytes.includes(0)) throw new Error('Wiki replacement must be UTF-8 text')
    return new MaintenanceGate(this.home).writeSync([path], () => {
      const file = projectStoragePath(this.home, path)
      safePath(dirname(file))
      if (safePath(file).nlink !== 1) throw new Error('Hard-linked Wiki sources are protected')
      const before = readSafe(file)
      if (before.revision !== expectedRevision) throw new Error('Wiki exact-CAS conflict')
      writePrivateFile(file, bytes.toString('utf8'))
      const saved = readSafe(file)
      if (!saved.bytes.equals(bytes)) throw new Error('Wiki CAS readback conflict')
      return saved.revision
    })
  }
}
