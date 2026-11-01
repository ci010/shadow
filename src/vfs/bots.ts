import type { BotInstanceStore } from '../channels/bot-store.ts'
import type { ChannelManager } from '../channels/manager.ts'
import { assertBotManagementAccess } from '../bots/access.ts'
import type { DirectoryBots } from '../bots/runtime.ts'
import { subscribedBindings, bindingSubscription } from '../bots/sdk.ts'
import type { VirtualEntry, VirtualFsHandler, VirtualFsListHandler } from './virtual-fs.ts'

const PAGE = 50
const MAX_IDS = 1000
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const GUIDE = `Read-only current Project Bot management, restricted to authenticated owner durable Web chats (not Service, channel, child, script or remote-workdir access).
Paths: v:bots/connections/index; v:bots/connections/<id>; v:bots/deployments/index; v:bots/deployments/<id>/status; v:bots/deployments/<id>/listeners.
Indexes and object views contain at most 50 rows; follow next paths (/<page>, starting at 2). read offset/limit pages lines; search limit/offset pages matching entries. Broad search expands only the first page of the first 50 objects per kind; narrow to an ID or follow index pages. Discovery scans at most 1024 deployment entries / 1000 connections; warnings mean incomplete results.
Connections export only id/displayName/platform/purpose/enabled/health/ownerVerified. Health is transport state, not processing success. No credentials, config, owner sender IDs, private drafts, exception text or URLs are exported.
Deployments are immutable active copies, not unpublished source. loaded=lazy-validated means this object's current verified bytes pass DirectoryBots' strict parser, not a running process or successful delivery. Invalid packages remain quarantined; integrity/storage failures expose no unverified metadata. Listeners are the same botInputListeners projection used by InputRouter, not a new registry. Personal ingress uses host-owned Session listeners and is not exposed here.
Configured bindings, subscription selection, binding enablement, projected listeners, connection health and processing success are distinct. Routing is not probed: conflicting subscribers, corrupt sibling storage and live admission/policy checks can still block delivery. processingSuccess is unknown (not recorded by this view).
No reads/searches connect, import BOT modules, publish, repair, update quarantine bookkeeping or start Sessions. Operations remain bot_setup, bot_package and credential_request; legacy status actions remain compatible.`

function json(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, field: unknown) => typeof field === 'string'
    ? field.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, '[url-omitted]') : field, space)
}
function serialize(value: object): string {
  if (!('rows' in value) || !Array.isArray(value.rows)) return json(value, 2)
  const { rows, ...metadata } = value
  return `${json(metadata, 2).slice(0, -2)},\n  "rows": [\n${rows.map(row => `    ${json(row)}`).join(',\n')}\n  ]\n}`
}
function pagePath(base: string, page: number): string { return page === 1 ? base : `${base}/${page}` }
function pageNumber(raw?: string): number {
  const page = raw === undefined ? 1 : Number(raw)
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_IDS) throw new Error('Bot status page not found.')
  return page
}
function rowsPage<T>(base: string, rows: T[], page: number) {
  if (page > 1 && (page - 1) * PAGE >= rows.length) throw new Error('Bot status page not found.')
  return { total: rows.length, page, rows: rows.slice((page - 1) * PAGE, page * PAGE),
    next: page * PAGE < rows.length ? `v:bots/${pagePath(base, page + 1)}` : null }
}
function safeSource(source: { folderId: string; directory: string }) {
  // Storage accepts older source labels; status never exports absolute paths,
  // URLs or unchecked metadata fields (including future secret-bearing fields).
  if (!ID.test(source.folderId) || source.directory.length > 1024 ||
    source.directory && source.directory.split('/').some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) return null
  return { folderId: source.folderId, directory: source.directory }
}

