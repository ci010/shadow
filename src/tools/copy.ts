import { randomUUID, createHash } from 'node:crypto'
import { COPY_CHUNK, COPY_MANIFEST_BYTES, COPY_READ, COPY_WRITE, executeCopyFilesystem, parseCopyManifest } from '../execution/filesystem-copy.ts'
import { executeRemoteFilesystemText } from '../execution/remote-filesystem-client.ts'
import { executionTargetContext } from './execution-target.ts'
import type { ExecutionContext } from './context.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError, type Tool } from './tool.ts'

/** Main relays at most one binary chunk; neither bytes nor manifests enter model output. */
export class CopyTool implements Tool {
  readonly name = 'copy'
  readonly supportsRemoteWorkdir = true
  readonly supportsLayerFSWorkdir = true // Explicit endpoints only; inherited locality is ignored.
  readonly description = 'Copy a file or recursive directory (including empty directories) between two explicit registered Project Workspaces on Main or Children. Binary-safe bounded relay via Main. Destination must not exist; its parent must exist. Never deletes the source. No device:/LayerFS, overwrite, merge, resume, metadata preservation or atomic whole-directory guarantee. Relative portable paths only; source_path may be empty for the workspace root. On failure publication may be partial/unknown; inspect before retrying.'
  readonly parameters = { type: 'object' as const, properties: {
    source_workspace: { type: 'string', description: 'Registered Project Workspace selector; required, no default.' },
    source_path: { type: 'string', description: 'Relative source path, or empty string for entire workspace.' },
    destination_workspace: { type: 'string', description: 'Registered Project Workspace selector; required, no default.' },
    destination_path: { type: 'string', description: 'New relative destination name; existing parent required.' },
  }, required: ['source_workspace', 'source_path', 'destination_workspace', 'destination_path'], additionalProperties: false }

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.recoveringToolCall) throw new ToolOutcomeUnknownError('Copy was not replayed. The previous destination/staging outcome is unknown; inspect both endpoints before a new copy.')
    if (Object.keys(args).some(key => !Object.hasOwn(this.parameters.properties, key)) || this.parameters.required.some(key => typeof args[key] !== 'string')) throw new ToolNoEffectError('Copy requires exactly two explicit workspace selectors and relative paths.')
    const source = args.source_workspace as string, destination = args.destination_workspace as string
    if (!source.trim() || !destination.trim() || [source, destination].some(s => /^(device|layerfs):/i.test(s))) throw new ToolNoEffectError('Copy supports registered host-directory Workspaces only; device: and LayerFS are forbidden. No fallback.')
    // Resolve BOTH endpoints independently on the host before touching either.
    const from = await executionTargetContext({ workspace: source }, context, COPY_READ)
    const to = await executionTargetContext({ workspace: destination }, context, COPY_WRITE)
    for (const endpoint of [from, to]) if (endpoint.layerfsWorkdir || (!endpoint.cwd && !endpoint.remoteWorkdir) || endpoint.remoteWorkdir?.workdirId === 'device-home-v1') throw new ToolNoEffectError('Copy endpoint is not a registered host directory. No fallback.')
    // Explicit filesystem grants are independently checked in addition to live copy support.
    await executionTargetContext({ workspace: source }, context, 'filesystem.read')
    await executionTargetContext({ workspace: destination }, context, 'filesystem.write')
    const turnId = context.toolCallId ?? randomUUID()
    const call = async (endpoint: ExecutionContext, operation: string, value: unknown, signal = context.signal): Promise<string> => {
      signal.throwIfAborted()
      if (endpoint.remoteWorkdir) return executeRemoteFilesystemText({ ...endpoint.remoteWorkdir, sessionId: context.sessionId, turnId, signal }, operation, value, COPY_MANIFEST_BYTES + COPY_CHUNK * 2)
      if (!endpoint.cwd) throw new Error('Copy endpoint unavailable; no fallback')
      return executeCopyFilesystem(endpoint.cwd, JSON.stringify([context.projectId, context.sessionId]), operation, value, signal)
    }
    let id: string | undefined
    let began = false
    let publication = false
    try {
      const entries = parseCopyManifest(JSON.parse(await call(from, COPY_READ, { action: 'manifest', path: args.source_path })))
      // Reject overlapping same-workspace copies before creating staging (including aliases).
      const same = from.remoteWorkdir && to.remoteWorkdir
        ? from.remoteWorkdir.nodeId === to.remoteWorkdir.nodeId && from.remoteWorkdir.workdirId === to.remoteWorkdir.workdirId
        : !from.remoteWorkdir && !to.remoteWorkdir && from.cwd === to.cwd
      if (same) {
        const a = String(args.source_path).toLowerCase(), b = String(args.destination_path).toLowerCase()
        if (a === b || !a || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)) throw new ToolNoEffectError('Overlapping source and destination are not supported.')
      }
      began = true // Even a lost begin receipt can leave private staging behind.
      const begin = JSON.parse(await call(to, COPY_WRITE, { action: 'begin', path: args.destination_path, entries }))
      if (typeof begin.id !== 'string') throw new Error('Invalid copy begin receipt')
      id = begin.id
      for (const entry of entries) if (entry.kind === 'file') {
        let offset = 0
        const hash = createHash('sha256')
        while (offset < entry.size) {
          const path = entry.path ? (args.source_path ? `${args.source_path}/${entry.path}` : entry.path) : args.source_path
          const chunk = JSON.parse(await call(from, COPY_READ, { action: 'chunk', path, offset }))
          if (typeof chunk.data !== 'string' || chunk.data.length > Math.ceil(COPY_CHUNK / 3) * 4) throw new Error('Invalid copy chunk')
          const bytes = Buffer.from(chunk.data, 'base64')
          if (!bytes.length || bytes.length > COPY_CHUNK || bytes.length > entry.size - offset || bytes.toString('base64') !== chunk.data) throw new Error('Invalid copy chunk size/encoding')
          hash.update(bytes)
          await call(to, COPY_WRITE, { action: 'chunk', id, path: entry.path, offset, data: chunk.data })
          offset += bytes.length
        }
        if (hash.digest('hex') !== entry.hash) throw new Error('Source changed or relay integrity check failed')
      }
      publication = true
      const result = JSON.parse(await call(to, COPY_WRITE, { action: 'commit', id }))
      if (result.status !== 'completed') throw new Error('Invalid copy completion receipt')
      id = undefined
      return `Copy completed: ${entries.length} entries, ${entries.reduce((n, e) => n + e.size, 0)} bytes. Source unchanged. No metadata preservation.`
    } catch (error) {
      let cleanup = began ? 'Private staging may remain (including after a lost begin receipt); online destination attempts idle staging cleanup after ten minutes, not across restart.' : 'No destination operation admitted.'
      if (id) {
        try {
          await call(to, COPY_WRITE, { action: 'abort', id }, AbortSignal.timeout(10_000))
          cleanup = 'Private staging removed.'
        } catch { cleanup = 'Staging cleanup unconfirmed; destination may be offline. Inspect before retrying.' }
      }
      if (!began) throw error
      throw new ToolOutcomeUnknownError(`Copy did not confirm completion: ${error instanceof Error ? error.message : String(error)}. ${publication ? 'Publication started: destination may be partial or complete; no automatic destination deletion/rollback.' : 'Publication was not requested; destination was not intentionally created.'} ${cleanup} Source was never deleted. Do not blindly replay.`)
    }
  }
}
