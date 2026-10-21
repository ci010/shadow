import { z } from 'zod'
import { isAbsolute } from 'node:path'
import { attachmentTarget, type BrowserTarget } from '../browser/session-browsers.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('discover') }).strict(),
  z.object({ action: z.literal('autoConnect'), channel: z.enum(['stable', 'beta', 'dev', 'canary']), userDataDir: z.string().trim().min(1).optional() }).strict(),
  z.object({ action: z.literal('attach'), endpoint: z.string().min(1) }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('close'), instance: z.string().min(1) }).strict(),
])

export const browserConnectionGuide = `Ask the user which running browser and human profile Shadow should share before connecting. Use the existing conversation ask/input flow; do not infer permission from a discovered path.
Recommended: Chrome 144+ supports user-authorized remote debugging at chrome://inspect/#remote-debugging. The user opens that page in their chosen Chrome, enables it themselves, and approves Chrome's connection prompt. Then explicitly bind autoConnect with their chosen channel (stable/beta/dev/canary). For a nonstandard user data root, the user can identify it from chrome://version (Profile Path parent); userDataDir plus autoConnect reads DevToolsActivePort, it does not start a browser. A profile path alone does not enable attachment.
Alternatively, the user supplies an already-enabled loopback CDP HTTP origin or browser WebSocket endpoint for Chrome/Edge/Brave/Electron. Shadow does not scan ports, inspect profile contents, copy profiles, enable debugging, launch, stop or restart browsers. Chrome 136+ ignores command-line remote-debugging-port/pipe on its default data directory; do not bypass that restriction or launch a second process sharing a user-data-dir.
CDP attaches to the browser, NOT a single human profile. Other profiles/tabs exposed by that browser may be accessible. Confirm this browser-wide access boundary with the user; use list_pages to identify intended pages and pass pageId each time. If the wrong pages appear, disconnect and ask the user to correct the browser choice, never silently pick another target.
Binding is session-only, visible via list, and forgotten on sleep/reset/close; reconnect explicitly afterwards using the previously approved choice if still applicable. Do not repeat browser/OS setup unless needed; reconfirm when the target or access scope changes. close disconnects Shadow, not the user's browser. Discovery is guidance only: no local browser/profile inspection has occurred.`

export class BrowserSetupTool implements Tool {
  readonly name = 'browser_setup'
  readonly readonly = (args: Record<string, unknown>) => args.action === 'list' || args.action === 'discover'
  readonly description = 'Guide user choice of a human-owned browser/profile and bind an already running browser. Start with discover, ask the user, then autoConnect (Chrome 144+ user-approved debugging) or attach (explicit loopback CDP). Browser-wide access, not profile isolation. Never launches/copies profiles; close and sleep only disconnect. Binding lasts until session reset.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['discover', 'autoConnect', 'attach', 'list', 'close'] },
      channel: { type: 'string', enum: ['stable', 'beta', 'dev', 'canary'], description: 'autoConnect only; explicitly chosen Chrome installation channel.' },
      userDataDir: { type: 'string', description: 'autoConnect only; optional user-identified absolute data ROOT, not Profile 1/Default. Requires running Chrome with user-enabled debugging. Does not isolate CDP to a profile.' },
      endpoint: { type: 'string', description: 'attach only; user-selected, already-enabled loopback CDP HTTP origin or browser WebSocket URL.' },
      instance: { type: 'string', description: 'close only; binding ID returned by this session. Disconnects, never closes the browser.' },
    },
    required: ['action'], additionalProperties: false,
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
    if (request.action === 'discover') return browserConnectionGuide
    if (context.tools.executionMode === 'call' || context.tools.dynamicOwner !== context.tools) {
      if (request.action !== 'list') return context.tools.rejectExecution('Leaf calls may borrow browser bindings; only their owner may connect or disconnect.')
    }
    if (request.action === 'autoConnect') {
      if (request.userDataDir && !isAbsolute(request.userDataDir)) return 'Error: userDataDir must be an absolute user-identified data root.'
      return this.setup({ action: 'open', target: { mode: 'autoConnect', channel: request.channel, userDataDir: request.userDataDir,
        arguments: ['--auto-connect', `--channel=${request.channel}`, ...(request.userDataDir ? [`--user-data-dir=${request.userDataDir}`] : [])],
      } }, context)
    }
    if (request.action === 'attach') {
      try { return await this.setup({ action: 'open', target: attachmentTarget(request.endpoint) }, context) }
      catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}` }
    }
    return this.setup(request, context)
  }
}
