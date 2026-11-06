import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { ProviderTransport } from '../events/providers/runtime.ts'
import type { ProviderBrowserAccess, ProviderBrowserBinding } from '../browser/provider-fetch.ts'
import type { EventProviderRuntime } from '../events/providers/runtime.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

export class EventProviderTool implements Tool {
  readonly name = 'event_provider'
  readonly description = 'Discover immutable EventSourceProvider revisions and manage owner-managed shared instances and self-destination subscriptions in this Project. Programmable REST/JSON and public HTML/text acquisition, with built-in fixed-read GraphQL GitHub aggregation; independent of legacy event_source. Instances pin authorized HTTP origin/routes/query/body constraints, native (default) or explicit owner-managed browser target transport, and optional native credential reference; reload cannot expand those permissions. Browser fetch runs with browser-side cookies only; no secretRef/header injection, no automatic browser selection or native fallback. browser_contexts lists HTTPS target identities in an explicitly connected managed instance; bind_browser re-admits only that exact persisted identity. Each subscription supplies restricted run({event}) returning 0..16 {content} drafts; no IO capabilities. Providers and subscribers may import {parseHtml} from @shadow/html for pure local static HTML/CSS extraction (1 MiB input, 1024-character selectors, 256 querySelectorAll results, 64 KiB getHtml fragments); textContent includes inert script/style text. No dynamic JS-site execution, arbitrary npm or host imports. Initial successful snapshot/delta baseline is silent; queued delivery retries independently. See docs/event-source-providers.md for schemas, limits and authoring. Code publication/reload require no extra human approval; instance/subscription permission changes and manual cycles require direct user input. Edit a local manifest/code file then reload; host drains and revokes the old generation before swapping compatible revisions. Do not promise live monitoring until authorized fixture/live verification.'
  readonly parameters: ToolParameters = { type: 'object', properties: {
    action: { type: 'string', enum: ['discover', 'inspect', 'publish', 'reload', 'browser_contexts', 'bind_browser', 'create', 'share', 'subscribe', 'unsubscribe', 'pause', 'resume', 'run'] },
    input_json: { type: 'string', description: 'publish: {id,version,description,http:{origin,routes:[{method,path,querySchema?,bodySchema?}],credential?:{header,prefix}},demandSchema,eventSchema,examples?,code}; create: {id,provider,version,secretRef?,binding?,transport?:{kind:"native"}|{kind:"browser",instance,targetId},allowedSubscribers?:[sessionId]}; browser_contexts: id=explicit connected managed browser instance, returns targetId/origin; bind_browser: {id,transport:{kind:"browser",instance,targetId}} re-admits only the same persisted identity after reset ; share: {id,allowedSubscribers:[sessionId]}; binding defaults to the declared http policy and is captured immutably; no secretRef for public sources; builtin GitHub uses secretRef and fixes api.github.com; subscribe: {id,instance,demand,processor}. github-issues v1 demand: {repository:"owner/name"}. No credential values.' },
    id: { type: 'string', description: 'Instance ID for pause/resume; browser instance UUID for browser_contexts; subscription ID for unsubscribe; provider ID for inspect.' },
    version: { type: 'number', description: 'Provider revision for inspect, which returns code, HTTP declaration, demand/event schemas and examples. No credentials.' },
    path: { type: 'string', description: 'reload: local JSON manifest relative to cwd, {id,description,http,demandSchema,eventSchema,examples?,stateVersion?,code_file}. code_file is a relative .ts module beside the manifest. Both files must resolve inside cwd. Reload automatically revisions and repins only your instances after draining the old generation.' },
  }, required: ['action'], additionalProperties: false }
  constructor(private runtime: EventProviderRuntime, private projectId: string, private browser?: {
    contexts(context: ExecutionContext, instance: string): Promise<unknown>
    bind(context: ExecutionContext, binding: ProviderBrowserBinding): ProviderBrowserAccess
  }) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    if (context.projectId !== this.projectId) throw new Error('Wrong Project')
    if (args.action === 'discover') return JSON.stringify(this.runtime.discover(context.sessionId))
    if (args.action === 'browser_contexts') {
      this.runtime.discover(context.sessionId)
      if (!this.browser || typeof args.id !== 'string') throw new Error('Managed browser instance id required')
      return JSON.stringify(await this.browser.contexts(context, args.id))
    }
    if (args.action === 'inspect') {
      if (typeof args.id !== 'string' || typeof args.version !== 'number') throw new Error('Provider id and version required')
      return JSON.stringify(this.runtime.inspect(context.sessionId, args.id, args.version))
    }
    if (args.action === 'reload') {
      if (context.remoteWorkdir || !context.cwd || typeof args.path !== 'string') throw new Error('Reload requires a local cwd and manifest path')
      // Host reads text only: never imports the authored module into the host process.
      this.runtime.discover(context.sessionId)
      const root = await realpath(context.cwd)
      const readLocal = async (path: string) => {
        const target = await realpath(path)
        const rel = relative(root, target)
        if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Provider files must remain inside local cwd')
        if ((await stat(target)).size > 256000) throw new Error('Provider file too large')
        return readFile(target, 'utf8')
      }
      const manifestPath = await realpath(resolve(root, args.path))
      const manifest = JSON.parse(await readLocal(manifestPath)) as Record<string, unknown>
      if (typeof manifest.code_file !== 'string' || isAbsolute(manifest.code_file)) throw new Error('Manifest requires relative code_file')
      const { code_file, ...metadata } = manifest
      const code = await readLocal(resolve(dirname(manifestPath), code_file))
      context.signal.throwIfAborted()
      await this.runtime.reload(context.sessionId, { ...metadata, code })
      return 'Provider reloaded: old generation drained; compatible checkpoints and authorized bindings retained; your instances repinned to the new revision.'
    }
    if (args.action === 'publish') {
      this.runtime.publish(context.sessionId, JSON.parse(String(args.input_json)))
      return 'Published provider revision. Code publication grants no credential or instance permissions.'
    }
    if (context.inputSource !== 'user') throw new Error('Instance/subscription permission changes and manual cycles require direct user input')
    switch (args.action) {
      case 'create': {
        const input = JSON.parse(String(args.input_json))
        const transport = ProviderTransport.parse(input.transport)
        const access = transport.kind === 'browser' ? this.browser?.bind(context, transport) : undefined
        this.runtime.create(context.sessionId, input, access)
        break
      }
      case 'bind_browser': {
        const input = JSON.parse(String(args.input_json))
        if (typeof input.id !== 'string' || Object.keys(input).some(key => !['id', 'transport'].includes(key))) throw new Error('Expected id and exact transport')
        const transport = ProviderTransport.parse(input.transport)
        if (transport.kind !== 'browser' || !this.browser) throw new Error('Browser transport required')
        this.runtime.bindBrowser(context.sessionId, input.id, this.browser.bind(context, transport))
        break
      }
      case 'share': this.runtime.share(context.sessionId, JSON.parse(String(args.input_json))); break
      case 'unsubscribe': this.runtime.unsubscribe(context.sessionId, String(args.id)); break
      case 'subscribe': this.runtime.subscribe(context.sessionId, JSON.parse(String(args.input_json))); break
      case 'pause': case 'resume': this.runtime.pause(context.sessionId, String(args.id), args.action === 'resume'); break
      case 'run':
        // Verify caller is a local Project owner. Cycle scheduling remains host-wide and rate limited.
        this.runtime.discover(context.sessionId)
        await this.runtime.run(); break
      default: throw new Error('Unknown action')
    }
    return 'Saved/completed. Discover shows pending processing/delivery and sanitized collection status; inbox acceptance is not completed session processing.'
  }
}
