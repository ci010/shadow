import { FILESYSTEM_READ_OPERATION } from '../execution/capability-filesystem.ts'
import { configuration, layerfsName, runBridge } from '../execution/layerfs/bridge.ts'
import type { ExecutionContext } from './context.ts'
import { completedToolFailure, type Tool, type ToolParameters, type ToolResult } from './tool.ts'

const actions = ['create', 'list', 'branches', 'history', 'fork', 'load', 'mount', 'status', 'read', 'write', 'exec', 'commit', 'close', 'diff', 'merge', 'publish'] as const
const workspaceActions = new Set(['status', 'read', 'write', 'exec', 'commit', 'close'])
const busy = new Set<string>()
export function validateLayerArgs(a: Record<string, unknown>, project: string): void {
  if (!actions.includes(a.action as typeof actions[number])) throw new Error('Unsupported LayerFS action.')
  const required: Record<string, string[]> = {
    create: ['workspace'], history: ['branch'], fork: ['branch'], load: ['branch', 'ref'], mount: ['branch'],
    read: ['path'], write: ['path', 'content'], exec: ['command'], diff: ['ref', 'branch'], merge: ['ref', 'branch', 'name'], publish: ['branch'],
  }
  for (const key of required[String(a.action)] ?? []) if (typeof a[key] !== 'string' || (key !== 'content' && !a[key])) throw new Error(`Missing ${key}.`)
  for (const key of ['branch', 'ref', 'name', 'message', 'command', 'path', 'workspace', 'content']) {
    if (a[key] !== undefined && typeof a[key] !== 'string') throw new Error(`Invalid ${key}.`)
  }
  if (typeof a.content === 'string' && Buffer.byteLength(a.content) > 65536) throw new Error('Write is limited to 64 KiB per call.')
  if (typeof a.command === 'string' && Buffer.byteLength(a.command) > 65536) throw new Error('Command too large.')
  if (a.path !== undefined && (!a.path || String(a.path).includes('\0') || String(a.path).split('/').includes('..'))) throw new Error('Expected sandbox-relative file path without traversal.')
  if (a.offset !== undefined && (!Number.isSafeInteger(a.offset) || Number(a.offset) < 0)) throw new Error('Invalid page offset.')
  if (a.action === 'read') {
    a.start ??= 1; a.end ??= Number(a.start) + 199
    if (!Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) || Number(a.start) < 1 || Number(a.end) < Number(a.start) || Number(a.end) - Number(a.start) > 999) throw new Error('Read requires 1–1000 lines.')
  }
  if (workspaceActions.has(String(a.action))) {
    if (typeof a.workspace !== 'string' || a.workspace.length > 1024) throw new Error('Expected LayerFS workspace ID returned by mount.')
    let ws: { project?: string; sandbox?: string; path?: string }
    try { ws = JSON.parse(Buffer.from(a.workspace.replace(/^layerfs:/, ''), 'base64url').toString()) } catch { throw new Error('Invalid LayerFS workspace ID.') }
    if (ws.project !== project || !/^\d+$/.test(ws.sandbox ?? '') || !/^\/workspaces\/\d+$/.test(ws.path ?? '')) throw new Error('Workspace ID is invalid or belongs to another Project.')
  }
}

export class LayerFSTool implements Tool<ToolResult> {
  readonly name = 'layerfs'
  readonly description = 'Optional real LayerFS 1.1 SDK bridge. Explicit operator setup required. create recursively imports a registered local workspace (including all files; do not import credentials); fork/load creates a new branch (load requires historical ref), mount returns a sandbox workspace ID. Use ordinary read/write/exec workspace with that ID (bounded UTF-8 files/overwrite and sh/bash only; see skill); never use its container path as a host workspace. commit checkpoints without overwriting source; close refuses dirty workspaces. publish updates LayerFS main, NOT source files. No retries on unknown outcomes. See v:skills/layerfs.'
  readonly parameters: ToolParameters = {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: [...actions] },
      ...Object.fromEntries(['workspace', 'branch', 'ref', 'name', 'path', 'content', 'command', 'message'].map(key => [key, { type: 'string' }])),
      offset: { type: 'integer' }, start: { type: 'integer' }, end: { type: 'integer' },
    }, required: ['action'],
  }
  constructor(private readonly projectId: string) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult> {
    if (context.projectId !== this.projectId) throw new Error('LayerFS Project mismatch.')
    if (context.remoteWorkdir) throw new Error('LayerFS remote execution is unsupported; no Main fallback.')
    context.signal.throwIfAborted()
    const project = layerfsName(this.projectId), a = { ...args }
    validateLayerArgs(a, project)
    const selected = workspaceActions.has(String(a.action)) ? JSON.parse(Buffer.from(String(a.workspace).replace(/^layerfs:/, ''), 'base64url').toString()) : undefined
    const lock = selected ? `${project}:${selected.sandbox}:${selected.path}` : `${project}:management`
    if (busy.has(lock)) throw new Error('LayerFS Project operation already in flight; wait for its receipt, do not replay.')
    busy.add(lock)
    try {
      const config = await configuration(this.projectId)
      if (a.action === 'create') {
        if (!context.resolveToolTarget) throw new Error('Registered workspace authorization is unavailable.')
        const target = await context.resolveToolTarget(String(a.workspace), FILESYSTEM_READ_OPERATION)
        if (target.remoteWorkdir || !target.cwd) throw new Error('LayerFS import requires a registered local workspace; no fallback.')
        a.source = target.cwd
      }
      context.signal.throwIfAborted()
      const output = await runBridge(config, project, String(a.action), a, context.signal, typeof a.bridgeTimeoutMs === 'number' ? a.bridgeTimeoutMs : undefined)
      // A definite SDK refusal is a completed failure, not a successful text result.
      // This does not claim rollback/no effect; Unknown is raised by the bridge.
      if (JSON.parse(output).ok === false) return completedToolFailure({
        isError: true, content: [{ type: 'text', text: output }],
      })
      return output
    } finally { busy.delete(lock) }
  }
}
