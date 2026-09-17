import { createHash, createHmac, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { REDACTED_SECRET } from '../config/store.ts'
import type { ProjectConfigStore } from '../projects/config-store.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { VirtualFsHandler, VirtualFsWriteHandler } from '../vfs/virtual-fs.ts'
import { parseMcpServerConfig } from './config.ts'

const PLACEHOLDER = '__SHADOW_MCP_REDACTED__:'
const MAX_READ_SNAPSHOTS = 128
type RecordValue = Record<string, unknown>
const isRecord = (value: unknown): value is RecordValue =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function credentialField(key: string, parent: string): boolean {
  return parent === 'env' || parent === 'headers' ||
    /(?:api[-_]?key|token|secret|password|credential|authorization|encryptKey)$/i.test(key)
}

function privateUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return !!(url.username || url.password || url.search || url.hash)
  } catch {
    return false
  }
}

function placeholder(path: string[]): string {
  return PLACEHOLDER + createHash('sha256').update(JSON.stringify(path)).digest('hex')
}

function redact(value: unknown, path: string[] = []): unknown {
  const key = path.at(-1) ?? ''
  const parent = path.at(-2) ?? ''
  if (typeof value === 'string' && value &&
    (credentialField(key, parent) || (key === 'url' && privateUrl(value)))) return placeholder(path)
  if (Array.isArray(value)) return value.map((item, index) => redact(item, [...path, String(index)]))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, [...path, key])]))
}

function restore(value: unknown, previous: unknown, path: string[] = []): unknown {
  if (typeof value === 'string' && (value.includes(PLACEHOLDER) || value.includes(REDACTED_SECRET))) {
    if (value === placeholder(path) && typeof previous === 'string' &&
      redact(previous, path) === value) return previous
    throw new Error('Unknown credential placeholder; reread v:config/mcp.json. Placeholders cannot be moved between fields.')
  }
  if (Array.isArray(value)) return value.map((item, index) =>
    restore(item, Array.isArray(previous) ? previous[index] : undefined, [...path, String(index)]))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, restore(item, isRecord(previous) ? previous[key] : undefined, [...path, key]),
  ]))
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  if (Array.isArray(value)) return value.flatMap(strings)
  return isRecord(value) ? Object.values(value).flatMap(strings) : []
}

function failureMessage(error: unknown, sensitive: string[]): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error)
    messages.push(error.message)
    error = error.cause
  }
  let message = messages.join(' Cause: ') || 'Unknown configuration failure.'
  for (const value of [...new Set(sensitive)].sort((a, b) => b.length - a.length)) {
    // Activation errors can quote either plain text or JSON-escaped credentials.
    for (const spelling of [value, JSON.stringify(value).slice(1, -1)]) {
      message = message.replaceAll(spelling, '[redacted]')
    }
  }
  return message
}

export interface McpConfigHandlerOptions {
  projectId: string
  configStore: ProjectConfigStore
  isReservedName: (name: string) => boolean
}