type Options = {
  projectId: string
  store: Pick<BotInstanceStore, 'projectId' | 'ids'>
  channels: Pick<ChannelManager, 'projectId' | 'botStatus'>
  directory: DirectoryBots
  assertSession: (id: string) => void
}
export function createBotsHandler(options: Options): { read: VirtualFsHandler; list: VirtualFsListHandler } {
  if ([options.store.projectId, options.channels.projectId, options.directory.deployments.projectId].some(id => id !== options.projectId))
    throw new Error('Bot status Project ownership mismatch.')
  const authorize = (context: Parameters<VirtualFsHandler>[1]) => assertBotManagementAccess(options.projectId, context, options.assertSession)
  const inventory = (kind: 'connections' | 'deployments') => {
    if (kind === 'deployments') return options.directory.deployments.diagnosticIds()
    const result = options.store.ids(MAX_IDS)
    return { ids: result.ids.filter(id => ID.test(id)), warning: result.truncated ? 'connection-index-limit'
      : result.ids.some(id => !ID.test(id)) ? 'unsafe-connection-entry-omitted' : undefined }
  }
  const index = (kind: 'connections' | 'deployments', page: number) => {
    const { ids, warning } = inventory(kind)
    return { projectId: options.projectId, ...rowsPage(`${kind}/index`, ids.map(id => ({ id,
      path: `v:bots/${kind}/${id}${kind === 'deployments' ? '/status' : ''}` })), page), ...(warning ? { warning } : {}) }
  }
  const connection = (id: string) => {
    // Do not return or spread BotInstanceStatus: it includes config, secret
    // presence flags and free-form health messages. Keep this explicit allowlist.
    let value
    try { value = options.channels.botStatus(id) } catch { throw new Error('Bot connection not found or unavailable.') }
    if (value.projectId !== options.projectId) throw new Error('Bot connection not found or unavailable.')
    return { id: value.id, displayName: value.displayName, platform: value.platform, purpose: value.purpose,
      enabled: value.enabled, health: value.state, ownerVerified: value.ownerVerified === true }
  }
  const deployment = (id: string, view: 'status' | 'listeners', page: number, item = options.directory.inspect(id)) => {
    if (!item) throw new Error('Bot deployment not found.')
    const metadata = item.deployment && { revision: item.deployment.revision, previous: item.deployment.previous ?? null,
      source: safeSource(item.deployment.source), storageMode: item.deployment.mode }
    const common = { id, ...metadata, state: item.state, loaded: item.loaded ? 'lazy-validated' : item.state,
      error: item.error ?? null, format: item.format ?? null, processingSuccess: 'unknown', routing: 'not-probed' }
    if (view === 'listeners') return { ...common, projection: 'InputRouter botInputListeners',
      personalIngress: item.bot?.mode === 'personal' ? 'host-session-listeners-not-exported' : undefined,
      ...rowsPage(`deployments/${id}/listeners`, item.listeners ?? [], page) }
    const bot = item.bot
    const subscribed = new Set(bot ? subscribedBindings(bot) : [])
    const bindings = bot?.bindings.map(binding => ({ binding: bindingSubscription(binding), connectionPath: `v:bots/connections/${binding.botInstanceId}`, enabled: binding.enabled,
      subscribed: subscribed.has(binding) })) ?? []
    return { ...common, mode: bot?.mode, connection: bot?.connection,
      subscriptionMode: bot ? bot.mode === 'personal' ? 'host-owner-ingress' : bot.subscriptions === undefined ? 'legacy-bindings' : 'explicit' : null,
      counts: bot ? { bindings: bindings.length, subscribed: bindings.filter(row => row.subscribed).length,
        enabledBindings: bindings.filter(row => row.enabled).length, listeners: item.listeners?.length ?? 0 } : null,
      ...rowsPage(`deployments/${id}/status`, bindings, page), listenersPath: `v:bots/deployments/${id}/listeners` }
  }
  const render = (path: string, inspection?: ReturnType<DirectoryBots['inspect']>): string => {
    if (!path || path === 'overview') return GUIDE
    const matchIndex = /^(connections|deployments)(?:\/index(?:\/([1-9][0-9]*))?)?$/.exec(path)
    if (matchIndex) return serialize(index(matchIndex[1] as 'connections' | 'deployments', pageNumber(matchIndex[2])))
    const matchConnection = /^connections\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})$/.exec(path)
    if (matchConnection) return serialize(connection(matchConnection[1]!))
    const matchDeployment = /^deployments\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/(status|listeners)(?:\/([1-9][0-9]*))?$/.exec(path)
    if (matchDeployment) return serialize(deployment(matchDeployment[1]!, matchDeployment[2] as 'status' | 'listeners', pageNumber(matchDeployment[3]), inspection))
    throw new Error('Bot status path not found. Read v:bots/overview.')
  }
  return {
    read: (path, context) => { authorize(context); return render(path) },
    list: (context, listOptions) => {
      authorize(context)
      const scope = listOptions?.subpath ?? ''
      const content = listOptions?.content !== false
      const entries: VirtualEntry[] = []
      const add = (name: string, warning?: string, inspection?: ReturnType<DirectoryBots['inspect']>) => {
        if (!scope || name === scope || name.startsWith(`${scope}/`)) {
          context.signal.throwIfAborted()
          entries.push({ name, content: content ? render(name, inspection) : '', ...(warning ? { warning } : {}) })
        }
      }
      add('overview')
      for (const kind of ['connections', 'deployments'] as const) {
        if (scope && scope !== kind && !scope.startsWith(`${kind}/`)) continue
        // Explicit object search must not enumerate or parse its siblings.
        const object = new RegExp(`^${kind}/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})(?:/(.*))?$`).exec(scope)
        if (object && (object[1] !== 'index' || kind === 'deployments' && /^(status|listeners)(?:\/|$)/.test(object[2] ?? ''))) {
          if (kind === 'connections') { connection(object[1]!); add(`${kind}/${object[1]}`) }
          else {
            const item = options.directory.inspect(object[1]!)
            if (!item) throw new Error('Bot deployment not found.')
            for (const view of ['status', 'listeners'] as const) {
              const count = view === 'status' ? item.bot?.bindings.length : item.listeners?.length
              // Reuse only this call's verified object across its pages; never
              // persist a status cache or reread/hash source once per page.
              for (let page = 1; page <= Math.max(1, Math.ceil((count ?? 0) / PAGE)); page++) add(pagePath(`${kind}/${object[1]}/${view}`, page), undefined, item)
            }
          }
          continue
        }
        const { ids, warning } = inventory(kind)
        for (let page = 1; page <= Math.max(1, Math.ceil(ids.length / PAGE)); page++) add(pagePath(`${kind}/index`, page), warning)
        for (const id of ids.slice(0, PAGE)) {
          if (kind === 'connections') add(`${kind}/${id}`)
          else { add(`${kind}/${id}/status`); add(`${kind}/${id}/listeners`) }
        }
        if (warning || ids.length > PAGE || kind === 'deployments' && ids.length) entries.push({ name: `${kind}/index`, content: '',
          warning: warning ?? 'Broad search includes only the first page of the first 50 objects; follow index paths and search an explicit ID for all object pages.' })
      }
      return entries
    },
  }
}
