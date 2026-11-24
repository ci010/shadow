import { z } from 'zod'
import { CHILD_MCP_OPERATION, MAX_CHILD_MCP_RESULT_BYTES, type ChildMcpArgs } from './child-contract.ts'
import type { SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { completedToolFailure, ToolOutcomeUnknownError, type Tool, type ToolParameters, type ToolResult } from '../tools/tool.ts'

const contract = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), description: z.string(), inputSchema: z.record(z.unknown()) })
const discovery = z.object({ binding: z.string().uuid(), tools: z.array(contract).max(128) })
const result = z.object({ result: z.union([z.string(), z.object({ isError: z.boolean().optional(), content: z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().regex(/^data:image\//), detail: z.literal('auto') }) }),
])) })]) })

type Address = Pick<ExecutionContext, 'remoteWorkdir' | 'sessionId' | 'physicalSessionId'>
async function request(context: Address, args: ChildMcpArgs, signal: AbortSignal): Promise<unknown> {
  const target = context.remoteWorkdir
  if (!target) throw new Error('Child MCP requires a selected Child workdir')
  const abort = new AbortController()
  signal = AbortSignal.any([signal, abort.signal])
  const id = crypto.randomUUID()
  const now = Date.now()
  let completed = false
  let bytes = 0
  let output = ''
  try {
    for await (const event of target.executor.execute({ version: 2, jobId: id, idempotencyKey: id,
      sessionId: context.sessionId, turnId: context.physicalSessionId, nodeId: target.nodeId, workdirId: target.workdirId,
      operation: CHILD_MCP_OPERATION, args, createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 30_000).toISOString(),
    }, signal)) {
      if (event.type === 'stdout') {
        bytes += Buffer.byteLength(event.chunk, 'utf8')
        if (bytes > MAX_CHILD_MCP_RESULT_BYTES) throw new Error('Invalid Child MCP result size')
        output += event.chunk
      }
      if ('receipt' in event) completed = event.receipt.state === 'completed'
    }
  } finally { abort.abort() }
  if (!completed) throw new Error('Child MCP request did not complete; check the selected device and source grant. No Main fallback.')
  return JSON.parse(output)
}

export class ChildMcpTool implements Tool<ToolResult> {
  readonly supportsRemoteWorkdir = true
  readonly name: string
  readonly description: string
  readonly parameters: ToolParameters
  constructor(source: string, private readonly owner: Address, readonly binding: string, private readonly info: z.infer<typeof contract>, private readonly authorize?: (context: ExecutionContext) => void) {
    this.name = `${source}__${info.name}`
    this.description = `[Child MCP:${source}] ${info.description}`
    this.parameters = info.inputSchema as unknown as ToolParameters
  }
  matchesTarget(context: ExecutionContext): boolean {
    return !!context.remoteWorkdir && context.sessionId === this.owner.sessionId && context.remoteWorkdir.nodeId === this.owner.remoteWorkdir?.nodeId &&
      context.remoteWorkdir.workdirId === this.owner.remoteWorkdir.workdirId
  }
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult> {
    this.authorize?.(context)
    if (!this.matchesTarget(context)) return 'Error: Child MCP binding belongs to another workspace or session.'
    const desktop = this.name.startsWith('agent-desktop__')
    try {
      const output = result.parse(await request(context, { action: 'call', binding: this.binding, tool: this.info.name, args }, AbortSignal.any([context.signal, context.tools.dynamicSignal]))).result
      return desktop && typeof output === 'object' && output.isError ? completedToolFailure(output) : output
    } catch (error) {
      if (desktop) throw new ToolOutcomeUnknownError('Child desktop result unconfirmed. Do not replay. Inspect and reconcile on the selected device before proceeding.')
      throw error
    }
  }
}

export async function initializeChildMcp(source: string, context: ExecutionContext, authorize?: (context: ExecutionContext) => void): Promise<ChildMcpTool[]> {
  return (await initializeBinding(source, context, authorize)).adapters
}