/** Editable Project configuration, not a connection or server-health endpoint. */
export function createMcpConfigHandler(options: McpConfigHandlerOptions): {
  read: VirtualFsHandler
  write: VirtualFsWriteHandler
} {
  // A runtime-local keyed revision prevents guessing low-entropy secrets from a public hash.
  const revisionKey = randomBytes(32)
  const snapshots = new Map<string, string>()
  const revision = (mcp: unknown) =>
    createHmac('sha256', revisionKey).update(JSON.stringify(mcp ?? {})).digest('hex')
  const document = (mcp: unknown) => JSON.stringify({
    revision: revision(mcp),
    mcpServers: redact(mcp ?? {}),
  }, null, 2) + '\n'
  const sessionKey = (context: ExecutionContext) =>
    JSON.stringify([context.sessionId, context.physicalSessionId])

  function authorize(subpath: string, context: ExecutionContext, writing = false): void {
    context.signal.throwIfAborted()
    if (subpath !== 'mcp.json') throw new Error('Unknown virtual configuration file; use v:config/mcp.json.')
    if (context.projectId !== options.projectId) throw new Error('MCP configuration belongs to a different Project.')
    if (context.remoteWorkdir) throw new Error('MCP configuration requires a local workdir.')
    if (writing && context.tools.executionMode === 'call') throw new Error('MCP configuration writes are unavailable in call mode.')
  }

  const read: VirtualFsHandler = async (subpath, context) => {
    authorize(subpath, context)
    const text = document((await options.configStore.read()).mcp)
    const key = sessionKey(context)
    snapshots.delete(key)
    snapshots.set(key, text)
    if (snapshots.size > MAX_READ_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!)
    return text
  }

  const write: VirtualFsWriteHandler = async (subpath, request, context) => {
    authorize(subpath, context, true)
    let text = request.content
    if (request.match !== undefined) {
      const snapshot = snapshots.get(sessionKey(context))
      if (!snapshot) throw new Error('Read v:config/mcp.json in this session before an exact edit.')
      if (!request.match || !snapshot.includes(request.match)) throw new Error('Exact match string not found in MCP configuration.')
      const index = snapshot.indexOf(request.match)
      if (!request.replaceAll && snapshot.indexOf(request.match, index + request.match.length) !== -1) {
        throw new Error('MCP configuration match is ambiguous; include more context or use flag "g".')
      }
      text = request.replaceAll
        ? snapshot.replaceAll(request.match, () => request.content)
        : snapshot.slice(0, index) + request.content + snapshot.slice(index + request.match.length)
    }
    let input: unknown
    try {
      input = JSON.parse(text)
    } catch {
      throw new Error('Invalid JSON in MCP configuration; no configuration was saved.')
    }
    if (!isRecord(input) || typeof input.revision !== 'string' || !isRecord(input.mcpServers) ||
      Object.keys(input).some(key => key !== 'revision' && key !== 'mcpServers')) {
      throw new Error('MCP configuration must contain only revision (string) and mcpServers (object).')
    }
    const nextDocument = input
    const sensitive: string[] = []
    let savedRevision = ''
    try {
      await options.configStore.update(raw => {
        const previous = raw.mcp ?? {}
        sensitive.push(...strings(previous), ...strings(nextDocument.mcpServers))
        if (nextDocument.revision !== revision(previous)) {
          throw new Error('MCP configuration revision conflict; reread v:config/mcp.json before writing. No configuration was saved.')
        }
        const restored = restore(nextDocument.mcpServers, previous) as RecordValue
        const servers = Object.fromEntries(Object.entries(restored).map(([name, value]) => {
          try {
            const parsed = parseMcpServerConfig(name, value)
            if (isRecord(value) && Object.keys(value).some(key => key !== 'type' && !Object.hasOwn(parsed, key))) {
              throw new Error('Unsupported MCP server configuration properties; no configuration was saved.')
            }
            if (options.isReservedName(name) && (!isRecord(previous) || !Object.hasOwn(previous, name) ||
              !isDeepStrictEqual(parsed, parseMcpServerConfig(name, previous[name])))) {
              throw new Error('MCP server name is reserved by the runtime; existing entries may only be preserved or removed.')
            }
            const { name: _name, transport, ...config } = parsed
            return [name, { ...config, type: transport }]
          } catch (error) {
            if (error instanceof z.ZodError) {
              throw new Error(`Invalid MCP server configuration (${[...new Set(error.issues.map(issue => issue.code))].join(', ')}).`)
            }
            throw error
          }
        }))
        savedRevision = revision(servers)
        return { ...raw, mcp: servers }
      }, context.signal)
    } catch (error) {
      if (context.signal.aborted) throw error
      throw new Error(failureMessage(error, sensitive))
    }
    return `Success: MCP config saved; catalog updated. Revision: ${savedRevision}. Read v:config/mcp.json before further edits. No MCP connection or verification was performed.`
  }
  return { read, write }
}
