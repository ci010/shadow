import type { ExecutionContext } from '../../tools/context.ts'
import type { VirtualFsHandler, VirtualFsListHandler, VirtualDirectoryHandler, VirtualEntry } from '../../vfs/virtual-fs.ts'
import type { SignalProviderRuntime } from './runtime.ts'

/** Progressive disclosure, not an authorization boundary. All files are generated snapshots. */
export function createProviderSignalsHandler(runtime: SignalProviderRuntime, projectId: string,
  internal: { read: VirtualFsHandler; list: VirtualFsListHandler }) {
  const categories = ['providers', 'authoring', 'instances', 'subscriptions']
  const reserved = (path: string) => categories.includes(path.split('/')[0]) || path === 'status.json'
  const check = (ctx: ExecutionContext) => {
    ctx.signal.throwIfAborted()
    if (ctx.projectId !== projectId) throw new Error('Wrong Project')
  }
  const entries = (ctx: ExecutionContext, optional = false): VirtualEntry[] => {
    check(ctx)
    if (optional && !runtime.canRead(ctx.sessionId)) return []
    const state = runtime.snapshot(ctx.sessionId)
    const result: VirtualEntry[] = []
    const json = (name: string, value: unknown) => result.push({ name, content: JSON.stringify(value, null, 2) })
    for (const id of new Set(state.providers.map(p => p.id))) {
      const revisions = state.providers.filter(p => p.id === id).sort((a, b) => a.version - b.version)
      const instances = state.instances.filter(i => i.provider === id)
      // Only applicable contracts: latest for future instances, plus every actively pinned revision.
      const applicable = revisions.filter(p => p === revisions.at(-1) || instances.some(i => i.version === p.version))
      const sections = applicable.map(p => {
        const info = p.consumer ?? { summary: 'Consumer capabilities not documented; inspect schemas and confirm suitability before subscribing.', capabilities: [], limitations: ['Provider-specific limitations not documented.'], semantics: [] }
        const available = instances.filter(i => i.version === p.version).map(i => ({ id: i.id, purpose: i.purpose ?? `Shared ${id} instance`, availability: !i.enabled ? 'paused — ask to resume before relying on delivery' : state.errors[i.id] ? 'attention needed — check instance status before relying on delivery' : 'enabled — baseline/live delivery not verified by this view' }))
        const example = p.examples[0]
        const subscribe = available.length && example ? { name: 'signal_provider', args: { action: 'subscribe', input_json: JSON.stringify({ id: 'my-watch', instance: available[0].id, demand: example.demand, processor: 'export function run({signal}) { return [{content: JSON.stringify(signal.data)}] }' }) } } : null
        return `## Contract version ${p.version}\n${info.summary}\nCapabilities: ${info.capabilities.join(' ') || 'Not documented.'}\nUnsupported / limitations: ${info.limitations.join(' ') || 'Not documented.'}\n${info.semantics.join('\n')}\n\nDemand schema:\n${JSON.stringify(p.demandSchema, null, 2)}\nSignal data schema (signal envelope is {id: string, data: <this schema>}):\n${JSON.stringify(p.signalSchema, null, 2)}\nExamples:\n${JSON.stringify(p.examples, null, 2)}\nAvailable instances for this contract:\n${JSON.stringify(available, null, 2)}\nSubscribe via invoke_tool (direct user input required):\n${subscribe ? JSON.stringify(subscribe, null, 2) : 'No executable example available: an enabled instance and an authored demand example are required. Ask for instance setup or a demand example; do not guess.'}`
      })
      result.push({ name: `providers/${id}`, content: `# ${id}\n${sections.join('\n\n')}\n\n## Delivery semantics\nThe first successful collection for an instance + normalized demand establishes a silent baseline (not historical delivery). Later unseen occurrence IDs are delivered to subscribers of that demand. Snapshot sources compare against the preceding successful snapshot; delta sources remember the last 4096 IDs, so evicted IDs may repeat. Reappearing snapshot IDs may repeat too. Delivery retries are at-least-once, not exactly-once; make follow-up actions idempotent. Shared demands may already have a baseline when you subscribe. Processors receive {signal} and return 0..16 {content} drafts, with no IO.\n\nAuthoring/setup (only if needed): v:signals/authoring/providers/${id}/\n` })
      for (const { code, ...manifest } of revisions) {
        const path = `authoring/providers/${id}/revisions/${manifest.version}`
        json(`${path}/manifest.json`, manifest)
        result.push({ name: `${path}/source.ts`, content: code })
      }
    }
    for (const instance of state.instances) {
      const { enabled, nextAt, ...config } = instance
      json(`instances/${instance.id}/config.json`, config)
      json(`instances/${instance.id}/status.json`, { enabled, nextAt, error: state.errors[instance.id] ?? null,
        pending: state.pending.filter(j => state.subscriptions.some(s => s.id === j.subscription && s.instance === instance.id)).length })
    }
    for (const { processor, ...config } of state.subscriptions) {
      const path = `subscriptions/${config.id}`
      json(`${path}/config.json`, config)
      result.push({ name: `${path}/processor.ts`, content: processor })
      const pending = state.pending.filter(j => j.subscription === config.id)
      json(`${path}/status.json`, { pending: pending.length, action: pending.length ? 'Delivery or processing is pending; verify processor output and instance status if it persists. Do not treat this as completed delivery.' : 'No queued delivery; this does not verify a baseline or live change.' })
      json(`authoring/subscriptions/${config.id}/diagnostics.json`, { pending })
    }
    json('status.json', { errors: state.errors, pending: state.pending.length })
    return result
  }
  const catalog = (ctx: ExecutionContext) => {
    const all = entries(ctx, true)
    const providers = all.filter(e => e.name.startsWith('providers/'))
    return `可订阅的信号来源\n${providers.map(e => {
      // Metadata only; no implementation description or manifest expansion.
      const id = e.name.slice('providers/'.length)
      const p = runtime.snapshot(ctx.sessionId).providers.filter(p => p.id === id).sort((a,b) => b.version-a.version)[0]
      return `- ${id}: ${p.consumer?.summary ?? 'Consumer capabilities not documented.'} Unsupported: ${p.consumer?.unsupported || 'See contract for limitations (not summarized).'} → v:signals/${e.name}`
    }).join('\n') || 'No provider views available for this session.'}\n\nInternal runtime events (not external signals), sources/subscriptions: v:signals/internal/\nAuthoring/setup: v:signals/authoring/; management: v:signals/instances/, v:signals/subscriptions/.`
  }
  const children = (all: VirtualEntry[], path: string) => [...new Set(all.filter(e => !path || e.name.startsWith(`${path}/`)).map(e => {
    const rest = path ? e.name.slice(path.length + 1) : e.name
    return rest.includes('/') ? rest.split('/')[0] + '/' : rest
  }))].sort()
  const isInternal = (path: string) => path === 'internal' || path.startsWith('internal/')
  const internalPath = (path: string) => path === 'internal' ? '' : path.slice(9)
  const directory: VirtualDirectoryHandler = async (path, ctx) => {
    check(ctx)
    if (!path) return { header: catalog(ctx), items: [] }
    if (!reserved(path)) return null
    const all = entries(ctx)
    if (all.some(e => e.name === path)) return null
    const items = children(all, path)
    if (!items.length && !categories.includes(path)) throw new Error('Unknown signal view path')
    return { header: `v:signals/${path}/`, items }
  }
  const read: VirtualFsHandler = async (path, ctx) => {
    check(ctx)
    if (!path) return catalog(ctx)
    if (isInternal(path)) return internal.read(internalPath(path), ctx)
    if (!reserved(path)) throw new Error('Unknown signal view path')
    const file = entries(ctx).find(e => e.name === path)
    if (file) return file.content
    const view = await directory(path, ctx)
    return `${view!.header}\n${view!.items.join('\n')}`
  }
  const list: VirtualFsListHandler = async (ctx, options) => {
    check(ctx)
    const path = options?.subpath ?? ''
    if (isInternal(path)) {
      const prefix = 'internal/'
      return (await internal.list(ctx, { ...options, subpath: internalPath(path) })).map(e => ({ ...e, name: prefix + e.name }))
    }
    // Root recursive search is consumption-only. Explicit authoring/management scopes opt in.
    const selected = entries(ctx, !path).filter(e => path ? e.name === path || e.name.startsWith(`${path}/`) : e.name.startsWith('providers/'))
    if (path && !selected.length && !categories.includes(path)) throw new Error('Unknown signal view path')
    return selected.map(e => options?.content === false ? { ...e, content: '' } : e)
  }
  return { read, list, directory }
}
