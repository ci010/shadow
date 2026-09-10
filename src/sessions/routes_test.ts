import assert, { deepEqual as assertEquals, notDeepEqual as assertNotEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import type {
  CancelReceiptV1,
  JobEventV1,
  JobRequestV1,
  JobStatusV1,
} from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import type { SessionManager } from './session-manager.ts'
import {
  resolveInWorkspace,
  resolveSessionFileBase,
  sessionsApiPlugin,
  workdirUnavailableApiResult,
} from './routes.ts'

class RouteFilesystemExecutor implements Executor {
  readonly requests: JobRequestV1[] = []

  async *execute(request: JobRequestV1): AsyncIterable<JobEventV1> {
    this.requests.push(request)
    const path = (request.args as { path: string }).path
    const chunk = path === '.' ? 'z.txt\nfolder/\na.md' : 'hello remote'
    const timestamp = new Date().toISOString()
    yield {
      version: 1,
      jobId: request.jobId,
      sequence: 0,
      timestamp,
      type: 'stdout',
      chunk,
    }
    yield {
      version: 1,
      jobId: request.jobId,
      sequence: 1,
      timestamp,
      type: 'completed',
      receipt: {
        version: 1,
        jobId: request.jobId,
        nodeId: request.nodeId,
        state: 'completed',
        finishedAt: timestamp,
      },
    }
  }

  getStatus(): Promise<JobStatusV1 | null> {
    return Promise.resolve(null)
  }

  cancel(): Promise<CancelReceiptV1> {
    throw new Error('not used')
  }
}

test('session file base preserves legacy and inherited managed directories', () => {
  const workspace = resolve('workspace')
  const legacy = resolveSessionFileBase(workspace, 'discord:top')
  const inherited = resolveSessionFileBase(workspace, 'subagent:child', {
    sessionId: 'subagent:child',
    workspaceRoot: 'discord:top',
  })

  assert(legacy.available && legacy.locality === 'local')
  assert(inherited.available && inherited.locality === 'local')
  assertEquals(legacy.path, resolve(workspace, 'discord_top'))
  assertEquals(inherited.path, legacy.path)
})

test('session file base returns actionable unavailable capability details', () => {
  const resolution = resolveSessionFileBase(
    resolve('workspace'),
    'discord:top',
    {
      sessionId: 'discord:top',
      workdir: {
        version: 1,
        nodeId: 'child-node',
        capabilityId: 'project-capability',
      },
    },
  )

  assertEquals(resolution.available, false)
  if (resolution.available) return
  assertEquals(workdirUnavailableApiResult('discord:top', resolution), {
    error: 'workdir_unavailable',
    key: 'discord:top',
    nodeId: 'child-node',
    capabilityId: 'project-capability',
    reason: 'node-missing',
    action: 'connect_node',
  })
})

test('workspace path resolution contains relative paths within the resolved base', () => {
  const base = resolve('workspace', 'discord_top')
  assertEquals(
    resolveInWorkspace(base, '/notes/readme.md'),
    resolve(base, 'notes/readme.md'),
  )
  assertEquals(resolveInWorkspace(base, ''), base)
  assertEquals(resolveInWorkspace(base, '../other-session/secret.txt'), null)
  assertNotEquals(resolveInWorkspace(base, 'nested/../safe.txt'), null)
})

test('session file routes dispatch remote listings and previews but not raw bytes', async () => {
  const executor = new RouteFilesystemExecutor()
  const sessions = {
    workspace: resolve('workspace'),
    remoteExecutor: executor,
    workdirCapabilityLookup: () => ({
      node: 'online' as const,
      capability: { kind: 'workdir', online: true },
    }),
    getSessionState: (sessionId: string) => ({
      sessionId,
      workdir: {
        version: 1 as const,
        nodeId: 'child-1',
        capabilityId: 'workdir-1',
      },
    }),
  } as unknown as SessionManager
  const app = new Hono()
  sessionsApiPlugin(sessions)(app)

  const listingResponse = await app.request('/api/sessions/remote/files')
  assertEquals(listingResponse.status, 200)
  assertEquals(await listingResponse.json(), {
    key: 'remote',
    path: '',
    entries: [
      { name: 'folder', type: 'dir', ext: '', size: 0, mtime: null },
      { name: 'a.md', type: 'file', ext: '.md', size: 0, mtime: null },
      { name: 'z.txt', type: 'file', ext: '.txt', size: 0, mtime: null },
    ],
  })

  const previewResponse = await app.request(
    '/api/sessions/remote/preview?path=notes.txt',
  )
  assertEquals(previewResponse.status, 200)
  assertEquals(await previewResponse.json(), {
    key: 'remote',
    path: 'notes.txt',
    binary: false,
    size: 12,
    truncated: false,
    content: 'hello remote',
  })

  const rawResponse = await app.request(
    '/api/sessions/remote/raw?path=notes.txt',
  )
  assertEquals(rawResponse.status, 501)
  assertEquals(executor.requests.length, 2)
})
