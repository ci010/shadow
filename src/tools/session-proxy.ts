import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { configureSessionProxy, describeSessionProxy, resetSessionProxy } from '../execution/network/session-proxy.ts'

export class SessionProxyTool implements Tool {
  readonly name = 'session_proxy'
  readonly description = 'Get, set or reset the current session proxy override for subsequent built-in search web and read URL requests only. proxyId configured selects the existing environment/Windows static proxy. No browser, shell, MCP or remote network control. Overrides expire on session sleep.'
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'set', 'reset'] },
      mode: { type: 'string', enum: ['direct', 'proxy'] },
      proxyId: { type: 'string', description: 'For set mode proxy: configured. Resolved from existing environment/Windows static settings, never a URL.' },
    }, required: ['action'], additionalProperties: false,
  }
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (Object.keys(args).some(key => !['action', 'mode', 'proxyId'].includes(key))) return 'Error: unsupported session_proxy parameter.'
    if (!['get', 'set', 'reset'].includes(String(args.action))) return 'Error: action must be get, set or reset.'
    if (args.action !== 'set' && (args.mode !== undefined || args.proxyId !== undefined)) return 'Error: mode and proxyId are set-only parameters.'
    try {
      if (args.action === 'set') {
        if (args.mode !== 'direct' && args.mode !== 'proxy') return 'Error: set requires mode direct or proxy.'
        if (args.mode === 'direct' && args.proxyId !== undefined) return 'Error: direct mode does not accept proxyId.'
        if (args.proxyId !== undefined && typeof args.proxyId !== 'string') return 'Error: proxyId must be a string.'
        await configureSessionProxy(context, args.mode, args.proxyId as string | undefined)
      } else if (args.action === 'reset') resetSessionProxy(context)
      return JSON.stringify(describeSessionProxy(context))
    } catch (error) { context.signal.throwIfAborted(); return `Error: ${(error as Error).message}` }
  }
}
