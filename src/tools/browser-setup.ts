import { z } from 'zod'
import { isAbsolute } from 'node:path'
import { attachmentTarget, type BrowserTarget } from '../browser/session-browsers.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('discover') }).strict(),
  z.object({ action: z.literal('managed'), executablePath: z.string().trim().min(1), userDataDir: z.string().trim().min(1), profileDirectory: z.string().regex(/^(Default|Profile [0-9]+)$/) }).strict(),
  z.object({ action: z.literal('autoConnect'), channel: z.enum(['stable', 'beta', 'dev', 'canary']), userDataDir: z.string().trim().min(1).optional() }).strict(),
  z.object({ action: z.literal('attach'), endpoint: z.string().min(1) }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('close'), instance: z.string().min(1) }).strict(),
])

export const browserConnectionGuide = `Default: use an application-managed Chrome with a COPY of the user's explicitly selected profile, never launch against their original directory. Ask the user to identify the Chrome executable, absolute user data ROOT and profile directory (Default or Profile N, from chrome://version). Confirm copying this profile and browser-wide access by all permitted sessions in this Project before action managed. Managed launch accepts only recognized Chrome installation paths, not custom executables; other browsers require explicitly approved attach. Discovery does not inspect local profiles or launch anything. Do not read or print credential files.
The first managed binding copies only that profile plus opaque Local State into a private unique Project directory, disables sync/extensions, and launches Chrome with loopback-only CDP. Close the source browser yourself before copying if it is locked; Shadow does not terminate it or bypass locks. Encrypted cookies/passwords and active database snapshots may not transfer; re-login in the managed browser may be required. Copies are sensitive and retained, never written back or silently refreshed.
All sessions in this Project runtime share ONE managed browser process and its pages, but must bind explicitly and retain independent tool permissions/registries. Other Projects do not share it. Use list_pages and explicit pageId; coordinate concurrent edits to the same page. A different source cannot replace a running Project choice. close/sleep/reset disconnect only that session; the Project manager owns process shutdown. After a crash reconnect using the SAME choice; the existing copy is reused without overwriting. A new Project runtime makes a new unique copy; old copies remain for user-controlled cleanup.
Compatibility only when explicitly requested: autoConnect uses Chrome 144+ user-enabled debugging (chrome://inspect/#remote-debugging and Chrome's approval prompt), chosen channel and optional root; attach uses a supplied already-enabled loopback CDP endpoint for Chrome/Edge/Brave/Electron. These access a human-owned browser directly, NOT the default isolation policy. Explain browser-wide access and obtain explicit approval; never silently fall back to them. Chrome 136+ rejects debugging flags against its default root. Do not bypass this protection.`
export class BrowserSetupTool implements Tool {
  readonly name = 'browser_setup'
  readonly readonly = (args: Record<string, unknown>) => args.action === 'list' || args.action === 'discover'
  readonly description = 'Discover then explicitly bind the Project shared managed Chrome using a copy of a user-selected profile. Never launch the original profile. Independent session permissions; pageId routing. Compatibility autoConnect/attach require explicit user approval. close/sleep only disconnect; Project lifecycle owns shutdown.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['discover', 'managed', 'autoConnect', 'attach', 'list', 'close'] },
      executablePath: { type: 'string', description: 'managed only; explicitly selected absolute executable in a recognized Chrome installation. Custom programs are rejected.' },
      profileDirectory: { type: 'string', description: 'managed only; explicitly selected Default or Profile N directory in userDataDir.' },
      channel: { type: 'string', enum: ['stable', 'beta', 'dev', 'canary'], description: 'autoConnect only; explicitly chosen Chrome installation channel.' },
      userDataDir: { type: 'string', description: 'managed: required explicitly selected source data ROOT (not Default/Profile N). autoConnect: optional root for an already-running user-authorized browser.' },
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
    if (request.action === 'managed') {
      if (!isAbsolute(request.userDataDir) || !isAbsolute(request.executablePath)) return 'Error: managed requires absolute source root and executable paths.'
      return this.setup({ action: 'open', target: { mode: 'managed', executablePath: request.executablePath,
        userDataDir: request.userDataDir, profileDirectory: request.profileDirectory, arguments: [],
      } }, context)
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
