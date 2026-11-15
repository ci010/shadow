import type { ExecutionContext } from '../tools/context.ts'
import { ToolNoEffectError } from '../tools/tool.ts'
import type { FolderRecord } from '../folders/contracts.ts'
import type { LayerFSResources } from '../execution/layerfs/resource-service.ts'
import type { VirtualFsHandler, VirtualFsListHandler } from './virtual-fs.ts'

const guide = `# LayerFS observation
Read-only; never starts a runtime, mounts a sandbox, loads tools, merges or publishes.
v:layerfs/workspaces/<offset> — registered current-Project LayerFS workspaces (100/page).
v:layerfs/<workspace UUID>/branches/<offset> — live official branch inventory.
v:layerfs/<workspace UUID>/history/<offset> — live branch first-parent commits.
v:layerfs/<workspace UUID>/diff/<from commit>/<to commit>/<offset> — immutable commit diff, paths only (no hunks).
Offsets are zero-based SDK pagePos; advance by items.length while hasMore. Live branch/history pages can shift after concurrent publication; retain returned commit IDs and use immutable diff for stable comparisons. SDK byte bounds may shorten pages. Observations require an already-running Project runtime; explicit runtime_start is a separate authorized mutation.
`
export function createLayerFSHandler(options: {
  projectId: string
  folders: () => FolderRecord[]
  existing: () => LayerFSResources | undefined
  remote?: (folder: import('../folders/contracts.ts').LayerFSFolderRecord, action: 'branches' | 'history' | 'diff_commits', args: Record<string, unknown>, context: ExecutionContext) => Promise<string>
}): { read: VirtualFsHandler; list: VirtualFsListHandler } {
  const assert = (context: ExecutionContext) => {
    if (context.projectId !== options.projectId || context.memoryAccess) throw new ToolNoEffectError('Current-Project observation context required.')
    context.signal.throwIfAborted()
  }
  const offset = (text: string | undefined) => {
    if (text !== undefined && !/^(?:0|[1-9][0-9]*)$/.test(text)) throw new ToolNoEffectError('Invalid page offset.')
    const n = Number(text ?? 0)
    if (!Number.isSafeInteger(n)) throw new ToolNoEffectError('Invalid page offset.')
    return n
  }
  const read: VirtualFsHandler = async (subpath, context) => {
    assert(context)
    if (!subpath || subpath === 'overview') return guide
    const parts = subpath.split('/')
    if (parts[0] === 'workspaces' && parts.length <= 2) {
      const pos = offset(parts[1])
      const folders = options.folders().filter(f => f.projectId === options.projectId && f.kind === 'layerfs')
      const items = folders.slice(pos, pos + 100).map(f => ({ id: f.id, name: f.name, path: `v:layerfs/${f.id}/history/0`, branches: `v:layerfs/${f.id}/branches/0` }))
      return JSON.stringify({ items, hasMore: pos + items.length < folders.length, nextPagePos: pos + items.length }, null, 2)
    }
    const folder = options.folders().find(f => f.id === parts[0] && f.projectId === options.projectId && f.kind === 'layerfs')
    if (!folder || folder.kind !== 'layerfs') throw new ToolNoEffectError('Unknown registered current-Project LayerFS workspace.')
    let action: string, args: Record<string, unknown>
    if (['history', 'branches'].includes(parts[1]!) && parts.length === 3) {
      action = parts[1]!
      // Binding itself supplies branch below; callers cannot select an unrelated resource.
      args = { offset: offset(parts[2]) }
    } else if (parts[1] === 'diff' && parts.length === 5 && parts.slice(2, 4).every(p => /^(?:[a-f0-9]{2})+$/.test(p))) {
      action = 'diff_commits'; args = { ref: parts[2], branch: parts[3], offset: offset(parts[4]) }
    } else throw new ToolNoEffectError('Unknown read-only LayerFS observation path. Read v:layerfs/overview.')
    if (folder.location) {
      if (!options.remote) throw new ToolNoEffectError('Remote LayerFS observation unavailable; no local service fallback')
      return options.remote(folder, action as 'branches' | 'history' | 'diff_commits', args, context)
    }
    const service = options.existing()
    if (!service) throw new ToolNoEffectError('LayerFS runtime is not active; observation did not initialize it.')
    return service.observe(action, { workspace: folder.mount, ...args }, context)
  }
  return { read, list: context => { assert(context); return [{ name: 'overview', content: guide }, { name: 'workspaces/0', content: 'Registered LayerFS workspaces; read this path for bounded metadata discovery.' }] } }
}
