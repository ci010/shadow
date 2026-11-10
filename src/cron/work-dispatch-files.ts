import { isUtf8 } from 'node:buffer'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionContext } from '../tools/context.ts'
import { recordFileWrite } from '../tools/file-change.ts'
import { applyReplacementDetailed } from '../tools/filesystem.ts'
import { countLineChanges } from '../tools/line-changes.ts'
import { ToolNoEffectError } from '../tools/tool.ts'
import { formatWriteResult } from '../tools/write-result.ts'
import { projectDataPaths } from '../utils/data-paths.ts'
import { writePrivateFile } from '../utils/private-file.ts'
import { isNotFoundError } from '../utils/runtime.ts'
import type { VirtualFsHandler, VirtualFsListHandler, VirtualFsWriteHandler } from '../vfs/virtual-fs.ts'

const FILES = ['dispatch-instructions.md', 'dispatch-memory.md'] as const
type DispatchFile = typeof FILES[number]
const pendingWrites = new Map<string, Promise<void>>()

/** Serialize read/modify/save across service instances for the same Project file. */
function serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const result = (pendingWrites.get(path) ?? Promise.resolve()).then(operation)
  const settled = result.then(() => {}, () => {})
  pendingWrites.set(path, settled)
  void settled.then(() => { if (pendingWrites.get(path) === settled) pendingWrites.delete(path) })
  return result
}

/**
 * Project-owned dispatcher customization, independent of any session's cwd.
 * Instructions are read fresh by the dispatcher for each run. Memory is an
 * optional scratchpad of ideas, not a fact database or a required per-run log.
 * Missing documents remain virtual empty files until explicitly written.
 */
export class ProjectDispatchFiles {
  private readonly home: string
  private readonly directory: string

  constructor(home: string, private readonly projectId: string) {
    if (!home.trim() || !projectId.trim() || projectId !== projectId.trim()) {
      throw new TypeError('Project home and projectId are required for dispatch files.')
    }
    this.home = projectDataPaths(home).root
    this.directory = join(projectDataPaths(home).state, 'work-dispatch')
  }

  /** Host-side read; the service is already bound to its Project runtime. */
  async instructions(): Promise<string> { return this.text(FILES[0]) }

  /** Host-side optional read; never automatically appended or rewritten. */
  async memory(): Promise<string> { return this.text(FILES[1]) }

  handlers(): { read: VirtualFsHandler; list: VirtualFsListHandler; write: VirtualFsWriteHandler } {
    const read: VirtualFsHandler = async (subpath, context) => {
      this.assertContext(context)
      if (!subpath) return [
        'Project auto-dispatch files:',
        '- v:project/dispatch-instructions.md — supplemental instructions, loaded fresh for each dispatcher run.',
        '- v:project/dispatch-memory.md — optional dispatcher ideas/scratchpad; not a fact database or required per-run log.',
        'Both start empty. Use write to overwrite, or match/content for an exact edit.',
      ].join('\n')
      return this.text(this.file(subpath), context.signal)
    }
    const list: VirtualFsListHandler = async (context, options) => {
      this.assertContext(context)
      const files = options?.subpath ? [this.file(options.subpath)] : FILES
      return Promise.all(files.map(async name => ({
        name, content: options?.content === false ? '' : await this.text(name, context.signal),
      })))
    }
    const write: VirtualFsWriteHandler = async (subpath, request, context) => {
      this.assertContext(context)
      const name = this.file(subpath)
      if (context.tools.executionMode === 'call') throw new Error('Dispatch file writes are unavailable in call mode.')
      return serialize(join(this.directory, name), async () => {
        this.assertContext(context)
        const bytes = await this.bytes(name, context.signal)
        const before = bytes === undefined ? '' : isUtf8(bytes) && !bytes.includes(0) ? bytes.toString('utf8') : undefined
        const editing = request.match !== undefined
        if (editing && bytes === undefined) return `Error: file not found: v:project/${name}`
        if (editing && before === undefined) {
          throw new ToolNoEffectError('Edit requires UTF-8 text; original file unchanged. Convert non-UTF-8 files explicitly before modifying.')
        }
        const edit = editing ? applyReplacementDetailed(before!, request.match!, request.content, request.replaceAll) : undefined
        if (edit === null) return 'Error: match must be nonempty and occur exactly once (or use flag g for all occurrences); original file unchanged.'
        const after = edit?.content ?? request.content
        context.signal.throwIfAborted()
        await mkdir(this.directory, { recursive: true })
        await this.assertPath(name)
        context.signal.throwIfAborted()
        // Synchronous atomic replacement leaves no await between the final path
        // check and commit. Reuse the normal writer's exact edit and receipt code.
        writePrivateFile(join(this.directory, name), after)
        const unavailable = 'Previous file could not be represented as UTF-8 text.'
        // This is Project state, not the selected Folder's filesystem target.
        const change = await recordFileWrite({ ...context, fileChangeTarget: undefined, remoteWorkdir: undefined }, {
          path: join(this.directory, name), mode: editing ? 'edit' : 'write', before, after, unavailable,
        })
        context.signal.throwIfAborted()
        return formatWriteResult({
          mode: editing ? 'edit' : 'write', change, edit: edit ?? undefined,
          unchanged: before === after, global: request.replaceAll,
          lineChanges: before === undefined ? { unavailable } : countLineChanges(before, after),
        })
      })
    }
    return { read, list, write }
  }

  private assertContext(context: ExecutionContext): void {
    if (context.projectId !== this.projectId) throw new Error('Dispatch files belong to a different Project.')
    if (context.memoryAccess) throw new Error('Channel memory leases cannot access Project dispatch files.')
    context.signal.throwIfAborted()
  }

  private file(subpath: string): DispatchFile {
    if (!(FILES as readonly string[]).includes(subpath)) {
      throw new Error('Invalid dispatch path. Use dispatch-instructions.md or dispatch-memory.md under v:project/.')
    }
    return subpath as DispatchFile
  }

  /** Refuse aliases into another Project on reads as well as writes. */
  private async assertPath(name: DispatchFile): Promise<void> {
    for (const [index, path] of [this.home, join(this.home, 'state'), this.directory, join(this.directory, name)].entries()) {
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) {
          throw new Error('Dispatch files cannot follow symlinks, junctions or hard links.')
        }
        if (index < 3 ? !info.isDirectory() : !info.isFile()) throw new Error('Invalid dispatch storage path type.')
      } catch (error) {
        if (!isNotFoundError(error)) throw error
      }
    }
  }

  private async bytes(name: DispatchFile, signal?: AbortSignal): Promise<Buffer | undefined> {
    signal?.throwIfAborted()
    await this.assertPath(name)
    try {
      const bytes = await readFile(join(this.directory, name), { signal })
      signal?.throwIfAborted()
      return bytes
    } catch (error) {
      signal?.throwIfAborted()
      if (!isNotFoundError(error)) throw error
      return undefined
    }
  }

  private async text(name: DispatchFile, signal?: AbortSignal): Promise<string> {
    return (await this.bytes(name, signal))?.toString('utf8') ?? ''
  }
}
