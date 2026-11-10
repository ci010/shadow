import type { ExecutionContext } from '../tools/context.ts'
import { executeRemoteFilesystemText, RemoteFilesystemError } from '../execution/remote-filesystem-client.ts'
import { FILESYSTEM_READ_OPERATION } from '../execution/capability-filesystem.ts'
import { parseSkillFile } from './parse.ts'
import type { FolderSkill, FolderSkillScope } from './folder.ts'

const LIMIT = 256 * 1024
const ROOT = '.agents/skills'
function safeParts(path: string): void {
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0\r\n:]/.test(part))) throw new Error('Invalid remote skill resource path')
}

/** Never uses the remote display path on Main. Authorization is resolved per read. */
async function read(scope: FolderSkillScope, context: ExecutionContext, path: string, within: string, kind?: 'file'): Promise<string> {
  context.signal.throwIfAborted()
  if (!scope.workdir || !context.resolveToolTarget) throw new Error('Remote skill filesystem authorization is unavailable')
  const target = await context.resolveToolTarget(scope.folderId, FILESYSTEM_READ_OPERATION)
  const remote = target.remoteWorkdir
  if (!remote || remote.nodeId !== scope.workdir.nodeId || remote.workdirId !== scope.workdir.workdirId) throw new Error('Remote skill target does not match selected workspace')
  return executeRemoteFilesystemText({ ...remote, sessionId: context.sessionId, turnId: context.toolCallId ?? crypto.randomUUID(), signal: context.signal }, FILESYSTEM_READ_OPERATION, { path, within, ...(kind ? { kind } : {}) }, LIMIT)
}
export async function discoverRemoteFolderSkills(scope: FolderSkillScope, admin: boolean, context: ExecutionContext): Promise<FolderSkill[]> {
  let listing: string
  try { listing = await read(scope, context, ROOT, '.') } catch (error) {
    if (error instanceof RemoteFilesystemError && error.code === 'file-not-found') return []
    throw error
  }
  const result: FolderSkill[] = []
  const entries = listing.split('\n').sort()
  if (entries.length > 1000) throw new Error('Remote skill discovery count limit exceeded')
  for (const entry of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/$/.test(entry)) continue
    const name = entry.slice(0, -1)
    const dir = `${ROOT}/${name}`
    let content: string
    try { content = await read(scope, context, `${dir}/SKILL.md`, dir, 'file') } catch (error) {
      if (error instanceof RemoteFilesystemError && error.code === 'file-not-found') continue
      throw error
    }
    const parsed = parseSkillFile(content, name)
    if (parsed.meta.admin && !admin) continue
    if (parsed.meta.name !== name) throw new Error(`Folder skill name must match directory: ${name}`)
    // Remote platform restrictions cannot be evaluated against Main's OS/architecture.
    result.push({ ...parsed, dirPath: dir, isLearned: parsed.learnedMeta !== undefined, folderScope: scope })
  }
  return result
}
export function readRemoteFolderSkillResource(skill: FolderSkill, resource: string, context: ExecutionContext): Promise<string> {
  safeParts(resource)
  return read(skill.folderScope, context, `${skill.dirPath}/${resource}`, skill.dirPath, 'file')
}
export async function listRemoteFolderSkillResources(skill: FolderSkill, context: ExecutionContext): Promise<string[]> {
  const result: string[] = []
  let count = 0
  async function walk(prefix: string, depth: number): Promise<void> {
    if (depth > 16) throw new Error('Remote skill resource nesting limit exceeded')
    const listing = await read(skill.folderScope, context, `${skill.dirPath}${prefix ? `/${prefix}` : ''}`, skill.dirPath)
    for (const entry of listing.split('\n')) {
      if (!entry) continue
      if (++count > 1000) throw new Error('Remote skill resource count limit exceeded')
      const directory = entry.endsWith('/')
      const name = directory ? entry.slice(0, -1) : entry
      safeParts(name)
      if (name.includes('/')) throw new Error('Invalid remote directory entry')
      const path = prefix ? `${prefix}/${name}` : name
      if (directory) await walk(path, depth + 1)
      else if (path !== 'SKILL.md') result.push(path)
    }
  }
  await walk('', 0)
  return result
}
