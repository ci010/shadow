import { z } from 'zod'
import { attachmentTarget, type BrowserTarget } from '../browser/session-browsers.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('launch'),
    browser: z.enum(['default', 'chrome', 'edge', 'brave']).optional(),
    executablePath: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({ action: z.literal('attach'), endpoint: z.string().min(1) }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('close'), instance: z.string().min(1) }).strict(),
])

export class BrowserSetupTool implements Tool {
  readonly name = 'browser_setup'
  readonly readonly = (args: Record<string, unknown>) => args.action === 'list'
  readonly description = 'Configure session-local Chrome DevTools browser instances: launch Chrome, Edge, Brave or a custom executable with a fresh isolated profile; attach to an explicitly selected loopback CDP browser/Electron target; list or close instances. Does not change Project configuration. Returns an instance ID for search and invoke_tool. Closing attached instances only disconnects; owned browsers are terminated. Default browser use needs no setup.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['launch', 'attach', 'list', 'close'] },
      browser: { type: 'string', enum: ['default', 'chrome', 'edge', 'brave'], description: 'launch only. Omitted/default uses Project browser settings.' },
      executablePath: { type: 'string', description: 'launch only. Explicit browser executable; cannot be combined with a named browser. Never falls back.' },
      endpoint: { type: 'string', description: 'attach only. Explicit loopback CDP HTTP origin or WebSocket URL. Target must already enable remote debugging.' },
      instance: { type: 'string', description: 'close only. An ID returned by this session; never a port or path.' },
    },
    required: ['action'],
    additionalProperties: false,
  }

  constructor(private setup: (
    request: { action: 'open'; target: BrowserTarget } | { action: 'list' } | { action: 'close'; instance: string },
    context: ExecutionContext,
  ) => Promise<string>) {}

  workAdmission(args: Record<string, unknown>): 'cleanup' | undefined {
    const request = requestSchema.safeParse(args)
    return request.success && request.data.action === 'close' ? 'cleanup' : undefined
  }

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    const result = requestSchema.safeParse(args)
    if (!result.success) return `Error: invalid browser_setup arguments: ${result.error.message}`
    const request = result.data
    if (context.tools.executionMode === 'call' || context.tools.dynamicOwner !== context.tools) {
      if (request.action !== 'list') return context.tools.rejectExecution('Leaf calls may use borrowed browser instances, but only their owner may launch, attach or close them.')
    }
    if (request.action === 'launch') {
      if (request.executablePath && request.browser && request.browser !== 'default') {
        return 'Error: choose a named browser or executablePath, not both.'
      }
      return this.setup({ action: 'open', target: { mode: 'launch', options: {
        browser: request.browser, executablePath: request.executablePath,
      } } }, context)
    }
    if (request.action === 'attach') {
      let target: BrowserTarget
      try { target = attachmentTarget(request.endpoint) }
      catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}` }
      return this.setup({ action: 'open', target }, context)
    }
    return this.setup(request, context)
  }
}
