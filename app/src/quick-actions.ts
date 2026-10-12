import { apiUrl, projectBase, hostBase } from './api-url.ts'

export interface QuickAction { id: string; name: string; command: string; folderId: string; pinned: boolean }
export interface ActionRun { id: string; actionId: string; name: string; command: string; folderId: string; state: 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped'; startedAt: string; finishedAt?: string; exitCode?: number | null; stdout: string; stderr: string }
export interface ActionFolder { id: string; name: string; path: string; kind: 'local' | 'remote' }
export interface ActionScript { name: string; command: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = () => new Error('Main returned invalid Quick Actions data. Refresh before retrying.')
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
export function parseQuickAction(value: unknown): QuickAction {
  if (!record(value) || !text(value.id) || !text(value.name) || !text(value.command) || !text(value.folderId) || typeof value.pinned !== 'boolean') throw invalid()
  return { id: value.id, name: value.name, command: value.command, folderId: value.folderId, pinned: value.pinned }
}
export function parseActionRun(value: unknown): ActionRun {
  if (!record(value) || !text(value.id) || !text(value.actionId) || !text(value.name) || !text(value.command) || !text(value.folderId)
    || !['running', 'stopping', 'succeeded', 'failed', 'stopped'].includes(String(value.state)) || !text(value.startedAt)
    || typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
    || (value.finishedAt !== undefined && !text(value.finishedAt))
    || (value.exitCode !== undefined && value.exitCode !== null && (!Number.isInteger(value.exitCode)))) throw invalid()
  return value as unknown as ActionRun
}
export function actionRunning(run: ActionRun) { return run.state === 'running' || run.state === 'stopping' }
export function createQuickActionsClient(base: string, projectId: string, request: typeof fetch = fetch) {
  if (!projectId.trim()) throw new Error('Select a Project to use Quick Actions.')
  const scope = projectBase(hostBase(base), projectId)
  async function json(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await request(apiUrl(scope, path), { ...init, headers: { 'Content-Type': 'application/json', ...init.headers },
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
    let value: unknown
    try { value = await response.json() } catch { throw new Error(`Main returned an unreadable response (HTTP ${response.status}). Refresh before retrying.`) }
    if (!response.ok) {
      const message = record(value) && typeof value.message === 'string' ? value.message : record(value) && typeof value.error === 'string' ? value.error : `Quick Actions request failed (HTTP ${response.status}).`
      throw new Error(message)
    }
    if (!record(value)) throw invalid()
    return value
  }
  const actionPath = (id: string) => `/api/actions/${encodeURIComponent(id)}`
  function list<T>(value: unknown, parse: (item: unknown) => T): T[] { if (!Array.isArray(value)) throw invalid(); return value.map(parse) }
  function assertId<T extends { id: string }>(value: T, id: string) { if (value.id !== id) throw invalid(); return value }
  return {
    async actions(signal?: AbortSignal) { return list((await json('/api/actions', { signal })).actions, parseQuickAction) },
    async folders(signal?: AbortSignal) {
      return list((await json('/api/folders', { signal })).folders, (value): ActionFolder => {
        // FolderRecord's legacy/local wire shape deliberately omits kind. Only an
        // absent kind means local; unknown explicit kinds must never become local.
        if (!record(value) || !text(value.id) || !text(value.name) || typeof value.path !== 'string'
          || (value.kind !== undefined && value.kind !== 'local' && value.kind !== 'remote')) throw invalid()
        return { id: value.id, name: value.name, path: value.path, kind: value.kind ?? 'local' } as ActionFolder
      })
    },
    async save(input: Partial<Omit<QuickAction, 'id'>>, id?: string, signal?: AbortSignal) {
      if ((!id && (!input.name?.trim() || !input.command?.trim() || !input.folderId?.trim()))
        || ['name', 'command', 'folderId'].some(key => key in input && !text(input[key as keyof typeof input]))) throw new Error('Enter a name, command and explicit target folder.')
      const action = parseQuickAction((await json(id ? actionPath(id) : '/api/actions', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(input), signal })).action)
      return id ? assertId(action, id) : action
    },
    async remove(id: string, signal?: AbortSignal) { if ((await json(actionPath(id), { method: 'DELETE', signal })).deletedActionId !== id) throw invalid() },
    async scripts(folderId: string, signal?: AbortSignal) {
      if (!folderId.trim()) throw new Error('Choose a target folder before discovering scripts.')
      const value = await json(`/api/actions/scripts?folderId=${encodeURIComponent(folderId)}`, { signal })
      if (!text(value.packageManager)) throw invalid()
      if (value.unsupportedScripts !== undefined && (!Array.isArray(value.unsupportedScripts) || !value.unsupportedScripts.every(item => typeof item === 'string'))) throw invalid()
      return { unsupportedScripts: (value.unsupportedScripts ?? []) as string[], packageManager: value.packageManager, scripts: list(value.scripts, (item): ActionScript => {
        if (!record(item) || !text(item.name) || !text(item.command)) throw invalid()
        return { name: item.name, command: item.command }
      }) }
    },
    async run(id: string, signal?: AbortSignal) {
      const run = parseActionRun((await json(`${actionPath(id)}/run`, { method: 'POST', signal })).run)
      if (run.actionId !== id) throw invalid()
      return run
    },
    async runs(signal?: AbortSignal) { return list((await json('/api/actions/runs', { signal })).runs, parseActionRun) },
    async status(id: string, signal?: AbortSignal) { return assertId(parseActionRun((await json(`/api/actions/runs/${encodeURIComponent(id)}`, { signal })).run), id) },
    async stop(id: string, signal?: AbortSignal) { return assertId(parseActionRun((await json(`/api/actions/runs/${encodeURIComponent(id)}/stop`, { method: 'POST', signal })).run), id) },
  }
}

/** Notify other surfaces without copying or persisting a second action catalog. */
export function notifyQuickActionsChanged(projectId: string) { window.dispatchEvent(new CustomEvent('shadow:quick-actions-changed', { detail: projectId })) }
