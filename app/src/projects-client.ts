import type { CloneOperation, ProjectRecord } from '../../src/projects/contracts.ts'
import { isRecord } from './projects-sidebar.ts'

export type { CloneOperation, ProjectRecord }

const invalidResponse = () => new Error('Main returned an invalid project response. Refresh and retry.')

function safeProjectMessage(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 500
    || /[\u0000-\u001f]|[a-z][a-z\d+.-]*:\/\/|\S+@\S+:|\b(?:token|password|authorization)\s*[=:]|\b(?:fatal|stderr)\s*:|github_pat_|gh[pousr]_/i.test(value)) return undefined
  return value.trim()
}

export function parseProject(value: unknown): ProjectRecord {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id
    || typeof value.name !== 'string' || !value.name || typeof value.path !== 'string' || !value.path
    || typeof value.createdAt !== 'string') throw invalidResponse()
  return { id: value.id, name: value.name, path: value.path, createdAt: value.createdAt }
}

export function parseCloneOperation(value: unknown, id: string): CloneOperation {
  if (!isRecord(value) || value.id !== id
    || !['running', 'succeeded', 'failed', 'cancelled'].includes(String(value.state))
    || typeof value.destination !== 'string'
    || (value.error !== undefined && typeof value.error !== 'string')) throw invalidResponse()
  const project = value.project === undefined ? undefined : parseProject(value.project)
  if (value.state === 'succeeded' && !project) throw invalidResponse()
  return {
    id, state: value.state as CloneOperation['state'], destination: value.destination, project,
    // Prefer Main's safe recovery guidance, never raw Git output or repository URLs.
    ...(value.state === 'failed' ? {
      error: safeProjectMessage(value.error) ?? 'Clone failed. Check repository access, Git authentication, and available disk space. Choose a new directory before retrying.',
    } : {}),
  }
}

export interface CloneInput {
  url: string
  parentPath: string
  directoryName: string
}

