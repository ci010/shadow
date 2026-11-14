import { z } from 'zod'
import { assertBotManagementAccess } from '../bots/access.ts'
import { parseConnectionSinkProjection } from '../shared/connection-sink.ts'
import type { ConnectionSinkProjection } from '../channels/sink-contract.ts'
import type { VirtualEntry, VirtualFsHandler, VirtualFsListHandler } from './virtual-fs.ts'

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const serialize = (value: unknown) => JSON.stringify(value, (_key, field: unknown) => typeof field === 'string'
  ? field.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, '[url-omitted]') : field, 2)
const overviewSchema = z.object({ id: z.string().regex(ID), displayName: z.string().max(512),
  platform: z.enum(['qq', 'feishu', 'discord', 'wechat']), purpose: z.string().max(512),
  enabled: z.boolean(), health: z.string().max(64), ownerVerified: z.boolean() })
const GUIDE = `Read-only current Project transport Connections and their common durable receipt sinks.
Canonical paths: v:connections/index.json, v:connections/<id>/overview.json, v:connections/<id>/sink.json.
A Connection is transport, not a BOT role. The common receipt sink records received/discovered conversations without model reactions. Linking a BOT does not change receipt addresses.
BOT.md is the sole BOT subscription/message-admission authority. Follow v:bots/authoring to create or link a BOT; Workflow references that BOT, never copies its bindings.
Navigation is existing content only, not permission to create a session, send a message or execute a workflow. Connection health is not processing success.
Indexes contain at most 50 connections per page; follow next paths. Broad search expands at most the first 50 objects; scope to an ID for its detail. Discovery is capped at 1000 IDs; warnings mean incomplete results.`

export interface ConnectionsVfsOptions {
  projectId: string
  assertSession(id: string): void
  index(): { ids: string[]; warning?: string }
  overview(id: string): z.input<typeof overviewSchema>
  sink(id: string): ConnectionSinkProjection
}
/** Pure inspection adapter: callbacks must not connect, start sessions or mutate storage. */
export function createConnectionsHandler(options: ConnectionsVfsOptions): { read: VirtualFsHandler; list: VirtualFsListHandler } {
  const authorize = (context: Parameters<VirtualFsHandler>[1]) => assertBotManagementAccess(options.projectId, context, options.assertSession)
  const inventory = () => {
    const source = options.index()
    return { ids: [...new Set(source.ids.filter(id => ID.test(id)))].slice(0, 1000),
      warning: source.warning ?? (source.ids.length > 1000 ? 'connection-index-limit' : source.ids.some(id => !ID.test(id)) ? 'unsafe-connection-entry-omitted' : undefined) }
  }
  const render = (path: string): string => {
    if (!path || path === 'overview') return GUIDE
    const index = /^index(?:\/([1-9][0-9]*))?\.json$/.exec(path)
    if (index) {
      const page = Number(index[1] ?? 1), { ids, warning } = inventory()
      if (!Number.isSafeInteger(page) || page > 1 && (page - 1) * 50 >= ids.length) throw new Error('Connection index page not found.')
      return serialize({ projectId: options.projectId, total: ids.length, page,
        rows: ids.slice((page - 1) * 50, page * 50).map(id => ({ id, path: `v:connections/${id}/overview.json`, sinkPath: `v:connections/${id}/sink.json` })),
        next: page * 50 < ids.length ? `v:connections/index/${page + 1}.json` : null, ...(warning ? { warning } : {}) })
    }
    const receiver = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/receivers\/([^/]+)\.json$/.exec(path)
    if (receiver) {
      const sink = parseConnectionSinkProjection(options.sink(receiver[1]!), options.projectId)
      if (sink.connectionId !== receiver[1]) throw new Error('Connection identity mismatch.')
      const item = sink.receivers.find(item => item.path === `v:connections/${path}`)
      if (!item) throw new Error('Connection receiver not found.')
      return serialize({ ...item, projectId: options.projectId, connectionId: sink.connectionId,
        connectionPath: sink.connectionPath, sinkPath: sink.sinkPath, guidePath: sink.guidePath })
    }
    const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/(overview|sink)\.json$/.exec(path)
    if (!match) throw new Error('Connection path not found. Read v:connections/overview.')
    const id = match[1]!
    // Validate the live projection even for overview: it carries Project ownership.
    const sink = parseConnectionSinkProjection(options.sink(id), options.projectId)
    if (sink.connectionId !== id) throw new Error('Connection identity mismatch.')
    const overview = overviewSchema.parse(options.overview(id))
    if (overview.id !== id) throw new Error('Connection identity mismatch.')
    return serialize(match[2] === 'sink' ? sink : { ...overview, projectId: options.projectId,
      connectionPath: sink.connectionPath, sinkPath: sink.sinkPath, guidePath: sink.guidePath })
  }
  return {
    read: (path, context) => { authorize(context); return render(path) },
    list: (context, query) => {
      authorize(context)
      const scope = query?.subpath ?? '', entries: VirtualEntry[] = []
      const add = (name: string, warning?: string) => {
        if (!scope || name === scope || name.startsWith(`${scope}/`)) {
          context.signal.throwIfAborted()
          entries.push({ name, content: query?.content === false ? '' : render(name), ...(warning ? { warning } : {}) })
        }
      }
      add('overview')
      const object = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})(?:\/(?:overview\.json|sink\.json|receivers(?:\/[^/]+\.json)?))?$/.exec(scope)
      if (object && !['overview', 'index'].includes(object[1]!)) {
        // Explicit searches do not enumerate siblings; validate even name-only lists.
        render(`${object[1]}/sink.json`)
        add(`${object[1]}/overview.json`); add(`${object[1]}/sink.json`)
        const sink = parseConnectionSinkProjection(options.sink(object[1]!), options.projectId)
        for (const receiver of sink.receivers) add(receiver.path.slice('v:connections/'.length))
        return entries
      }
      const { ids, warning } = inventory()
      for (let page = 1; page <= Math.max(1, Math.ceil(ids.length / 50)); page++) add(page === 1 ? 'index.json' : `index/${page}.json`, warning)
      for (const id of ids.slice(0, 50)) { add(`${id}/overview.json`); add(`${id}/sink.json`) }
      if (warning || ids.length > 50) entries.push({ name: 'index.json', content: '', warning: warning ?? 'Broad discovery includes only the first 50 Connections; scope to an ID.' })
      return entries
    },
  }
}
