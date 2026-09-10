import type { Hono } from 'hono'
import type { SessionManager } from './session-manager.ts'
import type { GatewayPlugin } from '../gateway/types.ts'
import { newPhysicalSessionId } from '../utils/paths.ts'
import {
  resolveSessionLocations,
  type SessionLocalityState,
  type WorkdirCapabilityLookup,
  type WorkdirResolution,
  type WorkdirUnavailableReason,
} from './locality.ts'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { FILESYSTEM_READ_OPERATION } from '../execution/capability-filesystem.ts'
import {
  executeRemoteFilesystemText,
  RemoteFilesystemError,
} from '../execution/remote-filesystem-client.ts'

/** Map a file extension to a best-effort MIME type for raw serving. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

/** Resolve `relPath` within `baseDir`, returning null on traversal escape. */
export function resolveInWorkspace(
  baseDir: string,
  relPath: string,
): string | null {
  const cleaned = relPath.replace(/^[/\\]+/, '')
  const target = resolve(baseDir, cleaned)
  if (target !== baseDir && !target.startsWith(baseDir + sep)) return null
  return target
}

export type WorkdirUnavailableAction =
  | 'connect_node'
  | 'select_workdir_capability'
  | 'upgrade_node'

export interface WorkdirUnavailableApiResult {
  error: 'workdir_unavailable'
  key: string
  nodeId: string
  capabilityId: string
  reason: WorkdirUnavailableReason
  action: WorkdirUnavailableAction
}

export interface RemoteWorkdirRequiresExecutorApiResult {
  error: 'remote_workdir_requires_executor'
  key: string
  nodeId: string
  capabilityId: string
}

export function resolveSessionFileBase(
  workspace: string,
  key: string,
  state?: SessionLocalityState,
  workdirCapabilityLookup?: WorkdirCapabilityLookup,
): WorkdirResolution {
  return resolveSessionLocations(
    workspace,
    state ?? { sessionId: key },
    undefined,
    workdirCapabilityLookup,
  ).workdir
}

export function workdirUnavailableApiResult(
  key: string,
  resolution: Extract<WorkdirResolution, { available: false }>,
): WorkdirUnavailableApiResult {
  const action: WorkdirUnavailableAction = resolution.reason === 'incompatible'
    ? 'upgrade_node'
    : resolution.reason === 'capability-missing' ||
        resolution.reason === 'capability-revoked'
    ? 'select_workdir_capability'
    : 'connect_node'

  return {
    error: 'workdir_unavailable',
    key,
    nodeId: resolution.workdir.nodeId,
    capabilityId: resolution.workdir.capabilityId,
    reason: resolution.reason,
    action,
  }
}

function remoteWorkdirRequiresExecutorApiResult(
  key: string,
  resolution: Extract<
    WorkdirResolution,
    { available: true; locality: 'remote' }
  >,
): RemoteWorkdirRequiresExecutorApiResult {
  return {
    error: 'remote_workdir_requires_executor',
    key,
    nodeId: resolution.workdir.nodeId,
    capabilityId: resolution.workdir.capabilityId,
  }
}

export function normalizeRemoteWorkspacePath(input: string): string | null {
  if (input.includes('\0')) return null
  const cleaned = input.replaceAll('\\', '/').replace(/^\/+/, '')
  if (cleaned.split('/').includes('..')) return null
  return cleaned || '.'
}

function remoteFilesystemStatus(error: RemoteFilesystemError): 400 | 404 | 503 {
  if (error.code === 'file-not-found') return 404
  if (
    error.code === 'path-denied' ||
    error.code === 'invalid-filesystem-args' ||
    error.code === 'file-type-denied'
  ) return 400
  return 503
}

function sessionFileBase(
  sessions: SessionManager,
  key: string,
): WorkdirResolution {
  return resolveSessionFileBase(
    sessions.workspace,
    key,
    sessions.getSessionState(key) ?? undefined,
    sessions.workdirCapabilityLookup,
  )
}