export function createProjectsClient(apiBase: string, request: typeof fetch = fetch) {
  async function json(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await request(`${apiBase}/api/projects${path}`, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (error) {
      if (init?.signal?.aborted) throw error
      throw new Error('Cannot reach Main. Check the connection and retry.')
    }
    if (!response.ok) {
      let data: unknown
      try { data = await response.json() } catch { data = undefined }
      const message = isRecord(data) && typeof data.error === 'string' ? safeProjectMessage(data.message) : undefined
      throw new Error(message ?? (response.status === 401 || response.status === 403
        ? 'Main did not authorize this request. Reconnect and retry.'
        : response.status === 400 || response.status === 409
          ? 'Check the folder path and repository details. The destination must not already exist.'
          : response.status === 404
            ? 'The project or clone could not be found. Refresh and retry.'
            : 'Main could not complete this request. Check Main and retry.'))
    }
    let data: unknown
    try { data = await response.json() } catch { throw invalidResponse() }
    if (!isRecord(data)) throw invalidResponse()
    return data
  }
  return {
    async list(signal?: AbortSignal) {
      const data = await json('', { signal })
      if (!Array.isArray(data.projects)) throw invalidResponse()
      const projects = data.projects.map(parseProject)
      if (new Set(projects.map(project => project.id)).size !== projects.length) throw invalidResponse()
      return projects
    },
    async register(path: string, signal?: AbortSignal) {
      return parseProject((await json('/register', { method: 'POST', body: JSON.stringify({ path }), signal })).project)
    },
    async createSession(projectId: string, signal?: AbortSignal) {
      const data = await json(`/${encodeURIComponent(projectId)}/sessions`, { method: 'POST', signal })
      if (typeof data.chatId !== 'string' || !data.chatId.startsWith('chat-')
        || data.sessionId !== `web:${data.chatId}`) throw invalidResponse()
      return { sessionId: data.sessionId as string, chatId: data.chatId }
    },
    async start(input: CloneInput, operationId: string, signal?: AbortSignal) {
      return parseCloneOperation((await json('/clone', {
        method: 'POST', body: JSON.stringify({ operationId, ...input }), signal,
      })).operation, operationId)
    },
    async poll(operationId: string, signal?: AbortSignal) {
      return parseCloneOperation((await json(`/clone/${encodeURIComponent(operationId)}`, { signal })).operation, operationId)
    },
    async cancel(operationId: string) {
      return parseCloneOperation((await json(`/clone/${encodeURIComponent(operationId)}`, {
        method: 'DELETE', keepalive: true,
      })).operation, operationId)
    },
  }
}

export type ProjectsClient = ReturnType<typeof createProjectsClient>
export interface CloneView {
  state: CloneOperation['state'] | 'idle' | 'starting' | 'cancelling' | 'unknown'
  operation?: CloneOperation
  error?: string
}

export function createCloneController(
  client: Pick<ProjectsClient, 'start' | 'poll' | 'cancel'>,
  changed: (view: CloneView) => void,
  schedule: (callback: () => void, delay: number) => () => void = (callback, delay) => {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  },
  createId: () => string = () => crypto.randomUUID(),
) {
  let view: CloneView = { state: 'idle' }
  let activeId: string | undefined
  let generation = 0
  let request: AbortController | undefined
  let unschedule: (() => void) | undefined
  let cancellation: Promise<void> | undefined
  const update = (next: CloneView) => { view = next; changed(next) }
  const clear = () => {
    unschedule?.()
    unschedule = undefined
    request?.abort()
    request = undefined
  }
  function accept(operation: CloneOperation, current: number) {
    if (current !== generation) return
    if (operation.state !== 'running') activeId = undefined
    update({ state: operation.state, operation, error: operation.error })
    if (operation.state === 'running') {
      unschedule = schedule(() => { unschedule = undefined; void refresh() }, 1500)
    }
  }
  async function refresh() {
    if (!activeId || cancellation || request) return
    unschedule?.()
    unschedule = undefined
    const current = generation
    const controller = new AbortController()
    request = controller
    try {
      const operation = await client.poll(activeId, controller.signal)
      accept(operation, current)
    } catch {
      if (current === generation) update({
        state: 'unknown', operation: view.operation,
        error: 'Clone status could not be refreshed. The clone may still be running. Retry status or cancel.',
      })
    } finally {
      if (request === controller) request = undefined
    }
  }
  async function start(input: CloneInput) {
    if (activeId || cancellation) return
    clear()
    const current = ++generation
    const id = createId()
    activeId = id
    const controller = new AbortController()
    request = controller
    update({ state: 'starting' })
    try {
      accept(await client.start(input, id, controller.signal), current)
    } catch (error) {
      if (current !== generation) return
      // A lost POST response does not prove Git never started. Cancel this ID first.
      await cancel()
      if (view.state === 'cancelled') update({
        ...view, error: error instanceof Error ? error.message : 'Could not start cloning. Check the connection and retry.',
      })
    } finally {
      if (request === controller) request = undefined
    }
  }
  function cancel(): Promise<void> {
    if (cancellation) return cancellation
    clear()
    if (!activeId) return Promise.resolve()
    const current = ++generation
    const id = activeId
    update({ state: 'cancelling', operation: view.operation })
    cancellation = (async () => {
      try {
        const operation = await client.cancel(id)
        accept(operation, current)
        if (operation.state === 'running') {
          unschedule?.()
          unschedule = undefined
          update({ state: 'unknown', operation, error: 'Cancellation is not confirmed. Retry cancellation or check status.' })
        }
      } catch {
        update({
          state: 'unknown', operation: view.operation,
          error: 'Could not confirm cancellation. The clone may still be running. Reconnect, then retry cancellation or check status.',
        })
      } finally {
        cancellation = undefined
      }
    })()
    return cancellation
  }
  function reset() {
    if (activeId || cancellation) return
    clear()
    ++generation
    update({ state: 'idle' })
  }
  return { start, refresh, cancel, reset }
}
