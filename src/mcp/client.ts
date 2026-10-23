import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolResultSchema, ListRootsRequestSchema, ToolListChangedNotificationSchema, type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { access, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { env as sysEnv } from 'node:process'
import type { McpServerConfig } from '../config/schema.ts'
import { Span } from '../otel/tracing.ts'
import { loadDotEnv } from '../utils/env.ts'
import { decodeChunks } from '../utils/decode-chunks.ts'
import { parseMcpServerConfig } from './config.ts'
import { mcpCleanupFailure, mcpFailure, mcpSecrets, type McpPhase } from './errors.ts'
import { readableMcpText } from './text.ts'

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnlyHint?: boolean
  serverVersion?: { name: string; version: string }
}

interface ConnectionState {
  client: Client
  abort: AbortController
  transport?: Transport
  ready: boolean
  stderr: string
  transportError?: Error
}

async function checkExplicitCommand(command: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!isAbsolute(command)) return
  try {
    await access(command)
  } catch (error) {
    if (process.platform !== 'win32' || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    // Check possible suffixes without replacing the SDK's command resolution.
    const extensions = new Set(['.EXE', '.CMD', '.BAT', '.COM', ...[sysEnv, env].flatMap(environment =>
      Object.entries(environment).filter(([key]) => key.toUpperCase() === 'PATHEXT')
        .flatMap(([, value]) => value?.split(';').filter(Boolean) ?? []))])
    for (const extension of extensions) {
      try {
        await access(command + extension)
        return
      } catch (candidateError) {
        if (!(candidateError instanceof Error && 'code' in candidateError && candidateError.code === 'ENOENT')) throw candidateError
      }
    }
    throw error
  }
}

