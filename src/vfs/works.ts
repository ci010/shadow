import type { WorkAlignment } from '../sessions/work-alignment.ts'
import { WORK_HELP } from '../sessions/work-alignment.ts'
import { WorkTool } from '../tools/work.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { VirtualEntry, VirtualFsHandler, VirtualFsListHandler } from './virtual-fs.ts'

const PAGE = 20
const GUIDE = `Read-only current Project Work. Notes orient work, never grant permission or imply human acceptance.
Paths: v:works/index (20 receipts/page), v:works/index/2, v:works/context (associated keys, 20/page), v:works/context/2,
v:works/keys/<encodeURIComponent(key)> (current definition, notes, authority, assignment delivery and ancestor path); append /definition, /notes or /path for a focused view.
Use search with path v:works for bounded discovery; broad search includes only the first 20 records and warns when incomplete. Follow index pages or narrow search to an exact key path. No history or retired fields are exported.
Read v:works/schema for field help. Mutations are dynamic tools: discover v:tools/work_create, work_update, work_assign, work_review, work_link; invoke_tool({name:"work_update",args:{key,version,notes:{summary:"Result"}}}). Source and callable names coincide. No action/data wrapper. Existing Project/session/mode/authority checks still apply.`
const keyPath = (key: string) => `keys/${encodeURIComponent(key)}`
function page(raw?: string): number {
  const value = raw === undefined ? 1 : Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > Math.floor(Number.MAX_SAFE_INTEGER / PAGE)) throw new Error('Invalid Work page.')
  return value
}
export function createWorksHandler(alignment: WorkAlignment): { read: VirtualFsHandler; list: VirtualFsListHandler } {
  const tool = new WorkTool(alignment)
  const authorize = (context: ExecutionContext) => {
    context.signal.throwIfAborted()
    if (!context.tools.canUseDynamic('work_update')) throw new Error('Work is unavailable for this agent type.')
    const denied = context.tools.executionDenial('work', {})
    if (denied) throw new Error(denied)
    // Same runtime-bound Project identity check as the former context operation.
    alignment.context(context.sessionId, undefined, false)
  }
  const index = async (n: number, context: ExecutionContext) => {
    const result = await alignment.execute({ kind: 'session', sessionId: context.sessionId }, 'list', undefined, undefined,
      { limit: PAGE, offset: (n - 1) * PAGE }, context.signal) as { items: Array<{ key: string }>; hasMore: boolean }
    return { ...result, items: result.items.map(item => ({ ...item, path: `v:works/${keyPath(item.key)}` })),
      next: result.hasMore ? `v:works/index/${n + 1}` : null }
  }
  const render = async (path: string, context: ExecutionContext): Promise<string> => {
    if (!path || path === 'overview') return GUIDE
    if (path === 'schema') return JSON.stringify(WORK_HELP, null, 2)
    const match = /^(index|context)(?:\/([1-9][0-9]*))?$/.exec(path)
    if (match) {
      const n = page(match[2])
      if (match[1] === 'index') return JSON.stringify(await index(n, context), null, 2)
      const keys = alignment.store.workSessionKeys(context.sessionId)
      return JSON.stringify({ selected: alignment.context(context.sessionId).selected, total: keys.length,
        items: keys.slice((n - 1) * PAGE, n * PAGE).map(key => ({ key, path: `v:works/${keyPath(key)}` })),
        next: n * PAGE < keys.length ? `v:works/context/${n + 1}` : null }, null, 2)
    }
    if (path.startsWith('keys/')) {
      const [encoded = '', view] = path.slice(5).split('/')
      if (path.slice(5).split('/').length > 2 || view && !['definition', 'notes', 'path'].includes(view)) throw new Error('Work view not found.')
      const key = decodeURIComponent(encoded)
      if (!key || key.length > 600 || encoded !== encodeURIComponent(key)) throw new Error('Use the encoded key path returned by the index.')
      const result = JSON.parse(await tool.execute({ action: 'context', key }, context))
      // Exact-key reads (also expanded by grep) must not duplicate the adapter's
      // unpaginated association inventory. Discovery lives in context pages only.
      if (!view) return JSON.stringify({ selected: result.selected, records: result.records,
        associatedPath: 'v:works/context' })
      const record = result.records[0]
      return JSON.stringify({ key, version: record.version, goalRevision: record.goalRevision, [view]: record[view] }, null, 2)
    }
    throw new Error('Work path not found. Read v:works/overview.')
  }
  return {
    read: (path, context) => { authorize(context); return render(path, context) },
    list: async (context, options) => {
      authorize(context)
      const scope = options?.subpath ?? ''
      const entries: VirtualEntry[] = []
      const add = async (name: string) => {
        if (!scope || scope === name || name.startsWith(`${scope}/`)) entries.push({ name,
          content: options?.content === false ? '' : await render(name, context) })
      }
      if (scope.startsWith('keys/')) {
        // Name-only discovery must not invent entries for missing/invalid keys.
        await render(scope, context)
        for (const suffix of ['', '/definition', '/notes', '/path']) await add(scope.split('/').slice(0, 2).join('/') + suffix)
        return entries
      }
      if (/^(index|context)\/[1-9][0-9]*$/.test(scope)) { await add(scope); return entries }
      await add('overview'); await add('schema'); await add('context'); await add('index')
      const first = await index(1, context)
      for (const item of first.items) await add(keyPath(item.key))
      if (first.hasMore) entries.push({ name: 'index', content: '', warning: 'Work discovery includes only the first 20 records. Follow v:works/index/2 or search an exact encoded key path.' })
      return entries
    },
  }
}
