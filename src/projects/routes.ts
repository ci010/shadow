import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'hono'
import type { GatewayPlugin } from '../gateway/types.ts'
import type { CloneOperation, ProjectRecord } from './contracts.ts'
import { CloneTerminationError, runGitClone, validateCloneUrl, validateDirectoryName, type GitCloneRunner } from './git.ts'
import { absoluteDirectoryPath, existingDirectory, ProjectError, ProjectRegistry, UUID_PATTERN } from './registry.ts'

export interface ProjectServiceOptions {
  registry: ProjectRegistry
  createSession: (project: ProjectRecord) => Promise<{ sessionId: string; chatId: string }>
  gitRunner?: GitCloneRunner
}

interface CloneJob {
  operation: CloneOperation
  controller: AbortController
  done?: Promise<void>
  finishedAt?: number
}

const CANCELLED = 'Clone cancelled. Any partial folder was kept. Inspect it before retrying with a new folder name.'
const FAILED = 'Clone failed. Check Git installation, repository access, and authentication in your terminal. Any partial folder was kept; use a new folder name to retry.'
const REGISTRATION_FAILED = 'Clone completed, but the project could not be saved. The folder was kept. Use Open folder to recover it.'
const HISTORY_LIMIT = 100
const HISTORY_TTL_MS = 10 * 60_000

function operationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ProjectError('invalid_operation_id', 'Provide a UUID clone operation ID.')
  }
  return value.toLowerCase()
}

function snapshot(operation: CloneOperation): CloneOperation {
  return { ...operation, ...(operation.project ? { project: { ...operation.project } } : {}) }
}

async function objectBody(c: Context): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await c.req.json()
  } catch {
    throw new ProjectError('invalid_json', 'Provide a JSON request body.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectError('invalid_request', 'Provide a JSON object.')
  }
  return value as Record<string, unknown>
}

function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof ProjectError) {
    return c.json({ error: error.code, message: error.message }, error.status)
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return c.json({ error: 'request_cancelled', message: 'The request was cancelled.' }, 409)
  }
  return c.json({
    error: 'project_operation_failed',
    message: 'The project operation could not be saved or completed. Check folder permissions and try again.',
  }, 500)
}

export class ProjectService {
  readonly #options: ProjectServiceOptions
  readonly #jobs = new Map<string, CloneJob>()
  #disposed = false
  #disposal?: Promise<void>

  constructor(options: ProjectServiceOptions) {
    this.#options = options
  }

