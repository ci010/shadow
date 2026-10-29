import { browseDirectories, parseDirectoryListing, pickerPath, FOLDER_PICKER_CAPABILITY, FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION } from './picker.ts'
import type { NodeInventoryResponse } from '../cluster/node-inventory.ts'
import { parseWorkdirRefV1 } from '../sessions/locality.ts'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { GatewayPlugin } from '../gateway/types.ts'
import { serveLocalFiles, staticFilePath } from '../gateway/local-files.ts'
import { fileSearchQuery, remoteFileSearchResult, serveLocalFileSearch } from '../gateway/file-search.ts'
import { serveLocalGit } from '../gateway/local-git.ts'
import type { CloneOperation, FolderRecord } from './contracts.ts'
import { CloneTerminationError, runGitClone, validateCloneUrl, validateDirectoryName, type GitCloneRunner } from './git.ts'
import { absoluteDirectoryPath, existingDirectory, FolderError, FolderRegistry, UUID_PATTERN } from './registry.ts'
import type { Executor } from '../execution/executor.ts'
import { serveRemoteGit } from '../gateway/remote-git.ts'
import { serveRemoteFolderFiles } from './remote-files.ts'
import { RemoteFolderWorkdirUnavailableError } from './remote-ownership.ts'
import { FILESYSTEM_READ_OPERATION } from '../execution/capability-filesystem.ts'
import { executeRemoteFilesystemText, RemoteFilesystemError } from '../execution/remote-filesystem-client.ts'

export interface FolderServiceOptions {
  picker?: { inventory: () => NodeInventoryResponse; executor: Executor }
  registry: FolderRegistry
  createSession: (folder: FolderRecord, requestId?: string) => Promise<{ sessionId: string; chatId: string }>
  gitRunner?: GitCloneRunner
  remoteExecutor?: Executor
}

interface CloneJob {
  operation: CloneOperation
  controller: AbortController
  done?: Promise<void>
  finishedAt?: number
}

const CANCELLED = 'Clone cancelled. Any partial folder was kept. Inspect it before retrying with a new folder name.'
const FAILED = 'Clone failed. Check Git installation, repository access, and authentication in your terminal. Any partial folder was kept; use a new folder name to retry.'
const REGISTRATION_FAILED = 'Clone completed, but the folder could not be saved. The folder was kept. Use Open folder to recover it.'
const HISTORY_LIMIT = 100
const HISTORY_TTL_MS = 10 * 60_000

function operationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new FolderError('invalid_operation_id', 'Provide a UUID clone operation ID.')
  }
  return value.toLowerCase()
}

function snapshot(operation: CloneOperation): CloneOperation {
  return { ...operation, ...(operation.folder ? { folder: { ...operation.folder } } : {}) }
}

async function objectBody(c: Context): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await c.req.json()
  } catch {
    throw new FolderError('invalid_json', 'Provide a JSON request body.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FolderError('invalid_request', 'Provide a JSON object.')
  }
  return value as Record<string, unknown>
}

function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof FolderError) {
    return c.json({ error: error.code, message: error.message,
      ...(error instanceof RemoteFolderWorkdirUnavailableError
        ? { reason: error.reason, nodeId: error.workdir.nodeId, capabilityId: error.workdir.capabilityId } : {}),
    }, error.status)
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return c.json({ error: 'request_cancelled', message: 'The request was cancelled.' }, 409)
  }
  return c.json({
    error: 'folder_operation_failed',
    message: 'The folder operation could not be saved or completed. Check folder permissions and try again.',
  }, 500)
}

export class FolderService {
  readonly #options: FolderServiceOptions
  readonly #jobs = new Map<string, CloneJob>()
  readonly #sessionRequests = new Map<string, { folderId: string; result: Promise<{ sessionId: string; chatId: string }> }>()
  #disposed = false
  #disposal?: Promise<void>

  constructor(options: FolderServiceOptions) {
    this.#options = options
  }

