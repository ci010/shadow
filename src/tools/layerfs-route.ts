import type { ExecutionContext } from './context.ts'
import { LayerFSTool } from './layerfs.ts'
import { workspaceArguments } from './execution-target.ts'
import { parseBranchWorkspace } from '../execution/layerfs/workspace-identity.ts'
import { isImagePath } from '../utils/image-input.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError, completedToolFailure, isCompletedToolFailure, toolResultText, type ToolResult } from './tool.ts'

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
function refuse(message: string): never { throw new ToolNoEffectError(`LayerFS: ${message}. No operation was executed.`) }
export class LayerFSFileNotFoundError extends Error {}

/** Branch-backed, committed-state transport. No shell filesystem emulation. */
export async function layerfsRoute(kind: 'read' | 'write' | 'exec' | 'search', input: Record<string, unknown>, context: ExecutionContext, home?: string, execLifecycle?: { run: (start: (signal: AbortSignal, observe: (text: string) => void) => Promise<ToolResult>) => Promise<ToolResult> }): Promise<ToolResult | undefined> {
  const a = workspaceArguments(input)
  const workspace = typeof a.workspace === 'string' && a.workspace.startsWith('layerfs:') ? a.workspace : context.layerfsWorkdir?.workspace
  if (!workspace) return undefined
  if (a.workspace === undefined && (/^(?:v:|https?:)/.test(String(a.path ?? '')) || kind === 'search' && (a.handler === 'web' || a.path === undefined && /^v:/.test(String(a.query ?? ''))))) return undefined
  if (!context.projectId) refuse('Project scope is required')
  if (context.remoteWorkdir) refuse('conflicting remote execution context; no Main fallback')
  if (context.recoveringToolCall) throw new ToolOutcomeUnknownError('LayerFS saved call cannot be reconciled automatically; inspect journal/status/history, do not replay.')
  for (const key of ['nodeId', 'capabilityId', 'resourceId', 'workdirId', 'target', 'grant']) if (a[key] !== undefined) refuse(`unsupported ${key}`)
  const identity = parseBranchWorkspace(workspace)
  if ((kind === 'write' || kind === 'exec') && identity.branch === 'main') refuse('main is readonly; fork a branch')
  const tool = new LayerFSTool(context.projectId, home)
  const path = (value: unknown, fallback?: string) => {
    const p = value ?? fallback
    if (typeof p !== 'string' || !p || p.includes('\\') || /^(?:v:|https?:)/i.test(p) || p.includes('\0') || p.split('/').includes('..')) refuse('path must be branch-relative without traversal, URL or virtual path')
    return '/' + p.split('/').filter(s => s && s !== '.').join('/')
  }
  if (kind === 'exec') {
    if (typeof a.script !== 'string' || !a.script.trim() || a.script.includes('\0')) refuse('nonempty script required without NUL')
    const shell = a.shell ?? 'sh'
    if (shell !== 'sh' && shell !== 'bash') refuse('Linux workspace supports sh and bash only')
    if (a.args !== undefined && (!Array.isArray(a.args) || !a.args.every(x => typeof x === 'string' && !x.includes('\0')))) refuse('args must be strings without NUL')
    const timeout = a.timeout_ms ?? 120000
    if (!Number.isSafeInteger(timeout) || Number(timeout) < 0 || Number(timeout) > 2147483647) refuse('timeout_ms must be 0–2147483647')
    const cwd = '.' + path(a.cwd, '/')
    const args = (a.args as string[] | undefined) ?? []
    if (!execLifecycle) refuse('exec lifecycle owner is required')
    return execLifecycle.run(async (signal, observe) => {
      let result: ToolResult
      try {
        result = await tool.execute({ action: 'exec', workspace,
          command: `cd ${quote(cwd)} && ${shell} -c ${quote(a.script as string)} --${args.map(arg => ' ' + quote(arg)).join('')}`,
          captureLimit: 65536 }, { ...context, signal }, { observe })
      } catch (error) {
        if (signal.aborted && error === signal.reason) return completedToolFailure({ isError: true, content: [{ type: 'text', text: 'LayerFS execution cancelled before SDK dispatch.' }] })
        throw error
      }
      if (isCompletedToolFailure(result)) return result
      const receipt = JSON.parse(toolResultText(result))
      if (typeof (receipt.result?.code ?? receipt.result?.exitCode) !== 'number') throw new ToolOutcomeUnknownError('LayerFS execution has no exit receipt; do not rerun.')
      if ((receipt.result.code ?? receipt.result.exitCode) !== 0) return completedToolFailure({ isError: true, content: [{ type: 'text', text: toolResultText(result) }] })
      return result
    })
  }
  const p = path(a.path, kind === 'search' ? '/' : undefined)
  let request: Record<string, unknown>
  if (kind === 'search') {
    if (a.handler !== 'grep' && a.handler !== 'glob') refuse('filesystem search handler must be grep or glob')
    if (typeof a.query !== 'string' || !a.query || a.query.includes('\0')) refuse('nonempty query required')
    if (a.include !== undefined) refuse('SDK grep has no include filter; narrow path instead. Grep is literal, not regex')
    const limit = a.limit ?? 100, offset = a.offset ?? 0
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(offset) || Number(offset) < 0) refuse('invalid SDK page size/position')
    request = { handler: a.handler, query: a.query, limit, offset }
  } else if (kind === 'read') {
    if (isImagePath(String(a.path))) refuse('SDK text reads do not support binary/image input')
    if (a.encoding !== undefined && !['auto', 'utf-8'].includes(String(a.encoding))) refuse('SDK text reads support UTF-8 only')
    for (const key of ['offset', 'limit']) if (a[key] !== undefined && (!Number.isSafeInteger(a[key]) || Number(a[key]) < 1)) refuse(`${key} must be a positive safe integer`)
    if (a.flag !== undefined && (typeof a.flag !== 'string' || /[^nl]/.test(a.flag))) refuse('supported read flags: n/l')
    const start = Number(a.offset ?? 1)
    request = { start, ...(a.limit === undefined ? {} : { end: start + Number(a.limit) - 1 }), offset: start - 1, limit: a.limit }
  } else {
    if (typeof a.content !== 'string' || a.content.includes('\0') || Buffer.byteLength(a.content) > 65536) refuse('UTF-8 content without NUL, at most 64 KiB, required')
    if (a.flag) refuse('SDK exact unique edit/overwrite only; global replacement and append are unsupported')
    if (a.encoding !== undefined && a.encoding !== 'utf8') refuse('SDK writes support UTF-8 only, no encoding conversion')
    if (a.match !== undefined && (typeof a.match !== 'string' || !a.match || a.match.includes('\0') || Buffer.byteLength(a.match) > 65536)) refuse('match must be a nonempty exact UTF-8 string at most 64 KiB')
    request = { content: a.content, match: a.match }
  }
  const result = await tool.execute({ action: kind, workspace, path: p, ...request }, context)
  const receipt = JSON.parse(toolResultText(result))
  if (isCompletedToolFailure(result)) {
    if (kind === 'read' && receipt.error?.code === 'NoSuchPath') throw new LayerFSFileNotFoundError(`File not found in LayerFS branch: ${p}`)
    return result
  }
  if (kind === 'read' && a.requireFile && typeof receipt.result?.text !== 'string') throw new Error('LayerFS instructions must be a complete text file, not a directory.')
  if (kind === 'read' && typeof receipt.result?.text === 'string') {
    const text = receipt.result.text as string
    if (String(a.flag ?? '').includes('n')) return text.split('\n').map((line, i) => `${Number(a.offset ?? 1) + i}\t${line}`).join('\n')
    return text
  }
  // Preserve native pagination and checkpoint metadata, never fabricate total
  // counts or offset continuations. Directory offset is SDK pagePos (zero based
  // after conversion from the read tool's one-based item index).
  return JSON.stringify({ ...receipt, semantics: kind === 'write' ? 'Committed automatically; exact SDK edit (no newline normalization). No host edit patch.' : 'SDK page: continue using nextPagePos as search offset (directory read offset = nextPagePos + 1). Grep is literal; skipped counts binary files.' })
}
