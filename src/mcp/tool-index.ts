import { projectStoragePath } from '../utils/data-paths.ts'
import { mkdir, readFile } from 'node:fs/promises'
import type { McpServerConfig } from '../config/schema.ts'
import { writePrivateFile } from '../config/store.ts'
import { McpConnection, type McpToolInfo } from './client.ts'
import { parseMcpServerConfig } from './config.ts'
import { mcpCleanupFailure, mcpFailure, type McpPhase } from './errors.ts'
import { mcpMetadataFingerprint } from './readonly.ts'

export interface IndexedMcpTools {
  indexedAt: string
  tools: McpToolInfo[]
}

const VERSION = 1
const DISCOVERY_TIMEOUT_MS = 60_000
const SOURCE = 'mcp-tool-index'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return
  if ((!Array.isArray(value) && !isRecord(value)) || ancestors.has(value)) {
    throw new Error('Invalid MCP tool index: inputSchema must contain only JSON values')
  }
  ancestors.add(value)
  for (const child of Object.values(value)) assertJson(child, ancestors)
  ancestors.delete(value)
}

function validateTools(value: unknown): McpToolInfo[] {
  if (!Array.isArray(value)) throw new Error('Invalid MCP tool index: tools must be an array')
  const names = new Set<string>()
  return value.map((tool: unknown) => {
    if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name.trim()
      || typeof tool.description !== 'string' || !isRecord(tool.inputSchema)
      || tool.inputSchema.type !== 'object') {
      throw new Error('Invalid MCP tool index: each tool requires a nonempty name, string description and object inputSchema with type "object"')
    }
    if (names.has(tool.name)) throw new Error('Invalid MCP tool index: duplicate tool names')
    names.add(tool.name)
    assertJson(tool.inputSchema)
    if (tool.readOnlyHint !== undefined && typeof tool.readOnlyHint !== 'boolean') {
      throw new Error('Invalid MCP tool index: readOnlyHint must be a boolean')
    }
    let serverVersion: McpToolInfo['serverVersion']
    if (tool.serverVersion !== undefined) {
      if (!isRecord(tool.serverVersion) || typeof tool.serverVersion.name !== 'string'
        || typeof tool.serverVersion.version !== 'string') {
        throw new Error('Invalid MCP tool index: serverVersion must contain name and version strings')
      }
      serverVersion = { name: tool.serverVersion.name, version: tool.serverVersion.version }
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as Record<string, unknown>,
      ...(tool.readOnlyHint !== undefined ? { readOnlyHint: tool.readOnlyHint } : {}),
      ...(serverVersion ? { serverVersion } : {}),
    }
  })
}

function normalized(config: McpServerConfig): McpServerConfig {
  try {
    return parseMcpServerConfig(config.name, config)
  } catch (error) {
    throw mcpFailure(error, { phase: 'validate_config', config, source: SOURCE })
  }
}

function fingerprint(config: McpServerConfig): string {
  return mcpMetadataFingerprint(config)
}

async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation(), cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Immutable config identities keep previous records available for config rollback. */
export class McpToolIndex {
  constructor(private readonly workspace: string) {}

  private path(identity: string): string {
    return projectStoragePath(this.workspace, '.mcp-tool-index', `${identity}.json`)
  }

  async read(config: McpServerConfig): Promise<IndexedMcpTools | undefined> {
    config = normalized(config)
    const identity = fingerprint(config)
    let text: string
    try {
      text = await readFile(this.path(identity), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw mcpFailure(error, { phase: 'read_config', config, source: SOURCE })
    }
    try {
      let record: unknown
      try {
        record = JSON.parse(text)
      } catch {
        // JSON parser messages can contain verbatim, credential-bearing input.
        throw new Error('Invalid MCP tool index: malformed JSON')
      }
      if (!isRecord(record) || record.version !== VERSION) {
        throw new Error('Invalid MCP tool index: unsupported or missing version')
      }
      if (record.fingerprint !== identity) {
        throw new Error('Invalid MCP tool index: configuration fingerprint mismatch')
      }
      if (typeof record.indexedAt !== 'string' || !Number.isFinite(Date.parse(record.indexedAt))
        || new Date(record.indexedAt).toISOString() !== record.indexedAt) {
        throw new Error('Invalid MCP tool index: indexedAt must be an ISO timestamp')
      }
      return { indexedAt: record.indexedAt, tools: validateTools(record.tools) }
    } catch (error) {
      throw mcpFailure(error, { phase: 'read_config', config, source: SOURCE })
    }
  }

  async ensure(config: McpServerConfig, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    config = normalized(config)
    if (await this.read(config)) {
      signal?.throwIfAborted()
      return
    }
    signal?.throwIfAborted()
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new DOMException('MCP tool indexing timed out', 'TimeoutError')), DISCOVERY_TIMEOUT_MS)
    const discoverySignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    const connection = new McpConnection(config, this.workspace)
    let phase: McpPhase = 'connect'
    let failure: Error | undefined
    let tools: McpToolInfo[] = []
    try {
      await abortable(() => connection.connect(discoverySignal), discoverySignal)
      phase = 'list_tools'
      tools = validateTools(await abortable(() => connection.listTools(discoverySignal), discoverySignal))
      discoverySignal.throwIfAborted()
    } catch (error) {
      failure = mcpFailure(error, { phase, config, source: SOURCE })
    } finally {
      clearTimeout(timer)
      try {
        await connection.disconnect()
      } catch (error) {
        failure = failure
          ? mcpCleanupFailure(failure, error, { phase, config, source: SOURCE })
          : mcpFailure(error, { phase: 'disconnect', config, source: SOURCE })
      }
    }
    if (failure) throw failure
    await this.store(config, tools, signal)
  }

  async store(config: McpServerConfig, tools: McpToolInfo[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    config = normalized(config)
    try {
      const record = {
        version: VERSION,
        fingerprint: fingerprint(config),
        indexedAt: new Date().toISOString(),
        tools: validateTools(tools),
      }
      const text = JSON.stringify(record) + '\n'
      await mkdir(projectStoragePath(this.workspace, '.mcp-tool-index'), { recursive: true, mode: 0o700 })
      signal?.throwIfAborted()
      writePrivateFile(this.path(record.fingerprint), text)
    } catch (error) {
      throw mcpFailure(error, { phase: 'list_tools', config, source: SOURCE })
    }
  }
}