  readonly plugin: GatewayPlugin = (app) => {
    app.get('/api/projects', (c) => c.json({ projects: this.#options.registry.list() }))
    app.post('/api/projects/register', async (c) => {
      try {
        this.#assertOpen()
        const body = await objectBody(c)
        const project = await this.#options.registry.register(
          absoluteDirectoryPath(body.path),
          c.req.raw.signal,
        )
        return c.json({ project })
      } catch (error) {
        return errorResponse(c, error)
      }
    })
    app.post('/api/projects/:id/sessions', async (c) => {
      try {
        this.#assertOpen()
        const project = await this.#options.registry.requireAvailable(c.req.param('id'))
        return c.json(await this.#options.createSession(project))
      } catch (error) {
        return errorResponse(c, error)
      }
    })
    app.post('/api/projects/clone', async (c) => {
      try {
        this.#assertOpen()
        const body = await objectBody(c)
        const operation = this.#startClone(body, c.req.raw.signal)
        return c.json({ operation }, 202)
      } catch (error) {
        return errorResponse(c, error)
      }
    })
    app.get('/api/projects/clone/:id', (c) => {
      try {
        this.#prune()
        const job = this.#jobs.get(operationId(c.req.param('id')))
        if (!job) throw new ProjectError('clone_not_found', 'Clone operation not found.', 404)
        return c.json({ operation: snapshot(job.operation) })
      } catch (error) {
        return errorResponse(c, error)
      }
    })
    app.delete('/api/projects/clone/:id', async (c) => {
      try {
        this.#prune()
        const id = operationId(c.req.param('id'))
        let job = this.#jobs.get(id)
        if (!job) {
          // A keepalive cancellation may arrive before the original POST.
          job = {
            operation: { id, state: 'cancelled', destination: '', error: CANCELLED },
            controller: new AbortController(),
            finishedAt: Date.now(),
          }
          this.#jobs.set(id, job)
        }
        if (job.operation.state === 'running') {
          job.controller.abort()
          await job.done
        }
        this.#prune()
        return c.json({ operation: snapshot(job.operation) })
      } catch (error) {
        return errorResponse(c, error)
      }
    })
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw new ProjectError('projects_stopping', 'Project services are shutting down.', 503)
    }
  }

  #startClone(body: Record<string, unknown>, requestSignal: AbortSignal): CloneOperation {
    this.#assertOpen()
    this.#prune()
    const id = operationId(body.operationId)
    const url = validateCloneUrl(body.url)
    const directoryName = validateDirectoryName(body.directoryName)
    const parentPath = absoluteDirectoryPath(body.parentPath)
    const destination = join(parentPath, directoryName)
    const existing = this.#jobs.get(id)
    if (existing) {
      if (!existing.operation.destination) existing.operation.destination = destination
      return snapshot(existing.operation)
    }
    if ([...this.#jobs.values()].some((job) => job.operation.state === 'running')) {
      throw new ProjectError('clone_busy', 'Wait for the current clone or cancel it first.', 409)
    }
    const job: CloneJob = {
      operation: { id, state: 'running', destination },
      controller: new AbortController(),
    }
    this.#jobs.set(id, job)
    const cancel = () => job.controller.abort()
    requestSignal.addEventListener('abort', cancel, { once: true })
    if (requestSignal.aborted) cancel()
    job.done = this.#clone(job, url, parentPath, directoryName).finally(() => {
      requestSignal.removeEventListener('abort', cancel)
      job.finishedAt = Date.now()
      this.#prune()
    })
    return snapshot(job.operation)
  }

  async #clone(job: CloneJob, url: string, parentPath: string, directoryName: string): Promise<void> {
    const signal = job.controller.signal
    let cloned = false
    try {
      signal.throwIfAborted()
      const parent = await existingDirectory(parentPath)
      signal.throwIfAborted()
      const destination = join(parent, directoryName)
      job.operation.destination = destination
      try {
        // Exclusive directory creation reserves only our destination; never remove it.
        await mkdir(destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ProjectError('destination_exists', 'The destination already exists. Choose a new folder name; no existing data was changed.', 409)
        }
        throw error
      }
      signal.throwIfAborted()
      await (this.#options.gitRunner ?? runGitClone)({ url, destination, signal })
      cloned = true
      signal.throwIfAborted()
      const project = await this.#options.registry.register(destination, signal)
      // Registry rename is the commit point, so a committed project is success even
      // if cancellation arrives during that rename.
      job.operation = { id: job.operation.id, state: 'succeeded', destination, project }
    } catch (error) {
      const cancelled = signal.aborted && error instanceof Error && error.name === 'AbortError'
      job.operation.state = cancelled ? 'cancelled' : 'failed'
      job.operation.error = error instanceof CloneTerminationError
        ? error.message
        : cancelled
        ? CANCELLED
        : cloned
        ? REGISTRATION_FAILED
        : error instanceof ProjectError
        ? error.message
        : FAILED
    }
  }

  #prune(): void {
    const terminal = [...this.#jobs.entries()]
      .filter(([, job]) => job.finishedAt !== undefined)
      .sort((a, b) => a[1].finishedAt! - b[1].finishedAt!)
    const now = Date.now()
    for (let index = 0; index < terminal.length; index++) {
      const [id, job] = terminal[index]
      if (index < terminal.length - HISTORY_LIMIT || now - job.finishedAt! > HISTORY_TTL_MS) {
        this.#jobs.delete(id)
      }
    }
  }

  dispose(): Promise<void> {
    this.#disposed = true
    return this.#disposal ??= (async () => {
      const jobs = [...this.#jobs.values()]
      for (const job of jobs) {
        if (job.operation.state === 'running') job.controller.abort()
      }
      await Promise.all(jobs.map((job) => job.done))
    })()
  }
}