  readonly plugin: GatewayPlugin = (app) => {
    app.get('/api/folders/picker/devices', c => {
      const nodes = this.#options.picker?.inventory().nodes ?? []
      return c.json({ devices: nodes.map(node => ({ nodeId: node.nodeId, name: node.displayName,
        role: node.role, online: node.connection === 'connected',
        supported: node.role === 'main' || node.capabilities.some(cap => cap.capabilityId === FOLDER_PICKER_CAPABILITY && cap.online),
      })) }, 200, { 'Cache-Control': 'no-store' })
    })
    for (const action of ['browse', 'select'] as const) {
      app.post(`/api/folders/picker/${action}`, bodyLimit({ maxSize: 8192, onError: c => c.json({ error: 'body_too_large' }, 413) }), async c => {
        try {
          this.#assertOpen()
          const body = await objectBody(c)
          if (Object.keys(body).sort().join(',') !== 'nodeId,path' || typeof body.nodeId !== 'string' ||
            typeof body.path !== 'string' || body.path.length > 4096 || /[\0\r\n]/.test(body.path)) {
            throw new FolderError('invalid_picker_request', 'Provide a device identity and directory path.')
          }
          const picker = this.#options.picker
          const node = picker?.inventory().nodes.find(n => n.nodeId === body.nodeId)
          if (!picker || !node || node.connection !== 'connected') throw new FolderError('picker_device_offline', 'The selected device is offline. Reconnect and retry.', 503)
          if (node.role === 'main') {
            if (action === 'browse') return c.json({ listing: await browseDirectories(body.path, c.req.raw.signal) })
            return c.json({ folder: await this.#options.registry.register(pickerPath(body.path), c.req.raw.signal) })
          }
          if (!node.capabilities.some(cap => cap.capabilityId === FOLDER_PICKER_CAPABILITY && cap.online)) {
            throw new FolderError('picker_unsupported', 'Update the selected device to support folder browsing, then reconnect.', 409)
          }
          // The path remains opaque on Main; only its owning Child validates/canonicalizes it.
          const output = await executeRemoteFilesystemText({ executor: picker.executor, nodeId: node.nodeId,
            capabilityId: FOLDER_PICKER_CAPABILITY, sessionId: 'owner-folder-picker', turnId: crypto.randomUUID(),
            signal: c.req.raw.signal }, action === 'browse' ? FOLDER_BROWSE_OPERATION : FOLDER_SELECT_OPERATION, { path: body.path }, 2_000_000)
          if (output.length > 2_000_000) throw new Error('Picker result too large')
          const value: unknown = JSON.parse(output)
          if (action === 'browse') return c.json({ listing: parseDirectoryListing(value) })
          const ref = parseWorkdirRefV1(value)
          if (!ref || ref.nodeId !== node.nodeId || !/^picked-v1:[a-f0-9]{64}$/.test(ref.capabilityId)) throw new Error('Invalid selected folder')
          return c.json({ folder: await this.#options.registry.registerRemote(ref, c.req.raw.signal) })
        } catch (error) {
          if (error instanceof TypeError) return c.json({ error: 'invalid_directory', message: 'Check the directory path on the selected device and retry.' }, 400)
          if (error instanceof RemoteFilesystemError) return c.json({ error: 'picker_failed', message: 'The selected device could not access this directory. Check permissions and retry.' }, 503)
          return errorResponse(c, error)
        }
      })
    }
    app.delete('/api/folders/:id', async c => {
      try {
        this.#assertOpen()
        this.assertIdle()
        const folderId = c.req.param('id')
        await this.#options.registry.changeProject(folderId, undefined, c.req.raw.signal)
        return c.json({ removed: true, folderId })
      } catch (error) { return errorResponse(c, error) }
    })
    app.post('/api/folders/:id/move', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'body_too_large' }, 413) }), async c => {
      try {
        this.#assertOpen()
        this.assertIdle()
        const body = await objectBody(c)
        if (Object.keys(body).some(key => key !== 'targetProjectId') ||
          typeof body.targetProjectId !== 'string' || !body.targetProjectId ||
          body.targetProjectId.length > 128) {
          throw new FolderError('invalid_request', 'Provide only a targetProjectId.')
        }
        const folder = await this.#options.registry.changeProject(c.req.param('id'), body.targetProjectId, c.req.raw.signal)
        return c.json({ folder, projectId: body.targetProjectId })
      } catch (error) { return errorResponse(c, error) }
    })
    app.get('/api/folders', (c) => c.json({ folders: this.#options.registry.list() }))
    app.get('/api/folders/:id/files/search', async c => {
      try {
        this.#assertOpen()
        const query = fileSearchQuery(c)
        if (!query) return c.json({ error: 'invalid_query' }, 400)
        const folder = await this.#options.registry.requireAvailable(c.req.param('id'), c.req.raw.signal)
        if (folder.kind !== 'remote') return serveLocalFileSearch(c, folder.path)
        const output = await executeRemoteFilesystemText(this.#remoteTarget(c, folder),
          FILESYSTEM_READ_OPERATION, { path: '.', query })
        try { return c.json(remoteFileSearchResult(output)) }
        catch { return c.json({ error: 'invalid_remote_search_result', message: 'The owning node returned an invalid file search result.' }, 503) }
      } catch (error) {
        if (error instanceof RemoteFilesystemError) return c.json({ error: 'remote_file_search_failed', message: error.message }, 503)
        return errorResponse(c, error)
      }
    })
    for (const operation of ['status', 'diff'] as const) {
      app.get(`/api/folders/:id/git/${operation}`, async c => {
        try {
          this.#assertOpen()
          const folder = await this.#options.registry.requireAvailable(c.req.param('id'), c.req.raw.signal)
          if (folder.kind === 'remote') return serveRemoteGit(c, this.#remoteTarget(c, folder), operation)
          return await serveLocalGit(c, folder.path, operation)
        } catch (error) {
          return errorResponse(c, error)
        }
      })
    }
    // Read-only /:id/{files,raw,preview,static/*} uses the registered folder,
    // independently of sessions. Only POST /:id/sessions materializes a conversation.
    for (const operation of ['files', 'raw', 'preview', 'static'] as const) {
      app.get(`/api/folders/:id/${operation}${operation === 'static' ? '/*' : ''}`, async (c) => {
        try {
          this.#assertOpen()
          const folder = await this.#options.registry.requireAvailable(c.req.param('id'), c.req.raw.signal)
          const path = operation === 'static' ? staticFilePath(c) : c.req.query('path') ?? ''
          if (path === null) return c.json({ error: 'invalid_path' }, 400)
          if (folder.kind === 'remote') return serveRemoteFolderFiles(c, this.#remoteTarget(c, folder), folder,
            operation === 'static' ? 'raw' : operation, path)
          return await serveLocalFiles(c, folder.path, { folderId: folder.id },
            operation === 'static' ? 'raw' : operation, path)
        } catch (error) {
          return errorResponse(c, error)
        }
      })
    }
    app.post('/api/folders/register', async (c) => {
      try {
        this.#assertOpen()
        const body = await objectBody(c)
        if (Object.keys(body).some(key => key !== 'path' && key !== 'description')) {
          throw new FolderError('invalid_request', 'Local folder registration accepts only path and description. Select a remote folder capability to open a remote folder.')
        }
        const folder = await this.#options.registry.register(
          absoluteDirectoryPath(body.path),
          c.req.raw.signal,
          body.description as string | undefined,
        )
        return c.json({ folder })
      } catch (error) {
        return errorResponse(c, error)
      }
    })
    app.post('/api/folders/:id/sessions', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'body_too_large' }, 413) }), async (c) => {
      try {
        this.#assertOpen()
        const text = await c.req.text()
        let body: unknown = {}
        try { if (text) body = JSON.parse(text) } catch {
          throw new FolderError('invalid_json', 'Provide an empty body or a JSON request ID.')
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new FolderError('invalid_request', 'Provide a JSON object.')
        }
        const value = 'requestId' in body ? body.requestId : undefined
        if (value !== undefined && (typeof value !== 'string' || !UUID_PATTERN.test(value))) {
          throw new FolderError('invalid_request_id', 'Provide a UUID request ID.')
        }
        const requestId = typeof value === 'string' ? value.toLowerCase() : undefined
        const folder = await this.#options.registry.requireAvailable(c.req.param('id'), c.req.raw.signal)
        if (!requestId) return c.json(await this.#options.createSession(folder))
        const active = this.#sessionRequests.get(requestId)
        if (active && active.folderId !== folder.id) throw new FolderError('folder_request_conflict', 'This request ID belongs to another folder.', 409)
        const result = active?.result ?? this.#options.createSession(folder, requestId)
        if (!active) this.#sessionRequests.set(requestId, { folderId: folder.id, result })
        try { return c.json(await result) } finally {
          if (this.#sessionRequests.get(requestId)?.result === result) this.#sessionRequests.delete(requestId)
        }
      } catch (error) {
        return errorResponse(c, error)
      }
    })
    app.post('/api/folders/clone', async (c) => {
      try {
        this.#assertOpen()
        const body = await objectBody(c)
        const operation = this.#startClone(body, c.req.raw.signal)
        return c.json({ operation }, 202)
      } catch (error) {
        return errorResponse(c, error)
      }
    })
    app.get('/api/folders/clone/:id', (c) => {
      try {
        this.#prune()
        const job = this.#jobs.get(operationId(c.req.param('id')))
        if (!job) throw new FolderError('clone_not_found', 'Clone operation not found.', 404)
        return c.json({ operation: snapshot(job.operation) })
      } catch (error) {
        return errorResponse(c, error)
      }
    })
    app.delete('/api/folders/clone/:id', async (c) => {
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
      throw new FolderError('folders_stopping', 'Folder services are shutting down.', 503)
    }

  }

  assertIdle(): void {
    if ([...this.#jobs.values()].some(job => job.operation.state === 'running') || this.#sessionRequests.size) {
      throw new FolderError('folder_busy', 'Wait for folder creation and clones to finish or cancel them before changing folder ownership.', 409)
    }
  }

  #remoteTarget(c: Context, folder: import('./contracts.ts').RemoteFolderRecord) {
    if (!this.#options.remoteExecutor) throw new FolderError('remote_executor_unavailable', 'Reconnect the owning device; no local folder was used.', 503)
    return {
      executor: this.#options.remoteExecutor, nodeId: folder.workdir.nodeId, capabilityId: folder.workdir.capabilityId,
      sessionId: `folder:${folder.id}`, turnId: crypto.randomUUID(), signal: c.req.raw.signal,
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
      throw new FolderError('clone_busy', 'Wait for the current clone or cancel it first.', 409)
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
    let release: (() => void) | undefined
    try {
      signal.throwIfAborted()
      const parent = await existingDirectory(parentPath)
      signal.throwIfAborted()
      const destination = join(parent, directoryName)
      job.operation.destination = destination
      release = await this.#options.registry.reserveDestination(destination)
      try {
        // Exclusive directory creation reserves only our destination; never remove it.
        await mkdir(destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FolderError('destination_exists', 'The destination already exists. Choose a new folder name; no existing data was changed.', 409)
        }
        throw error
      }
      signal.throwIfAborted()
      await (this.#options.gitRunner ?? runGitClone)({ url, destination, signal })
      cloned = true
      signal.throwIfAborted()
      const folder = await this.#options.registry.register(destination, signal)
      // Registry rename is the commit point, so a committed folder is success even
      // if cancellation arrives during that rename.
      job.operation = { id: job.operation.id, state: 'succeeded', destination, folder }
    } catch (error) {
      const cancelled = signal.aborted && error instanceof Error && error.name === 'AbortError'
      job.operation.state = cancelled ? 'cancelled' : 'failed'
      job.operation.error = error instanceof CloneTerminationError
        ? error.message
        : cancelled
        ? CANCELLED
        : cloned
        ? REGISTRATION_FAILED
        : error instanceof FolderError
        ? error.message
        : FAILED
    } finally { release?.() }
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
