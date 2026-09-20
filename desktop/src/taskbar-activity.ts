import { normalizeLoopbackOrigin, type RuntimeAuthorization } from './runtime-authorization.js'
import type { LocalControlFetch } from './sidecar/local-control-client.js'

interface TaskbarWindow {
  isDestroyed(): boolean
  setProgressBar(progress: number, options?: { mode: 'indeterminate' }): void
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}

interface ActivityOptions {
  fetch?: LocalControlFetch
  onError?: (message: string) => void
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function projectIds(value: unknown): string[] {
  if (!record(value) || !Array.isArray(value.projects)) throw new Error('Invalid project activity catalog')
  const ids = value.projects.map(project => {
    if (!record(project) || typeof project.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(project.id)) {
      throw new Error('Invalid project activity identity')
    }
    return project.id
  })
  return [...new Set(ids)]
}

function isWorking(value: unknown): boolean {
  if (!record(value) || !record(value.stages)) throw new Error('Invalid session activity snapshot')
  const stages = Object.values(value.stages)
  if (stages.some(stage => typeof stage !== 'string' || !['idle', 'inactive', 'llm', 'tool', 'waiting'].includes(stage))) {
    throw new Error('Invalid session activity stage')
  }
  return stages.some(stage => stage === 'llm' || stage === 'tool' || stage === 'waiting')
}

/** Native-only observation of Main's existing project/session snapshots. */
export class TaskbarActivity {
  private authorization: RuntimeAuthorization | null = null
  private request: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private working: boolean | undefined
  private disposed = false
  private lastError = ''

  constructor(private readonly window: TaskbarWindow, private readonly options: ActivityOptions = {}) {
    window.once('closed', this.dispose)
    this.display(false)
  }

  setAuthorization(authorization: RuntimeAuthorization | null): void {
    if (this.disposed) return
    if (authorization && (normalizeLoopbackOrigin(authorization.apiBase) !== authorization.apiBase || !authorization.launchToken)) {
      throw new TypeError('Taskbar activity requires authenticated loopback Main')
    }
    if (authorization?.apiBase === this.authorization?.apiBase && authorization?.launchToken === this.authorization?.launchToken) return
    this.stopRequest()
    this.authorization = authorization ? { ...authorization } : null
    this.lastError = ''
    this.display(false)
    if (this.authorization) void this.refresh()
  }

  async refresh(): Promise<void> {
    const authorization = this.authorization
    if (this.disposed || !authorization || this.request) return
    clearTimeout(this.timer)
    const controller = new AbortController()
    this.request = controller
    const timeout = setTimeout(() => controller.abort(new Error('Taskbar activity request timed out')), 5000)
    const current = () => !this.disposed && this.request === controller
    const errors: string[] = []
    let working = false
    const read = async (path: string, project = false): Promise<{ available: false } | { available: true; value: unknown }> => {
      const response = await (this.options.fetch ?? globalThis.fetch)(new URL(path, authorization.apiBase), {
        method: 'GET', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json', Authorization: `Bearer ${authorization.launchToken}` },
        signal: controller.signal,
      })
      if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
        throw new Error('Taskbar activity response is not JSON')
      }
      const body: unknown = await response.json()
      if (project && response.status === 503 && record(body) && body.error === 'project_unavailable'
        && (body.state === 'starting' || body.state === 'failed')) return { available: false }
      if (!response.ok) throw new Error(`Taskbar activity request failed (HTTP ${response.status})`)
      return { available: true, value: body }
    }
    try {
      const catalog = await read('/api/projects')
      if (!catalog.available) throw new Error('Project activity catalog is unavailable')
      const ids = projectIds(catalog.value)
      let index = 0
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (current() && !controller.signal.aborted) {
          const id = ids[index++]
          if (id === undefined) break
          try {
            const snapshot = await read(`/projects/${encodeURIComponent(id)}/api/sessions/stages`, true)
            if (!snapshot.available) continue
            const active = isWorking(snapshot.value)
            working ||= active
            if (active && current()) this.display(true)
          } catch (error) {
            errors.push(error instanceof Error ? error.message : 'Could not read project activity')
          }
        }
      }))
      if (controller.signal.aborted) errors.push('Taskbar activity request timed out')
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Could not read Main activity')
    } finally {
      clearTimeout(timeout)
      if (current()) {
        this.display(working)
        const error = [...new Set(errors)].sort().join('; ')
        if (error && error !== this.lastError) {
          (this.options.onError ?? (message => console.error('[desktop] Agent activity unavailable:', message)))(error)
        }
        this.lastError = error
        this.request = undefined
        this.timer = setTimeout(() => { void this.refresh() }, 1500)
        this.timer.unref()
      }
    }
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.stopRequest()
    this.authorization = null
    this.display(false)
    this.window.removeListener('closed', this.dispose)
  }

  private stopRequest(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.request?.abort()
    this.request = undefined
  }

  private display(working: boolean): void {
    if (this.working === working || this.window.isDestroyed()) return
    this.working = working
    if (working) this.window.setProgressBar(2, { mode: 'indeterminate' })
    else this.window.setProgressBar(-1)
  }
}
