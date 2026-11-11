import type { ExecutionContext } from './context.ts'
import { LayerFSTool } from './layerfs.ts'
import { workspaceArguments } from './execution-target.ts'
import { recordFileWrite } from './file-change.ts'
import { decodeReadText } from './read-text.ts'
import { isTextEncoding } from '../execution/filesystem/text-encoding.ts'
import { imageFromBytes, isImagePath, MAX_IMAGE_BYTES } from '../utils/image-input.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError, completedToolFailure, isCompletedToolFailure, toolResultText, type ToolResult } from './tool.ts'

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
function refuse(message: string): never { throw new ToolNoEffectError(`LayerFS: ${message}. No operation was executed.`) }
export class LayerFSFileNotFoundError extends Error {}
const READ_LIMIT = 256 * 1024
const WRITE_LIMIT = 65536

/** Backend-specific transport only. Tool arguments and result formatting stay at
 * the ordinary tool boundary; sandbox paths are never interpreted on Main. */
export async function layerfsRoute(kind: 'read' | 'write' | 'exec' | 'search', input: Record<string, unknown>, context: ExecutionContext, home?: string, execLifecycle?: { run: (start: (signal: AbortSignal, observe: (text: string) => void) => Promise<ToolResult>) => Promise<ToolResult> }): Promise<ToolResult | undefined> {
  const a = workspaceArguments(input)
  const workspace = typeof a.workspace === 'string' && a.workspace.startsWith('layerfs:') ? a.workspace : context.layerfsWorkdir?.workspace
  if (!workspace) return undefined
  // Virtual resources are Project/session resources, not sandbox files. Explicit
  // targeting is rejected by executionTargetContext; implicit context may use them.
  if (a.workspace === undefined && (/^(?:v:|https?:)/.test(String(a.path ?? '')) || kind === 'search' && (a.handler === 'web' || /^v:/.test(String(a.query ?? ''))))) return undefined
  if (!context.projectId) refuse('Project scope is required')
  if (context.remoteWorkdir) refuse('conflicting remote execution context; no Main fallback')
  if (context.recoveringToolCall) throw new ToolOutcomeUnknownError('LayerFS saved call cannot be reconciled automatically; inspect status/history, do not replay.')
  for (const key of ['nodeId', 'capabilityId', 'resourceId', 'workdirId', 'target', 'grant']) if (a[key] !== undefined) refuse(`unsupported ${key}`)
  const tool = new LayerFSTool(context.projectId, home)
  const run = async (command: string, captureLimit = 65536, timeout = 120000, allowTruncated = false) => {
    const result = await tool.execute({ action: 'exec', workspace, command, captureLimit, bridgeTimeoutMs: timeout }, context)
    if (isCompletedToolFailure(result)) return { failure: result }
    const receipt = JSON.parse(toolResultText(result))
    const code = receipt.result?.code ?? receipt.result?.exitCode
    if (typeof code !== 'number') throw new ToolOutcomeUnknownError('LayerFS command returned no exit code; inspect before retrying mutations.')
    if (code !== 0) return { failure: completedToolFailure({ isError: true, content: [{ type: 'text', text: toolResultText(result) }] }) }
    if (!allowTruncated && (receipt.result.stdout?.truncated || receipt.result.stderr?.truncated)) throw new Error('LayerFS result exceeded its bounded transport size; narrow the request. Output is incomplete, not an empty result.')
    return { result, stdout: String(receipt.result.stdout?.text ?? '') }
  }
  const path = (value: unknown, fallback?: string) => {
    let p = value ?? fallback
    if (typeof p !== 'string' || !p || p.includes('\\') || /^(?:v:|https?:)/i.test(p) || p.includes('\0') || p.split('/').includes('..')) refuse('path must name a sandbox file without traversal, URL or virtual path')
    if (p.startsWith('/')) {
      let root: unknown
      try { root = JSON.parse(Buffer.from(workspace.slice('layerfs:'.length), 'base64url').toString()).path } catch { refuse('invalid mount ID') }
      if (typeof root !== 'string' || p !== root && !p.startsWith(root + '/')) refuse('absolute path must be inside the selected sandbox workspace')
      p = p.slice(root.length).replace(/^\//, '') || '.'
    }
    return './' + String(p).replace(/^\.\//, '')
  }
  const readBytes = async (p: string, maximum: number) => {
    // Shell/standard Linux utilities are executed inside the mounted workspace.
    // Limit before encoding and reject truncation rather than parsing partial data.
    const result = await run(`if [ -d ${quote(p)} ]; then printf 'D\\n'; LC_ALL=C ls -1Ap -- ${quote(p)}; elif [ -f ${quote(p)} ]; then n=$(wc -c < ${quote(p)}) && [ "$n" -le ${maximum} ] || { printf 'File exceeds read size limit' >&2; exit 3; }; printf 'F\\n'; base64 < ${quote(p)}; elif [ ! -e ${quote(p)} ]; then printf 'M\\n'; else printf 'Not a regular file or directory' >&2; exit 2; fi`, Math.min(8388608, Math.ceil(maximum * 1.5) + 4096))
    if (result.failure) return { failure: result.failure }
    const marker = result.stdout!.slice(0, 2), body = result.stdout!.slice(2)
    if (marker === 'M\n') return { missing: true as const }
    if (marker === 'D\n') return { directory: body.trimEnd() }
    if (marker !== 'F\n' || !/^[A-Za-z0-9+/=\r\n]*$/.test(body)) throw new Error('Invalid LayerFS filesystem transport response.')
    const bytes = Buffer.from(body, 'base64')
    if (bytes.length > maximum) throw new Error('LayerFS file grew beyond the read size limit.')
    return { bytes }
  }
  if (kind === 'exec') {
    if (typeof a.script !== 'string' || !a.script.trim() || a.script.includes('\0')) refuse('nonempty script required without NUL')
    const shell = a.shell ?? 'sh'
    if (shell !== 'sh' && shell !== 'bash') refuse('this Linux workspace supports sh and bash, not the requested runtime')
    if (a.args !== undefined && (!Array.isArray(a.args) || !a.args.every(x => typeof x === 'string' && !x.includes('\0')))) refuse('args must be strings without NUL')
    const timeout = a.timeout_ms ?? 120000
    if (!Number.isSafeInteger(timeout) || Number(timeout) < 0 || Number(timeout) > 2147483647) refuse('timeout_ms must be 0–2147483647')
    const cwd = path(a.cwd, '.')
    const args = (a.args as string[] | undefined) ?? []
    if (!execLifecycle) refuse('exec lifecycle owner is required')
    return execLifecycle.run(async (signal, observe) => {
      let result: ToolResult
      try { result = await tool.execute({ action: 'exec', workspace,
      command: `cd ${quote(cwd)} && ${shell} -c ${quote(a.script as string)} --${args.map(arg => ' ' + quote(arg)).join('')}`,
      captureLimit: 65536 }, { ...context, signal }, { observe })
      } catch (error) {
        // LayerFSTool/configuration throw the abort reason only BEFORE dispatch.
        // Once dispatched runBridge reports unconfirmed cancellation as UNKNOWN.
        if (signal.aborted && error === signal.reason) return completedToolFailure({ isError: true, content: [{ type: 'text', text: 'LayerFS execution cancelled before SDK command dispatch.' }] })
        throw error
      }
      const receipt = JSON.parse(toolResultText(result))
      if (typeof (receipt.result?.code ?? receipt.result?.exitCode) !== 'number') throw new ToolOutcomeUnknownError('LayerFS execution has no process-exit receipt; do not rerun.')
      if ((receipt.result.code ?? receipt.result.exitCode) !== 0) return completedToolFailure({ isError: true, content: [{ type: 'text', text: toolResultText(result) }] })
      return result
    })
  }
  if (kind === 'search') {
    if (a.handler !== 'grep' && a.handler !== 'glob') refuse('filesystem search handler must be grep or glob')
    if (typeof a.query !== 'string' || a.query.includes('\0')) refuse('query must be a string without NUL')
    const limit = a.limit ?? 100, offset = a.offset ?? 0
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(offset) || Number(offset) < 0) refuse('invalid search pagination')
    if (a.include !== undefined && (a.handler !== 'grep' || typeof a.include !== 'string' || !a.include || a.include.startsWith('/') || a.include.includes('\0'))) refuse('include must be a relative grep file glob')
    const root = path(a.path, '.')
    const command = a.handler === 'glob'
      ? `rg --no-config --files --null --hidden --glob '!**/.git/**' --glob '!.DS_Store' --glob ${quote(a.query)} -- ${quote(root)}`
      : `rg --no-config --json --hidden --glob '!**/.git/**' --glob '!.DS_Store'${a.include ? ' --glob ' + quote(String(a.include)) : ''} --regexp ${quote(a.query)} -- ${quote(root)}`
    // rg status 1 is a successful empty search; missing rg/errors remain failures.
    const result = await run(`${command}; code=$?; [ "$code" -le 1 ] || exit "$code"`, 1024 * 1024)
    if (result.failure) return result.failure
    if (a.handler === 'glob') {
      const files = result.stdout!.split('\0').filter(Boolean).map(file => file.replace(/^\.\//, '')).sort()
      const selected = files.slice(Number(offset), Number(offset) + Number(limit))
      return selected.length ? selected.join('\n') + (files.length > Number(offset) + selected.length ? `\n(Showing ${selected.length} of ${files.length} results; continue with offset: ${Number(offset) + selected.length}.)` : '') : files.length ? 'No results at this offset.' : 'No files found'
    }
    const matches: { path: string; line: number; text: string }[] = []
    for (const line of result.stdout!.split('\n').filter(Boolean)) {
      const event = JSON.parse(line)
      if (event.type === 'match') matches.push({ path: event.data.path.text ?? Buffer.from(event.data.path.bytes, 'base64').toString(), line: event.data.line_number, text: (event.data.lines.text ?? Buffer.from(event.data.lines.bytes, 'base64').toString()).replace(/\r?\n$/, '') })
    }
    const selected = matches.slice(Number(offset), Number(offset) + Number(limit))
    if (!selected.length) return matches.length ? 'No results at this offset.' : 'No matches found'
    return `Found ${matches.length} matches${selected.length < matches.length ? ` (showing ${Number(offset) + 1}-${Number(offset) + selected.length})` : ''}\n` + selected.map(m => `${m.path}:\n  Line ${m.line}: ${m.text.slice(0, 2000)}`).join('\n') + (matches.length > Number(offset) + selected.length ? `\n(Showing ${selected.length} of ${matches.length} results; continue with offset: ${Number(offset) + selected.length}.)` : '')
  }
  const p = path(a.path)
  if (kind === 'read') {
    for (const key of ['offset', 'limit']) if (a[key] !== undefined && (!Number.isSafeInteger(a[key]) || Number(a[key]) < 1)) refuse(`${key} must be a positive safe integer`)
    if (a.encoding !== undefined && !isTextEncoding(a.encoding)) refuse('unsupported read encoding')
    const flags = typeof a.flag === 'string' ? a.flag : ''
    const image = isImagePath(String(a.path))
    if (image && (a.offset !== undefined || a.limit !== undefined || flags || a.encoding !== undefined)) refuse('images do not support line paging, flags or text encodings')
    const observed = await readBytes(p, image ? MAX_IMAGE_BYTES : READ_LIMIT)
    if (observed.failure) return observed.failure
    if (observed.missing) throw new LayerFSFileNotFoundError(`File not found in LayerFS workspace: ${String(a.path)}`)
    if (image) {
      if (!observed.bytes) throw new Error('Image input must be a regular file.')
      const decoded = imageFromBytes(observed.bytes)
      return { content: [{ type: 'text', text: `Image from ${JSON.stringify(a.path)} (${decoded.mime}, ${decoded.width} x ${decoded.height}).` }, decoded.part] }
    }
    if (observed.directory !== undefined && a.encoding !== undefined) refuse('encoding requires a text file, not a directory')
    const decoded = observed.bytes ? decodeReadText(observed.bytes, isTextEncoding(a.encoding) ? a.encoding : 'auto', false) : { content: observed.directory ?? '', encoding: 'utf-8' }
    const lines = decoded.content.split('\n'), offset = a.offset === undefined ? 0 : Number(a.offset) - 1
    const selected = lines.slice(offset, a.limit === undefined ? undefined : offset + Number(a.limit))
    let text = flags.includes('n') ? selected.map((line, i) => `${offset + i + 1}\t${line}`).join('\n') : selected.join('\n')
    if (offset + selected.length < lines.length) text += `\n\n[truncated: showing lines ${offset + 1}–${offset + selected.length} of ${lines.length} — use offset=${offset + selected.length + 1} to read more]`
    if (decoded.encoding !== 'utf-8') text = `[encoding: ${decoded.encoding}]\n` + text
    return text
  }
  if (typeof a.content !== 'string' || a.content.includes('\0')) refuse('text content required without NUL')
  const flags = typeof a.flag === 'string' ? a.flag : ''
  if (flags.includes('a') && a.match !== undefined) refuse('append and match cannot be combined')
  if (a.encoding !== undefined && (!['utf8', 'utf8-bom'].includes(String(a.encoding)) || a.match !== undefined || flags.includes('a'))) refuse('encoding is only available for full overwrite')
  if (a.match !== undefined && (typeof a.match !== 'string' || !a.match)) refuse('match must be a nonempty string')
  let content = a.content, before: string | undefined
  const observed = await readBytes(p, WRITE_LIMIT)
  if (observed.failure && (a.match !== undefined || flags.includes('a'))) return observed.failure
  if (observed.directory !== undefined) refuse('write target must be a file')
  if (observed.bytes) before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(observed.bytes)
  else if (observed.missing) before = ''
  if (a.match !== undefined) {
    if (observed.missing) refuse('cannot edit a missing file')
    const { applyReplacementDetailed } = await import('./filesystem.ts')
    const replacement = applyReplacementDetailed(before!, a.match, content, flags.includes('g'))
    if (!replacement) refuse('match must exist exactly once unless flag g is set')
    content = replacement.content
  } else if (flags.includes('a')) content = (before ?? '') + content
  else if (a.encoding === 'utf8-bom' && !content.startsWith('\uFEFF')) content = '\uFEFF' + content
  if (Buffer.byteLength(content) > WRITE_LIMIT) refuse('file write exceeds the current 64 KiB sandbox transport limit')
  const result = await tool.execute({ action: 'write', workspace, path: p, content }, context)
  if (isCompletedToolFailure(result)) return result
  const receipt = JSON.parse(toolResultText(result)), code = receipt.result?.code ?? receipt.result?.exitCode
  if (code !== 0) return completedToolFailure({ isError: true, content: [{ type: 'text', text: toolResultText(result) }] })
  const change = await recordFileWrite({ ...context, remoteWorkdir: undefined }, { path: `${workspace}/${String(a.path)}`, mode: a.match !== undefined ? 'edit' : flags.includes('a') ? 'append' : 'write', before, after: content, unavailable: 'Previous sandbox bytes were unavailable; this is not a host path.' })
  return `OK ${a.match !== undefined ? 'edit' : flags.includes('a') ? 'append' : 'write'} ${String(a.path)}${change ? ` edit=${change.id}` : ''}`
}