async function initializeBinding(source: string, context: ExecutionContext, authorize?: (context: ExecutionContext) => void) {
  authorize?.(context)
  if (context.tools.dynamicOwner !== context.tools || context.tools.executionMode === 'call') throw new Error('Child MCP requires the owning session')
  const lifetime = context.tools.dynamicSignal
  const signal = AbortSignal.any([lifetime, context.signal])
  const address = { remoteWorkdir: context.remoteWorkdir, sessionId: context.sessionId, physicalSessionId: context.physicalSessionId }
  const raw = await request(address, { action: 'initialize', source }, signal)
  const { binding } = z.object({ binding: z.string().uuid() }).parse(raw)
  let released = false
  const release = async () => {
    if (released) return
    await request(address, { action: 'release', binding }, AbortSignal.timeout(5_000))
    released = true
  }
  try {
    signal.throwIfAborted()
    const { tools } = discovery.parse(raw)
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Duplicate Child MCP tool name')
    const adapters = tools.filter(tool => context.tools.canUseDynamic(`${source}__${tool.name}`)).map(tool => new ChildMcpTool(source, address, binding, tool, authorize))
    if (adapters.some(tool => context.tools.hasDynamic(tool.name))) throw new Error('Child MCP tool already registered; sleep the session before reconnecting')
    context.tools.onReset(release)
    for (const tool of adapters) context.tools.registerDynamic(tool)
    const probe = z.object({ pages: z.unknown(), receipt: z.unknown() }).parse(raw)
    return { adapters, binding, release, ...probe }
  } catch (error) {
    await release().catch(() => {})
    throw error
  }
}

const childBrowsers = new WeakMap<SessionTools, Awaited<ReturnType<typeof initializeBinding>>>()
const browserSetupBusy = new WeakSet<SessionTools>()

/** Child Chrome only uses the locally provisioned managed profile. Model input never
 * supplies a path, launch flags or a CDP endpoint to another device. */
export async function setupChildBrowser(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
  const { tools } = context
  if (tools.dynamicOwner !== tools || tools.executionMode === 'call' || !tools.canUseDynamic('browser_setup') || !tools.canUseDynamic('chrome-devtools__list_pages')) return 'Error: Child browser requires the owning session and browser permissions.'
  const schema = z.object({ action: z.enum(['connect', 'list', 'discover', 'close']), instance: z.string().uuid().optional() }).strict()
  const parsed = schema.safeParse(args)
  if (!parsed.success) return 'Error: Child browser supports connect, list, discover and close using a Child-operator-approved managed profile only.'
  if (browserSetupBusy.has(tools)) return 'Error: Child browser setup is busy.'
  browserSetupBusy.add(tools)
  try {
    const current = childBrowsers.get(tools)
    const { action, instance } = parsed.data
    const instances = current?.adapters.some(adapter => adapter.matchesTarget(context)) ? [current.binding] : []
    if (action === 'list') return JSON.stringify({ instances })
    if (action === 'discover') {
      const profile = await request(context, { action: 'inspect-browser' }, AbortSignal.any([context.signal, tools.dynamicSignal]))
      return JSON.stringify({ instances, profile, next: 'Use connect to bind and verify pages on the selected Child.' })
    }
    if (current && !instances.length) return 'Error: Child browser is bound to another workspace. Reset the session tools before connecting here.'
    if ((instance && instance !== current?.binding) || (action === 'close' && !instance)) return 'Error: supply a current Child browser instance.'
    if (current) {
      if (action !== 'close') {
        const pages = await tools.executeDynamic('chrome-devtools__list_pages', {}, context)
        if (typeof pages === 'object' ? !pages.isError : !/^(Error|Blocked):/.test(pages)) {
          return JSON.stringify({ instance: current.binding, ready: true, pages, copyReport: current.receipt })
        }
      }
      // Only a read-only probe is retried, through a fresh adapter. Never replay a page action.
      await current.release()
      childBrowsers.delete(tools)
      for (const adapter of current.adapters) tools.unregister(adapter.name)
      if (action === 'close') return JSON.stringify({ instance, closed: true })
    }
    const opened = await initializeBinding('chrome-devtools', context)
    childBrowsers.set(tools, opened)
    tools.onReset(() => { childBrowsers.delete(tools) })
    return JSON.stringify({ instance: opened.binding, ready: true, pages: opened.pages, copyReport: opened.receipt, tools: opened.adapters.map(tool => ({ name: tool.name, parameters: tool.parameters })) })
  } catch {
    return 'Error: Child browser unavailable; check the device, local managed profile grant and binding. No Main fallback.'
  } finally { browserSetupBusy.delete(tools) }
}
