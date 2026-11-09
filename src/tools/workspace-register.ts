import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { dirname, parse } from 'node:path'
import { absoluteDirectoryPath, folderDescription, type FolderRegistry } from '../folders/registry.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

/** Reject linked ancestors rather than turning a supplied display/alias path into authority.
 * Like registry admission, this is not an OS sandbox against hostile concurrent renames. */
async function checkedDirectory(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Workspace path must contain only real directories, without linked ancestors.')
    if (dirname(current) === current) break
  }
  const canonical = await realpath(path)
  const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  if (key(canonical) !== key(path)) throw new Error('Workspace path resolves to another location.')
}

export class WorkspaceRegisterTool implements Tool {
  readonly name = 'workspace_register'
  readonly description = 'Register an explicitly user-authorized local directory in the current Project, or create one empty directory and register it. Owner local sessions only; raw paths are local-only, never remote display paths. Uses existing ownership checks, does not transfer ownership, grant permissions or switch sessions. No UI step needed. Retry the same path/mode safely; outputs are retained on failure.'
  readonly parameters: ToolParameters = {
    type: 'object', additionalProperties: false, required: ['path', 'mode'], properties: {
      path: { type: 'string', description: 'Absolute, explicitly user-authorized local directory path; no symlinks, traversal or network paths. Parent must already exist.' },
      mode: { type: 'string', enum: ['existing', 'create_empty'], description: 'existing registers without modifying contents. create_empty creates one directory, or accepts an already empty directory for retry; never overwrites.' },
      description: { type: 'string', description: 'Optional description for new registrations; existing metadata is unchanged.' },
    },
  }
  constructor(private readonly folders: Pick<FolderRegistry, 'register' | 'reserveDestination' | 'acquireAccess'>,
    private readonly projectId: string, private readonly canCreate: (id: string) => boolean) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.projectId !== this.projectId || context.remoteWorkdir || context.scriptInvocation || !this.canCreate(context.sessionId)) {
      throw new Error('Workspace registration is unavailable in this execution context.')
    }
    if (Object.keys(args).some(key => !['path', 'mode', 'description'].includes(key)) || !['existing', 'create_empty'].includes(args.mode as string)) throw new Error('Invalid workspace registration parameters.')
    if (typeof args.path !== 'string' || args.path.split(/[\\/]/).includes('..') || args.path.startsWith('\\\\') || args.path.startsWith('//')) throw new Error('Expected a local absolute path without traversal or network prefixes.')
    const path = absoluteDirectoryPath(args.path)
    if (path === parse(path).root || (process.platform === 'win32' && path.slice(2).includes(':'))) throw new Error('A filesystem root or alternate stream cannot be a Workspace.')
    const description = folderDescription(args.description)
    const release = this.folders.acquireAccess()
    let releaseDestination: (() => void) | undefined
    let created = false
    try {
      context.signal.throwIfAborted()
      await checkedDirectory(dirname(path))
      // Reject foreign ownership / reserved host data before creating anything.
      releaseDestination = await this.folders.reserveDestination(path)
      if (args.mode === 'create_empty') {
        try { await mkdir(path); created = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      await checkedDirectory(path)
      if (args.mode === 'create_empty' && (await readdir(path)).length) throw new Error('create_empty requires an empty directory; contents were not changed. Use existing only if registration of those contents is authorized.')
      context.signal.throwIfAborted()
      const folder = await this.folders.register(path, context.signal, description)
      return JSON.stringify({ workspaceId: folder.id, path: folder.path, created, registered: true })
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Directory retained if present: ${path}. Retry the same path/mode after resolving the failure; no cleanup or session switch was performed.`, { cause: error })
    } finally { releaseDestination?.(); release() }
  }
}
