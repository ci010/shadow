import type { ExecutionContext } from './context.ts'
import { LayerFSTool } from './layerfs.ts'
import { workspaceArguments } from './execution-target.ts'
import { recordFileWrite } from './file-change.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError, completedToolFailure, isCompletedToolFailure, toolResultText, type ToolResult } from './tool.ts'

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
function refuse(message: string): never { throw new ToolNoEffectError(`LayerFS: ${message}. No operation was executed.`) }

/** Only the explicit namespace is intercepted. Old opaque IDs remain accepted by layerfs itself. */
export async function layerfsRoute(kind: 'read' | 'write' | 'exec', input: Record<string, unknown>, context: ExecutionContext, home?: string): Promise<ToolResult | undefined> {
  const a = workspaceArguments(input)
  if (typeof a.workspace !== 'string' || !a.workspace.startsWith('layerfs:')) return undefined
  if (!context.projectId) refuse('Project scope is required')
  if (context.remoteWorkdir) refuse('remote execution is unsupported; no Main fallback')
  if (context.recoveringToolCall) throw new ToolOutcomeUnknownError('LayerFS saved call cannot be reconciled automatically; inspect status/history, do not replay.')
  for (const key of ['nodeId', 'capabilityId', 'resourceId', 'workdirId', 'target', 'grant']) if (a[key] !== undefined) refuse(`unsupported ${key}`)
  let request: Record<string, unknown> = { workspace: a.workspace }
  if (kind === 'exec') {
    if (context.tools?.executionMode === 'call') refuse('leaf exec cannot enforce daemon foreground lifecycle')
    if (typeof a.script !== 'string' || !a.script.trim() || a.script.includes('\0')) refuse('nonempty script required without NUL')
    const shell = a.shell ?? 'sh'
    if (shell !== 'sh' && shell !== 'bash') refuse('only sh and bash are supported, not node or host runtimes')
    if (a.args !== undefined) refuse('args are unsupported; include arguments in script')
    const timeout = a.timeout_ms ?? 120000
    if (!Number.isSafeInteger(timeout) || Number(timeout) < 1 || Number(timeout) > 300000) refuse('timeout_ms must be 1–300000; background is unsupported')
    const cwd = a.cwd ?? '.'
    if (typeof cwd !== 'string' || cwd.startsWith('/') || cwd.includes('\0') || cwd.split('/').includes('..')) refuse('cwd must be a sandbox-relative subdirectory')
    request = { ...request, action: 'exec', command: `cd ${quote(cwd)} && ${shell} -c ${quote(a.script)}`, bridgeTimeoutMs: timeout }
  } else {
    if (typeof a.path !== 'string' || !a.path || a.path.startsWith('/') || a.path.includes('\\') || /^(?:v:|https?:)/i.test(a.path) || a.path.includes('\0') || a.path.split('/').includes('..')) refuse('path must be sandbox-relative without traversal, URL or virtual path')
    if (a.flag !== undefined && a.flag !== '') refuse('flags (including directory listing/numbering/append/global) are unsupported')
    if (kind === 'read') {
      if (a.encoding !== undefined && a.encoding !== 'auto' && a.encoding !== 'utf-8') refuse('only UTF-8 text reads are supported')
      if (/\.(png|jpe?g|gif|webp|bmp|ico|pdf)$/i.test(a.path)) refuse('image and binary reads are unsupported')
      const start = a.offset ?? 1, limit = a.limit ?? 200
      if (!Number.isSafeInteger(start) || Number(start) < 1 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 1000) refuse('offset must be positive and limit must be 1–1000')
      request = { ...request, action: 'read', path: a.path, start, end: Number(start) + Number(limit) - 1 }
    } else {
      if (a.match !== undefined || a.encoding !== undefined && a.encoding !== 'utf8') refuse('match/edit and BOM encoding are unsupported; overwrite only')
      for (const key of ['mode', 'old_str', 'new_str', 'replace_all']) if (a[key] !== undefined) refuse(`unsupported ${key}`)
      if (typeof a.content !== 'string' || a.content.includes('\0')) refuse('UTF-8 text content required without NUL')
      request = { ...request, action: 'write', path: a.path, content: a.content }
    }
  }
  const result = await new LayerFSTool(context.projectId!, home).execute(request, context)
  if (isCompletedToolFailure(result)) return result
  const receipt = JSON.parse(toolResultText(result))
  const code = receipt.result?.code ?? receipt.result?.exitCode
  if (typeof code === 'number' && code !== 0) return completedToolFailure({ isError: true, content: [{ type: 'text', text: toolResultText(result) }] })
  if (kind !== 'write') return result
  if (receipt.result?.code !== 0 && receipt.result?.exitCode !== 0) return result
  const change = await recordFileWrite({ ...context, remoteWorkdir: undefined, fileChangeTarget: undefined }, {
    path: `${a.workspace}/${a.path}`, mode: 'write', after: String(a.content), unavailable: 'LayerFS overwrite: prior sandbox bytes were not captured; this is not a host path.',
  })
  return `${toolResultText(result)}\n${change ? `edit=${change.id}` : 'Historical edit details were not recorded.'}`
}
