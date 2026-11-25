import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import type { McpServerConfig } from '../config/schema.ts'
import type { ExecutionRequestV2 } from '../execution/contracts.ts'
import type { LocalJobOperationHandler } from '../execution/local-executor.ts'
import { chromeToolAllowed, validateChromeCall } from '../browser/chrome-contract.ts'
import { McpConnection } from './client.ts'

import { CHILD_MCP_OPERATION, MAX_CHILD_MCP_RESULT_BYTES, childMcpArgsSchema, type ChildMcpArgs } from './child-contract.ts'
export { CHILD_MCP_OPERATION } from './child-contract.ts'

type Connection = Pick<McpConnection, 'connect' | 'listTools' | 'callTool' | 'disconnect'>
interface Binding {
  config: McpServerConfig
  owner: string
  source: string
  connection: Connection
  tools: Awaited<ReturnType<Connection['listTools']>>
  busy: boolean
  expiry: NodeJS.Timeout
}

/** Child-side MCP capability. The local resolver must authorize every action,
 * and only returns Child-owned configuration; no job may supply launch or network options. */
export class ChildMcpService implements LocalJobOperationHandler {
  readonly failureOutcome = 'unknown' as const
  readonly #bindings = new Map<string, Binding>()
  #epoch = new AbortController()
  #pending = 0

  constructor(
    private readonly authorize: (request: ExecutionRequestV2, source: string, action: ChildMcpArgs['action'], signal: AbortSignal) => Promise<{ config: McpServerConfig; cwd?: string; managed?: () => Promise<{ connection: Connection; config: McpServerConfig; receipt?: unknown }> }>,
    private readonly connectSource: (config: McpServerConfig, cwd?: string) => Connection = (config, cwd) => new McpConnection(config, cwd, cwd),
  ) {}

  handles(operation: string): boolean { return operation === CHILD_MCP_OPERATION }

  async execute(request: ExecutionRequestV2, signal: AbortSignal): Promise<string> {
    if (!this.handles(request.operation) || !request.projectScope || !request.workdirId) throw new Error('Child MCP requires a scoped workdir')
    const args = childMcpArgsSchema.parse(request.args)
    signal = AbortSignal.any([signal, this.#epoch.signal])
    signal.throwIfAborted()
    const owner = JSON.stringify([request.nodeId, request.projectScope, request.workdirId, request.sessionId])
    if (args.action === 'inspect-browser') {
      const grant = await this.authorize(request, 'chrome-devtools', args.action, signal)
      signal.throwIfAborted()
      if (!grant.managed) throw new Error('Child managed browser not granted')
      return encode({ approved: true, mode: 'managed' })
    }
    if (args.action === 'initialize') {
      if (this.#bindings.size + this.#pending >= 32) throw new Error('Child MCP binding limit reached')
      this.#pending++
      let connection: Connection | undefined
      try {
        const { config: declared, cwd, managed } = await this.authorize(request, args.source, args.action, signal)
        signal.throwIfAborted()
        if (declared.name !== args.source || (['agent-desktop', 'chrome-devtools'].includes(declared.name) && !managed)) throw new Error('Invalid ordinary MCP source')
        const prepared = await managed?.()
        const config = prepared?.config ?? declared
        connection = prepared?.connection ?? this.connectSource(config, cwd)
        await connection.connect(signal)
        const tools = (await connection.listTools(signal)).filter(tool => chromeToolAllowed(config, tool))
        if (config.name === 'chrome-devtools' && !tools.some(tool => tool.name === 'list_pages')) throw new Error('Child browser probe unavailable')
        const pages = config.name === 'chrome-devtools' ? await connection.callTool('list_pages', {}, signal) : undefined
        if (typeof pages === 'object' && pages.isError) throw new Error('Child browser probe failed')
        signal.throwIfAborted()
        const binding = crypto.randomUUID()
        const result = encode({ binding, tools, pages, receipt: prepared?.receipt })
        const expiry = setTimeout(() => {
          const expired = this.#bindings.get(binding)
          this.#bindings.delete(binding)
          void expired?.connection.disconnect().catch(() => console.error('[child] MCP lease cleanup failed'))
        }, 30 * 60_000).unref()
        this.#bindings.set(binding, { config, owner, source: args.source, connection, tools, busy: false, expiry })
        connection = undefined
        return result
      } finally {
        this.#pending--
        await connection?.disconnect()
      }
    }
    const binding = this.#bindings.get(args.binding)
    if (!binding || binding.owner !== owner) {
      if (args.action === 'release') return encode({ released: false })
      throw new Error('Child MCP binding unavailable')
    }
    if (args.action === 'release') {
      await this.authorize(request, binding.source, args.action, signal)
      signal.throwIfAborted()
      if (this.#bindings.get(args.binding) !== binding) throw new Error('Child MCP binding unavailable')
      this.#bindings.delete(args.binding)
      clearTimeout(binding.expiry)
      await binding.connection.disconnect()
      return encode({ released: true })
    }
    if (binding.busy) throw new Error('Child MCP binding busy')
    binding.busy = true
    try {
      await this.authorize(request, binding.source, args.action, signal)
      signal.throwIfAborted()
      if (this.#bindings.get(args.binding) !== binding) throw new Error('Child MCP binding unavailable')
      const tool = binding.tools.find(tool => tool.name === args.tool)
      if (!tool) throw new Error('Tool was not discovered on this binding')
      validateChromeCall(binding.config, tool, args.args)
      const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema)
      if (!validate(args.args).valid) throw new Error('Invalid Child MCP tool arguments')
      binding.expiry.refresh()
      const output = JSON.stringify({ result: await binding.connection.callTool(args.tool, args.args, signal) })
      if (Buffer.byteLength(output, 'utf8') > MAX_CHILD_MCP_RESULT_BYTES) {
        return encode({ result: { isError: true, content: [{ type: 'text', text: 'Child tool completed but its result exceeds the transfer limit. Do not replay a consequential action to recover the result.' }] } })
      }
      return output
    } finally { binding.busy = false }
  }

  /** Revoke current handles and abort pending work on pairing disconnect or shutdown. */
  async reset(): Promise<void> {
    this.#epoch.abort()
    this.#epoch = new AbortController()
    const bindings = [...this.#bindings.values()]
    this.#bindings.clear()
    await Promise.all(bindings.map(binding => { clearTimeout(binding.expiry); return binding.connection.disconnect() }))
  }
}

function encode(value: unknown): string {
  const result = JSON.stringify(value)
  if (Buffer.byteLength(result, 'utf8') > MAX_CHILD_MCP_RESULT_BYTES) throw new Error('Child MCP result exceeds size limit')
  return result
}