/**
 * Gateway plugin exposing read-only session inspection endpoints.
 *
 * - `GET  /api/sessions`       — list all logical sessions
 * - `GET  /api/sessions/graph` — session graph with parent-child edges
 * - `GET  /api/sessions/:key/files`   — list a directory in the session workspace
 * - `GET  /api/sessions/:key/raw`     — raw file bytes (image/video/audio previews)
 * - `GET  /api/sessions/:key/static/*`— static file serving (HTML pages + relative assets)
 * - `GET  /api/sessions/:key/preview` — truncated text preview of a file
 * - `GET  /api/sessions/:key`  — paginated history for a session
 */
export function sessionsApiPlugin(
  sessions: SessionManager | undefined,
): GatewayPlugin {
  return (app: Hono) => {
    app.get('/api/sessions', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const list = await sessions.listSessions()
      return c.json({ sessions: list })
    })

    app.get('/api/sessions/graph', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const list = await sessions.listSessions()

      const nodes: Array<{
        physicalId: string
        logicalId: string
        parentPhysicalId: string | null
        parentIndex: number | null
        isCurrent: boolean
        timestamp: string | null
      }> = []

      const enrichedSessions = []
      for (const session of list) {
        const state = sessions.getSessionState(session.sessionId)
        const firstMsg = await sessions.getFirstUserMessage(session.sessionId)
        enrichedSessions.push({
          ...session,
          title: firstMsg ?? undefined,
          description: state?.description ?? undefined,
          config: state?.config ?? undefined,
          lastActivityAt: state?.lastActivityAt ?? session.lastActivityAt ??
            null,
        })
        for (let i = 0; i <= session.segmentIndex; i++) {
          const physicalId = newPhysicalSessionId(session.sessionId, i)
          const parentPhysicalId = state?.parent?.physicalId ??
            null
          nodes.push({
            physicalId,
            logicalId: session.sessionId,
            parentPhysicalId,
            parentIndex: state?.parent?.index ?? null,
            isCurrent: i === session.segmentIndex,
            timestamp: state?.lastActivityAt ?? null,
          })
        }
      }

      return c.json({ sessions: enrichedSessions, nodes })
    })

    // ── PATCH /api/sessions/:key/config — update per-session model config ──
    app.patch('/api/sessions/:key/config', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = decodeURIComponent(c.req.param('key'))
      const state = await sessions.getSessionState(key)
      if (!state) {
        return c.json({ error: 'session_not_found', key }, 404)
      }

      let body: Record<string, unknown>
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'invalid_json' }, 400)
      }

      // A `null` value clears the key so it falls back to the global config.
      const setPatch: Record<string, unknown> = {}
      const unsetKeys: Array<'model' | 'thinking' | 'reasoningEffort'> = []

      if ('model' in body) {
        const v = body.model
        if (v === null) unsetKeys.push('model')
        else if (typeof v === 'string' && v.trim()) setPatch.model = v
        else return c.json({ error: 'invalid_model' }, 400)
      }

      if ('reasoningEffort' in body) {
        const v = body.reasoningEffort
        if (v === null) unsetKeys.push('reasoningEffort')
        else if (v === 'high' || v === 'max') setPatch.reasoningEffort = v
        else return c.json({ error: 'invalid_reasoningEffort' }, 400)
      }

      if ('thinking' in body) {
        const v = body.thinking as { type?: unknown } | null
        if (v === null) unsetKeys.push('thinking')
        else if (v?.type === 'enabled' || v?.type === 'disabled') {
          setPatch.thinking = { type: v.type }
        } else return c.json({ error: 'invalid_thinking' }, 400)
      }

      if (Object.keys(setPatch).length > 0) {
        await sessions.setSessionConfig(key, setPatch)
      }
      for (const k of unsetKeys) {
        await sessions.unsetSessionConfig(key, k)
      }

      return c.json({ key, config: sessions.getSessionConfig(key) })
    })

    app.get('/api/sessions/:key/context', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = decodeURIComponent(c.req.param('key'))
      try {
        const result = await sessions.getContext({ sessionId: key })
        if (!result) {
          return c.json({ error: 'session_not_found', key }, 404)
        }
        return c.json({
          key,
          systemPrompt: result.systemPrompt,
          tools: result.tools,
        })
      } catch (err) {
        return c.json({
          error: 'context_retrieval_failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 500)
      }
    })

    // ── Session workspace file browsing ────────────────────────────────
    // List a directory inside a session's working directory.
    app.get('/api/sessions/:key/files', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = decodeURIComponent(c.req.param('key'))
      const relPath = c.req.query('path') ?? ''
      const base = sessionFileBase(sessions, key)
      if (!base.available) {
        return c.json(workdirUnavailableApiResult(key, base), 503)
      }
      if (base.locality === 'remote') {
        const path = normalizeRemoteWorkspacePath(relPath)
        if (!path) return c.json({ error: 'invalid_path' }, 400)
        const executor = sessions.remoteExecutor
        if (!executor) {
          return c.json(remoteWorkdirRequiresExecutorApiResult(key, base), 501)
        }
        try {
          const output = await executeRemoteFilesystemText(
            {
              executor,
              nodeId: base.workdir.nodeId,
              capabilityId: base.workdir.capabilityId,
              sessionId: key,
              turnId: `session-files:${crypto.randomUUID()}`,
              signal: c.req.raw.signal,
            },
            FILESYSTEM_READ_OPERATION,
            { path },
          )
          const entries = output.length === 0 ? [] : output.split('\n').map(
            (entry) => {
              const isDir = entry.endsWith('/')
              const name = isDir ? entry.slice(0, -1) : entry
              return {
                name,
                type: isDir ? 'dir' as const : 'file' as const,
                ext: isDir ? '' : extname(name).toLowerCase(),
                size: 0,
                mtime: null,
              }
            },
          )
          entries.sort((left, right) => {
            if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
            return left.name.localeCompare(right.name)
          })
          return c.json({
            key,
            path: path === '.' ? '' : path,
            entries,
          })
        } catch (error) {
          if (error instanceof RemoteFilesystemError) {
            return c.json({
              error: 'remote_filesystem_failed',
              code: error.code,
              detail: error.message,
            }, remoteFilesystemStatus(error))
          }
          throw error
        }
      }
      const target = resolveInWorkspace(base.path, relPath)
      if (!target) {
        return c.json({ error: 'invalid_path' }, 400)
      }
      try {
        const dirents = await readdir(target, { withFileTypes: true })
        const entries = await Promise.all(
          dirents.map(async (d) => {
            const full = resolve(target, d.name)
            let size = 0
            let mtime: string | null = null
            try {
              const info = await stat(full)
              size = info.size
              mtime = info.mtime?.toISOString() ?? null
            } catch { /* ignore stat errors */ }
            const isDir = d.isDirectory()
            return {
              name: d.name,
              type: isDir ? 'dir' as const : 'file' as const,
              ext: isDir ? '' : extname(d.name).toLowerCase(),
              size,
              mtime,
            }
          }),
        )
        // Directories first, then files — both alphabetical.
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        const rel = relPath.replace(/^[/\\]+/, '')
        return c.json({ key, path: rel, entries })
      } catch {
        return c.json({ error: 'not_found', path: relPath }, 404)
      }
    })

    // Serve the raw bytes of a file (used for image/video/audio previews).
    app.get('/api/sessions/:key/raw', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = decodeURIComponent(c.req.param('key'))
      const relPath = c.req.query('path') ?? ''
      const base = sessionFileBase(sessions, key)
      if (!base.available) {
        return c.json(workdirUnavailableApiResult(key, base), 503)
      }
      if (base.locality === 'remote') {
        return c.json(remoteWorkdirRequiresExecutorApiResult(key, base), 501)
      }
      const target = resolveInWorkspace(base.path, relPath)
      if (!target) {
        return c.json({ error: 'invalid_path' }, 400)
      }
      try {
        const info = await stat(target)
        if (!info.isFile()) {
          return c.json({ error: 'not_a_file' }, 400)
        }
        const bytes = await readFile(target)
        const mime = MIME_BY_EXT[extname(target).toLowerCase()] ??
          'application/octet-stream'
        return c.body(bytes, 200, {
          'Content-Type': mime,
          'Content-Length': String(info.size),
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        })
      } catch {
        return c.json({ error: 'not_found', path: relPath }, 404)
      }
    })

    // Static file serving: like opening a local file directly, so an HTML page's
    // relative asset references (CSS, fonts, images, scripts) resolve against the
    // request path instead of a query param. Enables full page previews.
    app.get('/api/sessions/:key/static/*', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = decodeURIComponent(c.req.param('key'))
      const pathname = new URL(c.req.url).pathname
      const marker = '/static/'
      const idx = pathname.indexOf(marker)
      const rawRest = idx >= 0 ? pathname.slice(idx + marker.length) : ''
      let relPath: string
      try {
        relPath = decodeURIComponent(rawRest)
      } catch {
        return c.json({ error: 'invalid_path' }, 400)
      }
      const base = sessionFileBase(sessions, key)
      if (!base.available) {
        return c.json(workdirUnavailableApiResult(key, base), 503)
      }
      if (base.locality === 'remote') {
        return c.json(remoteWorkdirRequiresExecutorApiResult(key, base), 501)
      }
      const target = resolveInWorkspace(base.path, relPath)
      if (!target) {
        return c.json({ error: 'invalid_path' }, 400)
      }
      try {
        const info = await stat(target)
        if (!info.isFile()) {
          return c.json({ error: 'not_a_file' }, 400)
        }
        const bytes = await readFile(target)
        const mime = MIME_BY_EXT[extname(target).toLowerCase()] ??
          'application/octet-stream'
        return c.body(bytes, 200, {
          'Content-Type': mime,
          'Content-Length': String(info.size),
          'Cache-Control': 'no-cache',
          // Allow subresources (e.g. @font-face) to load inside the
          // sandboxed, null-origin preview iframe.
          'Access-Control-Allow-Origin': '*',
        })
      } catch {
        return c.json({ error: 'not_found', path: relPath }, 404)
      }
    })

    // Return a truncated text preview of a file (used for text tiles).
    app.get('/api/sessions/:key/preview', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = decodeURIComponent(c.req.param('key'))
      const relPath = c.req.query('path') ?? ''
      const maxBytes = Math.min(
        Math.max(parseInt(c.req.query('maxBytes') ?? '4096', 10) || 4096, 256),
        65536,
      )
      const base = sessionFileBase(sessions, key)
      if (!base.available) {
        return c.json(workdirUnavailableApiResult(key, base), 503)
      }
      if (base.locality === 'remote') {
        const path = normalizeRemoteWorkspacePath(relPath)
        if (!path) return c.json({ error: 'invalid_path' }, 400)
        const executor = sessions.remoteExecutor
        if (!executor) {
          return c.json(remoteWorkdirRequiresExecutorApiResult(key, base), 501)
        }
        try {
          const content = await executeRemoteFilesystemText(
            {
              executor,
              nodeId: base.workdir.nodeId,
              capabilityId: base.workdir.capabilityId,
              sessionId: key,
              turnId: `session-preview:${crypto.randomUUID()}`,
              signal: c.req.raw.signal,
            },
            FILESYSTEM_READ_OPERATION,
            { path },
          )
          const bytes = new TextEncoder().encode(content)
          const slice = bytes.subarray(0, maxBytes)
          return c.json({
            key,
            path: relPath,
            binary: false,
            size: bytes.length,
            truncated: bytes.length > slice.length,
            content: new TextDecoder().decode(slice),
          })
        } catch (error) {
          if (error instanceof RemoteFilesystemError) {
            return c.json({
              error: 'remote_filesystem_failed',
              code: error.code,
              detail: error.message,
            }, remoteFilesystemStatus(error))
          }
          throw error
        }
      }
      const target = resolveInWorkspace(base.path, relPath)
      if (!target) {
        return c.json({ error: 'invalid_path' }, 400)
      }
      try {
        const info = await stat(target)
        if (!info.isFile()) {
          return c.json({ error: 'not_a_file' }, 400)
        }
        const buf = await readFile(target)
        const slice = buf.subarray(0, maxBytes)
        // Heuristic binary detection: a NUL byte in the sampled range.
        if (slice.includes(0)) {
          return c.json({ key, path: relPath, binary: true, size: info.size })
        }
        return c.json({
          key,
          path: relPath,
          binary: false,
          size: info.size,
          truncated: info.size > slice.length,
          content: new TextDecoder().decode(slice),
        })
      } catch {
        return c.json({ error: 'not_found', path: relPath }, 404)
      }
    })

    app.get('/api/sessions/stages', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const list = await sessions.listSessions()
      const stages: Record<string, 'idle' | 'llm' | 'tool' | 'inactive'> = {}
      for (const s of list) {
        const active = sessions.getActiveSession(s.sessionId)
        stages[s.sessionId] = active ? active.phase : 'inactive'
      }
      return c.json({ stages })
    })

    app.get('/api/sessions/:key/stage', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = decodeURIComponent(c.req.param('key'))
      const active = sessions.getActiveSession(key)
      if (active) {
        return c.json({ stage: active.phase })
      }
      // Check if session exists but is not in memory
      const state = await sessions.getSessionState(key)
      if (state) {
        return c.json({ stage: 'inactive' })
      }
      return c.json({ error: 'session_not_found', key }, 404)
    })

    app.delete('/api/sessions/:key', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = decodeURIComponent(c.req.param('key'))
      const state = sessions.getSessionState(key)
      if (!state) {
        return c.json({ error: 'session_not_found', key }, 404)
      }
      const deleted = await sessions.deleteSession(key)
      return c.json({ deleted })
    })

    app.get('/api/sessions/:key', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = decodeURIComponent(c.req.param('key'))
      const url = new URL(c.req.url, 'http://localhost')
      const rawOffset = url.searchParams.get('offset')
      const rawPageSize = url.searchParams.get('pageSize')
      const offset = rawOffset != null ? parseInt(rawOffset, 10) : undefined
      const pageSize = rawPageSize != null
        ? Math.max(1, parseInt(rawPageSize, 10))
        : undefined
      const shallow = url.searchParams.get('shallow') === 'true'

      // Try as logical key first
      const chain = await sessions.listSessions()
      const isLogicalKey = chain.some((s) => s.sessionId === key)

      if (isLogicalKey) {
        const { messages, total } = await sessions.getHistory(
          key,
          { offset, pageSize, shallow },
        )
        // Include segment info so the UI can navigate to previous segments
        const state = sessions.getSessionState(key)
        const segmentIndex = state?.segmentIndex ?? 0
        const currentPhysicalId = newPhysicalSessionId(key, segmentIndex)
        let previousPhysicalId: string | null = null
        if (segmentIndex > 0) {
          previousPhysicalId = newPhysicalSessionId(key, segmentIndex - 1)
        }
        return c.json({
          key,
          total,
          offset,
          pageSize,
          messages,
          segmentIndex,
          currentPhysicalId,
          previousPhysicalId,
        })
      }

      // Fall back to physical session ID
      try {
        const { messages, total } = await sessions
          .getHistory(key, { physicalId: key, offset, pageSize })
        // Read start event to find the previous physical session in the chain
        let previousPhysicalId: string | null = null
        try {
          const firstRecord = await sessions.readFirstRecord(key)
          if (firstRecord?.previous_physical_id) {
            previousPhysicalId = String(firstRecord.previous_physical_id)
          }
        } catch { /* ignore */ }
        return c.json({
          key,
          total,
          offset,
          pageSize,
          messages,
          previousPhysicalId,
        })
      } catch {
        return c.json({ error: 'session_not_found', key }, 404)
      }
    })
  }
}