function publicContent(block: ContentBlock): Record<string, unknown> {
  // SDK schemas strip unknown fields; _meta remains protocol-private.
  const { _meta, ...content } = block
  if (block.type === 'resource') {
    const { _meta: resourceMeta, ...resource } = block.resource
    return { ...content, resource }
  }
  if (block.type === 'text') return { ...content, text: readableMcpText(block.text) }
  return content
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([operation, cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Manages a connection to a single external MCP server.
 */
export class McpConnection {
  private state?: ConnectionState
  private toolsChangedHandler?: () => void
  private diagnosticSecrets: string[] = []

  constructor(
    readonly config: McpServerConfig,
    private readonly cwd?: string,
    readonly workspaceRoot?: string,
  ) {}

  @Span('McpConnection.connect')
  async connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.state) throw new Error('MCP connection is already connected or connecting')
    let config: McpServerConfig
    try {
      config = parseMcpServerConfig(this.config.name, this.config)
    } catch (error) {
      throw mcpFailure(error, { phase: 'validate_config', config: this.config })
    }
    if (this.workspaceRoot && !isAbsolute(this.workspaceRoot)) throw new Error('MCP workspace roots must be resolved local directories')
    const state: ConnectionState = {
      client: new Client({ name: 'bot-agent', version: '0.1.0' }, { capabilities: this.workspaceRoot ? { roots: {} } : {} }),
      abort: new AbortController(),
      ready: false,
      stderr: '',
    }
    this.state = state
    state.client.onerror = error => { state.transportError = error }
    state.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (this.state === state && state.ready) this.toolsChangedHandler?.()
    })
    const startupSignal = signal
      ? AbortSignal.any([signal, state.abort.signal])
      : state.abort.signal
    const startedAt = performance.now()
    try {
      if (this.workspaceRoot) {
        const roots = [{ uri: pathToFileURL(await realpath(this.workspaceRoot)).href, name: 'Session workdir' }]
        startupSignal.throwIfAborted()
        state.client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots }))
      }
      const transport = await this.createTransport(config, startupSignal)
      // Client.connect also closes failed initialization. Share cleanup so a
      // concurrent abort cannot close the same transport twice.
      const close = transport.close.bind(transport)
      let closing: Promise<void> | undefined
      transport.close = () => closing ??= close()
      state.transport = transport
      startupSignal.throwIfAborted()
      await abortable(state.client.connect(transport, { signal: startupSignal }), startupSignal)
      startupSignal.throwIfAborted()
      state.ready = true
      state.transportError = undefined
    } catch (error) {
      const failure = this.safeFailure(error, 'connect', startupSignal, state.stderr, Math.round(performance.now() - startedAt))
      try {
        await state.transport?.close()
      } catch (cleanupError) {
        throw mcpCleanupFailure(failure, cleanupError, {
          phase: 'connect', config: this.config, secrets: this.diagnosticSecrets,
        })
      } finally {
        if (this.state === state) this.state = undefined
      }
      throw failure
    }
  }

  private async createTransport(config: McpServerConfig, signal: AbortSignal): Promise<Transport> {
    switch (config.transport) {
      case 'stdio': {
        if (!config.command) {
          throw new Error(
            `MCP server "${this.config.name}" requires a command for stdio transport`,
          )
        }
        // Merge workspace .env (lowest priority) → process env → config env (highest priority)
        const dotEnv = this.cwd ? await loadDotEnv(this.cwd) : {}
        signal.throwIfAborted()
        const mergedEnv = {
          ...dotEnv,
          ...Object.fromEntries(
            Object.entries(sysEnv).filter((entry): entry is [string, string] =>
              entry[1] !== undefined
            ),
          ),
          ...config.env,
        }
        this.diagnosticSecrets = mcpSecrets(config, mergedEnv)
        // An explicit path can fail before the SDK's Windows command wrapper
        // replaces native ENOENT with a localized shell message.
        await checkExplicitCommand(config.command, mergedEnv)
        signal.throwIfAborted()
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
          cwd: this.cwd,
          stderr: 'pipe',
        })
        const state = this.state
        let exceeded = false
        let stderrBytes = 0
        const stderrChunks: Uint8Array[] = []
        const stderr = transport.stderr
        stderr?.on('data', (chunk: string | Buffer) => {
          if (!state || exceeded) return
          const bytes = Buffer.from(chunk)
          stderrBytes += bytes.byteLength
          if (stderrBytes > 32_768) {
            state.stderr = '[stderr omitted: exceeded diagnostic capture limit]'
            stderrChunks.length = 0
            exceeded = true
          } else {
            stderrChunks.push(bytes)
            state.stderr = decodeChunks(stderrChunks)
          }
        })
        return transport
      }
      case 'sse': {
        if (!config.url) throw new Error('SSE transport requires a URL')
        return new SSEClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers },
        })
      }
      case 'streamable-http': {
        if (!config.url) throw new Error('Streamable HTTP transport requires a URL')
        return new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers },
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
          },
        })
      }
      default:
        throw new Error('Invalid MCP transport')
    }
  }

  @Span('McpConnection.disconnect')
  async disconnect(): Promise<void> {
    const state = this.state
    if (!state) return
    state.ready = false
    state.abort.abort(new Error('MCP connection disconnected'))
    try {
      await state.transport?.close()
    } catch (error) {
      throw this.safeFailure(error, 'disconnect')
    } finally {
      if (this.state === state) this.state = undefined
    }
  }

  private connectedClient(phase: McpPhase): Client {
    if (!this.state?.ready) throw mcpFailure(new Error('MCP connection is not connected'), { phase, config: this.config })
    return this.state.client
  }

  setToolsChangedHandler(handler: (() => void) | undefined): void {
    this.toolsChangedHandler = handler
  }

  private safeFailure(error: unknown, phase: McpPhase, signal?: AbortSignal, stderr = this.state?.stderr, elapsedMs?: number): unknown {
    if (signal?.aborted && error === signal.reason && !(error instanceof Error && error.name === 'TimeoutError')) return error
    return mcpFailure(error, {
      phase, config: this.config, stderr, secrets: this.diagnosticSecrets,
      transportError: this.state?.transportError, elapsedMs,
    })
  }

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    signal?.throwIfAborted()
    const client = this.connectedClient('list_tools')
    if (this.state) this.state.transportError = undefined
    const tools: McpToolInfo[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    const serverVersion = client.getServerVersion()
    do {
      signal?.throwIfAborted()
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, { signal })
        .catch((error: unknown) => { throw this.safeFailure(error, 'list_tools', signal) })
      tools.push(...result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        ...(tool.annotations?.readOnlyHint !== undefined ? { readOnlyHint: tool.annotations.readOnlyHint } : {}),
        ...(serverVersion ? { serverVersion: { name: serverVersion.name, version: serverVersion.version } } : {}),
      })))
      cursor = result.nextCursor
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw this.safeFailure(new Error('MCP tools/list returned a repeated pagination cursor'), 'list_tools', signal)
        cursors.add(cursor)
      }
    } while (cursor !== undefined)
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<import('../tools/tool.ts').ToolResult> {
    signal?.throwIfAborted()
    if (this.state) this.state.transportError = undefined
    const startedAt = performance.now()
    const raw = await this.connectedClient('call_tool').callTool({ name, arguments: args }, CallToolResultSchema, { signal })
      .catch((error: unknown) => { throw this.safeFailure(error, 'call_tool', signal, undefined, Math.round(performance.now() - startedAt)) })
    const parsed = CallToolResultSchema.safeParse(raw)
    if (!parsed.success) throw this.safeFailure(new Error('Malformed MCP tool result'), 'call_tool', signal)
    const result = parsed.data
    if (result.content.some(block => block.type === 'image')) {
      const content: import('../providers/provider.ts').ContentPart[] = result.content.map(block => {
        if (block.type === 'image') return {
          type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}`, detail: 'auto' },
        }
        return { type: 'text', text: block.type === 'text' ? readableMcpText(block.text) : JSON.stringify(publicContent(block)) }
      })
      if (result.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify({ structuredContent: result.structuredContent }) })
      if (result.isError) content.unshift({ type: 'text', text: 'Error: MCP tool reported failure.' })
      return { content, isError: result.isError ?? false }
    }
    if (!result.isError && result.structuredContent === undefined && result.content.every((block) => block.type === 'text')) {
      return result.content
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => readableMcpText(block.text))
        .join('\n')
    }
    const text = JSON.stringify({
      isError: result.isError ?? false,
      content: result.content.map(publicContent),
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    })
    return result.isError ? { isError: true, content: [{ type: 'text', text }] } : text
  }
}
