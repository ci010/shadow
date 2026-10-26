import { z } from 'zod'
import { discoverManagedBrowsers, selectManagedBrowser, managedBrowserNames } from '../browser/managed-browsers.ts'
import type { ManagedChromeChoice } from '../browser/shared-chrome.ts'
import { isAbsolute } from 'node:path'
import { attachmentTarget, type BrowserTarget } from '../browser/session-browsers.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect'), instance: z.string().min(1).optional() }).strict(),
  z.object({ action: z.literal('discover') }).strict(),
  z.object({ action: z.literal('managed'), browser: z.enum(managedBrowserNames).optional(), installation: z.string().min(1).optional(), profile: z.string().trim().min(1).optional(), executablePath: z.string().trim().min(1).optional(), userDataDir: z.string().trim().min(1).optional(), profileDirectory: z.string().regex(/^(Default|Profile [0-9]+)$/).optional() }).strict(),
  z.object({ action: z.literal('autoConnect'), channel: z.enum(['stable', 'beta', 'dev', 'canary']), userDataDir: z.string().trim().min(1).optional() }).strict(),
  z.object({ action: z.literal('attach'), endpoint: z.string().min(1) }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('close'), instance: z.string().min(1) }).strict(),
])

export const browserConnectionGuide = `Everyday entry: connect (optional instance). It reuses a session binding or the approved Project managed choice, restoring the same copy after a crash, and returns actual list_pages results. Multiple bindings require instance. With no approved choice it returns needs-selection candidates and confirmation guidance without copying or launching; even a unique candidate needs approval for profile copying and browser-wide Project access before managed. Reusing a binding does not grant additional tool permissions. Default: use an application-managed Chromium-family browser with a COPY of the user's explicitly selected profile, never launch against their original directory. Run discover to inspect installed browsers, matching standard source roots and minimal profile directory/display names. The agent/tool discovers paths; never ask the user for executable or root paths. Use installation ID or browser and optional profile name. A unique candidate is automatic; ask only to disambiguate multiple browser/profile choices, honoring an explicit user profile name. Reuse the existing Project choice before discovering/selecting again. Confirm copying and browser-wide Project access before managed. Recognized Chrome, Edge, Brave and Chromium installations are supported; source must match brand AND channel. Custom layouts require explicitly approved attach. Discovery reads only bounded Local State profile labels, never credentials/history/cookies, and does not launch or copy.
Copies only key data from the selected profile: Cookies, Login Data, Web Data, Preferences, Secure Preferences (and SQLite sidecars), Local Storage, Session Storage, IndexedDB, Network, plus root Local State. History, other profiles, caches and runtime locks are omitted. Source files are read-only; never remove locks, bypass OS locks, or require the user to close their browser. Each source read/copy failure (including Local State and changed files) skips only that item with a structured warning: stage, source-relative item, safe code and OS code, never file contents/native error text. Optional missing items appear in absent, not warning floods. browser_setup returns copyReport with ready/ready_with_warnings, copiedFiles, absent, warnings, loginData and message. Relay warnings to the user: missing data may require signing in again. Even if all key data fails, launch the usable copy and clearly state no login data migrated; never claim complete login inheritance. Invalid source roots/boundaries, destination infrastructure failures, cancellation, invalid executables and shared-choice conflicts remain blocking. Linked/unsupported individual entries are skipped with warnings, never followed. Metadata checks are not atomic snapshots; encrypted credentials may not transfer. The original initialization report survives cross-session reuse and crash restart; reuse does not refresh/copy again. Copies are sensitive and retained, never written back or silently refreshed.
All sessions in this Project runtime share ONE managed browser process and its pages, but must bind explicitly and retain independent tool permissions/registries. Other Projects do not share it. Use list_pages and explicit pageId; coordinate concurrent edits to the same page. A different source cannot replace a running Project choice. close/sleep/reset disconnect only that session; the Project manager owns process shutdown. After a crash reconnect using the SAME choice; the existing copy is reused without overwriting. A new Project runtime makes a new unique copy; old copies remain for user-controlled cleanup.
Compatibility only when explicitly requested: autoConnect uses Chrome 144+ user-enabled debugging (chrome://inspect/#remote-debugging and Chrome's approval prompt), chosen channel and optional root; attach uses a supplied already-enabled loopback CDP endpoint for Chrome/Edge/Brave/Electron. These access a human-owned browser directly, NOT the default isolation policy. Explain browser-wide access and obtain explicit approval; never silently fall back to them. Chrome 136+ rejects debugging flags against its default root. Do not bypass this protection.`
export class BrowserSetupTool implements Tool {
  readonly name = 'browser_setup'
  readonly readonly = (args: Record<string, unknown>) => args.action === 'list' || args.action === 'discover'
  readonly description = 'Use connect as the idempotent everyday entry: reuse an explicit session binding or approved Project choice and verify actual list_pages; no choice returns candidates without launch/copy. Discover then explicitly bind the Project shared managed Chromium-family browser using a copy of a user-selected profile. Best-effort key-data copy; copyReport exposes partial migration warnings and possible re-login, including on shared reuse. Never launch the original profile. Independent session permissions; pageId routing. Compatibility autoConnect/attach require explicit user approval. close/sleep only disconnect; Project lifecycle owns shutdown.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['connect', 'discover', 'managed', 'autoConnect', 'attach', 'list', 'close'] },
      installation: { type: 'string', description: 'managed: stable ID from discover, e.g. edge:stable; no paths needed.' },
      profile: { type: 'string', description: 'managed: discovered display name or directory; omit when unique or reusing shared choice.' },
      browser: { type: 'string', enum: [...managedBrowserNames], description: 'managed only; optional discovered browser family. Source root must match this installation and channel; never substitute another browser profile.' },
      executablePath: { type: 'string', description: 'Legacy managed override only; agent-discovered absolute executable in a recognized Chrome/Edge/Brave/Chromium installation with matching standard source root. Custom programs are rejected.' },
      profileDirectory: { type: 'string', description: 'managed only; explicitly selected Default or Profile N directory in userDataDir.' },
      channel: { type: 'string', enum: ['stable', 'beta', 'dev', 'canary'], description: 'autoConnect only; explicitly chosen Chrome installation channel.' },
      userDataDir: { type: 'string', description: 'Legacy managed override: agent-discovered source data ROOT (not Default/Profile N). autoConnect: optional root for an already-running user-authorized browser.' },
      endpoint: { type: 'string', description: 'attach only; user-selected, already-enabled loopback CDP HTTP origin or browser WebSocket URL.' },
      instance: { type: 'string', description: 'connect/close: binding ID returned by this session; required for connect when multiple bindings exist. close disconnects, never closes the browser.' },
    },
    required: ['action'], additionalProperties: false,
  }
  constructor(private setup: (
    request: { action: 'connect'; instance?: string } | { action: 'open'; target: BrowserTarget } | { action: 'list' } | { action: 'close'; instance: string },
    context: ExecutionContext,
  ) => Promise<string>, private readonly selectedChoice: () => ManagedChromeChoice | undefined = () => undefined,
    private readonly inventoryProvider = discoverManagedBrowsers) {}
  async discover() { return this.inventoryProvider() }
  workAdmission(args: Record<string, unknown>): 'cleanup' | undefined {
    const request = requestSchema.safeParse(args)
    return request.success && request.data.action === 'close' ? 'cleanup' : undefined
  }
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    const result = requestSchema.safeParse(args)
    if (!result.success) return `Error: invalid browser_setup arguments: ${result.error.message}`
    const request = result.data
    if (request.action === 'discover') {
      const bindings = await this.setup({ action: 'list' }, context)
      if (/^(Error|Blocked):/.test(bindings)) return bindings
      return JSON.stringify({ guide: browserConnectionGuide, bindings, sharedChoice: this.selectedChoice(), installations: await this.discover() })
    }
    if (context.tools.executionMode === 'call' || context.tools.dynamicOwner !== context.tools) {
      if (request.action !== 'list') return context.tools.rejectExecution('Leaf calls may borrow browser bindings; only their owner may connect or disconnect.')
    }
    if (request.action === 'connect' && !request.instance && !this.selectedChoice()) {
      const bindings = await this.setup({ action: 'list' }, context)
      if (/^(Error|Blocked):/.test(bindings)) return bindings
      if (JSON.parse(bindings).instances.length === 0) return JSON.stringify({
        status: 'needs-selection', ready: false, guide: browserConnectionGuide,
        installations: await this.discover(),
      })
    }
    if (request.action === 'managed') {
      if (request.profile && request.profileDirectory) return 'Error: choose profile name OR exact profileDirectory, not both.'
      if ((request.executablePath || request.userDataDir) && (request.installation || request.profile)) return 'Error: do not combine legacy path overrides with installation/profile selectors.'
      try {
        let choice: ManagedChromeChoice
        const shared = this.selectedChoice()
        if (request.executablePath || request.userDataDir) {
          if (!request.browser || !request.executablePath || !request.userDataDir || !request.profileDirectory || !isAbsolute(request.userDataDir) || !isAbsolute(request.executablePath)) return 'Error: legacy managed overrides require browser, absolute executable/root and profileDirectory.'
          choice = { browser: request.browser, executablePath: request.executablePath, userDataDir: request.userDataDir, profileDirectory: request.profileDirectory }
        } else if (shared) {
          if ((request.browser && request.browser !== shared.browser) || (request.profileDirectory && request.profileDirectory !== shared.profileDirectory)) return 'Error: Project already selected another shared profile/browser.'
          if (request.installation || request.profile) {
            // Validate only explicit constraints against the existing Project choice.
            // Unrelated installations/profiles must not trigger a fresh selection.
            const inventory = (await this.discover()).filter(item => item.browser === shared.browser && item.executable === shared.executablePath && item.userDataDir === shared.userDataDir)
            if (inventory.length !== 1 || (request.installation && inventory[0].id !== request.installation)) return 'Error: Project already selected another shared profile/browser, or its installation could not be verified.'
            if (request.profile) {
              const resolved = selectManagedBrowser(inventory, { profile: request.profile })
              if (resolved.profileDirectory !== shared.profileDirectory) return 'Error: Project already selected another shared profile/browser.'
            }
          }
          choice = shared
        } else choice = selectManagedBrowser(await this.discover(), request)
        return this.setup({ action: 'open', target: { mode: 'managed', ...choice, arguments: [] } }, context)
      } catch (error) { return 'Error: ' + (error instanceof Error ? error.message : String(error)) }
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
