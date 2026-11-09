import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { ProviderTransport } from '../events/providers/runtime.ts'
import type { ProviderBrowserAccess, ProviderBrowserBinding } from '../browser/provider-fetch.ts'
import type { EventProviderRuntime } from '../events/providers/runtime.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

export class EventProviderTool implements Tool {
  readonly name = 'event_provider'
  readonly description = 'Consume Project event sources: read v:events/ for a concise catalog, then v:events/providers/<id> (one file) for capabilities, limitations, demand/event schemas, examples, applicable instance contracts and exact subscription calls. Subscribe delivers only to self; processors run({event}) return 0..16 {content} drafts without IO. Initial successful demand baseline is silent; delivery is at-least-once. Do not promise monitoring until baseline and actual change delivery are verified. Explicit authoring/setup: v:events/authoring/providers/<id>/revisions/<version>/{manifest.json,source.ts}; full bindings/status are separate v:events/instances and v:events/subscriptions management views. These paths are progressive disclosure, not permission boundaries. Existing instances are Project-shared for eligible local durable sessions. No discover/inspect/share actions. Publication/reload require no extra human approval; instance/subscription changes and manual cycles require direct user input. Reload local manifest/code files without expanding authorized instance bindings. See event-sources skill for authoring, broker, HTML parsing and browser authority constraints. Independent of internal EventService subscriptions managed with event_subscribe (v:events/internal/).'
  readonly parameters: ToolParameters = { type: 'object', properties: {
    action: { type: 'string', enum: ['publish', 'reload', 'browser_contexts', 'bind_browser', 'create', 'subscribe', 'unsubscribe', 'pause', 'resume', 'run'] },
    input_json: { type: 'string', description: 'publish: {id,version,description,consumer?:{summary,unsupported?,capabilities,limitations,semantics},http:{origin,routes:[{method,path,querySchema?,bodySchema?,effect?:"read"}],credential?:{header,prefix}},demandSchema,eventSchema,examples?,code}; create: {id,provider,version,purpose?,secretRef?,binding?,transport?:{kind:"native"}|{kind:"browser",instance,targetId}}; browser_contexts: id=explicit connected managed browser instance, returns targetId/origin; bind_browser: {id,transport:{kind:"browser",instance,targetId}} re-admits only the same persisted identity after reset ; binding defaults to the declared http policy and is captured immutably; no secretRef for public sources; builtin GitHub uses secretRef and fixes api.github.com; subscribe: {id,instance,demand,processor}. github-issues v1 demand: {repository:"owner/name"}. No credential values.' },
    id: { type: 'string', description: 'Instance ID for pause/resume; browser instance UUID for browser_contexts; subscription ID for unsubscribe; consumer contract is v:events/providers/<id>; implementation metadata requires explicit v:events/authoring.' },
    path: { type: 'string', description: 'reload: local JSON manifest relative to cwd, {id,description,consumer?,http,demandSchema,eventSchema,examples?,stateVersion?,code_file}. code_file is a relative .ts module beside the manifest. Both files must resolve inside cwd. Reload automatically revisions and repins all matching Project instances after draining the old generation.' },
  }, required: ['action'], additionalProperties: false }
  constructor(private runtime: EventProviderRuntime, private projectId: string, private browser?: {
    contexts(context: ExecutionContext, instance: string): Promise<unknown>
    bind(context: ExecutionContext, binding: ProviderBrowserBinding): ProviderBrowserAccess
  }) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    if (context.projectId !== this.projectId) throw new Error('Wrong Project')
    if (args.action === 'browser_contexts') {
      this.runtime.authorize(context.sessionId)
      if (!this.browser || typeof args.id !== 'string') throw new Error('Managed browser instance id required')
      return JSON.stringify(await this.browser.contexts(context, args.id))
    }
    if (args.action === 'reload') {
      if (context.remoteWorkdir || !context.cwd || typeof args.path !== 'string') throw new Error('Reload requires a local cwd and manifest path')
      // Host reads text only: never imports the authored module into the host process.
      this.runtime.authorize(context.sessionId)
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
      return 'Provider reloaded: old generation drained; compatible checkpoints and authorized bindings retained; Project instances repinned to the new revision.'
    }
    if (args.action === 'publish') {
      this.runtime.publish(context.sessionId, JSON.parse(String(args.input_json)))
      return 'Published provider revision. Code publication grants no credential or instance permissions.'
    }
    if (!['create', 'bind_browser', 'subscribe', 'unsubscribe', 'pause', 'resume', 'run'].includes(String(args.action))) throw new Error('Unknown action')
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
      case 'unsubscribe': this.runtime.unsubscribe(context.sessionId, String(args.id)); break
      case 'subscribe': this.runtime.subscribe(context.sessionId, JSON.parse(String(args.input_json))); break
      case 'pause': case 'resume': this.runtime.pause(context.sessionId, String(args.id), args.action === 'resume'); break
      case 'run':
        // Verify caller is an eligible local Project session. Cycle scheduling remains host-wide and rate limited.
        this.runtime.authorize(context.sessionId)
        await this.runtime.run(); break
      default: throw new Error('Unknown action')
    }
    return 'Saved/completed. Read v:events for pending processing/delivery and sanitized collection status; inbox acceptance is not completed session processing.'
  }
}
