import assert, { deepEqual as assertEquals, notDeepEqual as assertNotEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { folderFixture } from '../folders/test-fixtures.ts'
import { FolderError } from '../folders/registry.ts'
import type { SessionState } from './session-store.ts'
import { LEARNING_AUTOMATIONS } from '../cron/contracts.ts'
import { Hono } from 'hono'
import { channelSessionId } from '../bus/events.ts'
import type {
  CancelReceiptV1,
  JobEventV1,
  JobRequestV1,
  JobStatusV1,
} from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import type { SessionManager } from './session-manager.ts'
import { resolveInWorkspace } from '../execution/filesystem/local-files.ts'
import {
  resolveSessionFileBase,
  sessionsApiPlugin,
  workdirUnavailableApiResult,
} from './routes.ts'

class RouteFilesystemExecutor implements Executor {
  readonly requests: JobRequestV1[] = []

  async *execute(request: JobRequestV1): AsyncIterable<JobEventV1> {
    this.requests.push(request)
    const path = (request.args as { path: string }).path
    const chunk = request.operation === 'filesystem.read' && 'query' in (request.args as object)
      ? JSON.stringify({ paths: ['folder/notes.md'], truncated: false })
      : request.operation === 'workdir.git.status'
      ? JSON.stringify({ status: 200, body: { available: true, entries: [{ path: 'a.md', status: 'modified' }] } })
      : request.operation === 'workdir.git.diff'
      ? JSON.stringify({ status: 200, body: { path, status: 'modified', base: 'HEAD', binary: false, truncated: false, hunks: [] } })
      : path === '.' ? 'z.txt\nfolder/\na.md' : 'hello remote'
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

test('file and Git routes distinguish offline nodes from unavailable capabilities without Main fallback', async () => {
  const executor = new RouteFilesystemExecutor()
  let node: 'online' | 'offline' | 'missing' | 'revoked' = 'offline'
  let capability: { kind: string; online: boolean } | undefined = { kind: 'workdir', online: true }
  const app = new Hono()
  sessionsApiPlugin({
    workspace: 'C:\\synthetic-main-must-not-be-read',
    remoteExecutor: executor,
    getSessionState: () => ({ sessionId: 'remote', workdir: { version: 1, nodeId: 'child', capabilityId: 'folder' } }),
    workdirCapabilityLookup: () => ({ node, capability }),
  } as unknown as SessionManager)(app)
  for (const [state, folder, reason] of [
    ['offline', capability, 'node-offline'],
    ['missing', capability, 'node-missing'],
    ['revoked', capability, 'capability-revoked'],
    ['online', undefined, 'capability-missing'],
    ['online', { kind: 'workdir', online: false }, 'capability-offline'],
    ['online', { kind: 'shell', online: true }, 'incompatible'],
  ] as const) {
    node = state
    capability = folder
    for (const suffix of ['files', 'files/search?query=notes', 'files?path=child', 'preview?path=notes.txt', 'raw?path=notes.txt', 'git/status', 'git/diff?path=notes.txt']) {
      const response = await app.request(`/api/sessions/remote/${suffix}`)
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), workdirUnavailableApiResult('remote', {
        available: false, workdir: { version: 1, nodeId: 'child', capabilityId: 'folder' }, reason,
      }))
    }
  }
  assert.equal(executor.requests.length, 0)
  node = 'online'
  capability = { kind: 'workdir', online: true }
  assert.equal((await app.request('/api/sessions/remote/files')).status, 200)
  assert.equal((await app.request('/api/sessions/remote/git/status')).status, 200)
  assert.equal(executor.requests.length, 2)
})

test('cancel route requires an existing authorized logical session and distinguishes idle from requested', async () => {
  let cancellations = 0
  let phase = 'idle'
  const key = 'web:chat-cancel'
  const app = new Hono()
  sessionsApiPlugin({
    projectId: 'owned-org',
    getSessionState: (id: string) => id === key ? { sessionId: key } : undefined,
    getActiveSession: () => ({ get phase() { return phase }, activeRequestId: 'current-request', cancel: () => { cancellations++ } }),
  } as unknown as SessionManager)(app)
  const endpoint = `/api/sessions/${encodeURIComponent(key)}/cancel`
  assert.deepEqual(await (await app.request(endpoint, { method: 'POST' })).json(), { sessionId: key, status: 'idle' })
  assert.equal(cancellations, 0)
  phase = 'tool'
  assert.deepEqual(await (await app.request(endpoint, { method: 'POST' })).json(), { sessionId: key, status: 'requested' })
  assert.equal(cancellations, 1)
  const stale = await app.request(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'previous-request' }),
  })
  assert.equal(stale.status, 409)
  assert.equal(cancellations, 1)
  const targeted = await app.request(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'current-request' }),
  })
  assert.equal(targeted.status, 200)
  assert.equal(cancellations, 2)
  for (const invalid of ['{', 'null', '{"requestId":""}', '{"sessionId":"other"}']) {
    assert.equal((await app.request(endpoint, { method: 'POST', body: invalid })).status, 400)
  }
  for (const unknown of ['web:other-org', key + '__0']) {
    assert.equal((await app.request(`/api/sessions/${encodeURIComponent(unknown)}/cancel`, { method: 'POST' })).status, 404)
  }
  assert.equal(cancellations, 2)
  const missing = new Hono()
  sessionsApiPlugin(undefined)(missing)
  assert.equal((await missing.request(endpoint, { method: 'POST' })).status, 501)
  const denied = new Hono()
  sessionsApiPlugin({
    getSessionState: () => ({ sessionId: key }),
    assertFolderAccess: () => { throw new FolderError('folder_unavailable', 'Folder unavailable', 409) },
    getActiveSession: () => { throw new Error('Must not reach active session after access denial') },
  } as unknown as SessionManager)(denied)
  assert.equal((await denied.request(endpoint, { method: 'POST' })).status, 409)
})

test('session route parameters retain encoded bot components without a second decoding pass', async t => {
  const { workspace } = await folderFixture(t)
  const id = channelSessionId({
    projectId: 'org', botInstanceId: 'bot', platform: 'qq', conversationId: 'room:part%/child',
  })
  const state: SessionState = { sessionId: id, segmentIndex: 0, projectId: 'org' }
  const seen: string[] = []
  const manager = {
    workspace,
    getSessionState: (key: string) => { seen.push(key); return key === id ? state : null },
    getSessionDetails: async (key: string) => { seen.push(key); return key === id ? { sessionId: id } : null },
    getContext: async ({ sessionId }: { sessionId: string }) => {
      seen.push(sessionId)
      return sessionId === id ? { systemPrompt: 'owned context', tools: [] } : null
    },
    applySessionConfigPatch: async (key: string) => { seen.push(key) },
    getSessionConfig: (key: string) => { seen.push(key); return { model: 'fixture' } },
  }
  const app = new Hono()
  sessionsApiPlugin(manager as unknown as SessionManager)(app)
  const base = `/api/sessions/${encodeURIComponent(id)}`
  for (const suffix of ['/details', '/context']) {
    assert.equal((await app.request(base + suffix)).status, 200)
  }
  assert.equal((await app.request(base + '/config', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"model":"fixture"}',
  })).status, 200)
  assert(seen.length > 0)
  assert(seen.every(key => key === id))
})

test('coordinator and learning automation browsing use Home without changing execution cwd', async t => {
  const { workspace, root } = await folderFixture(t)
  execFileSync('git', ['init', '--quiet', workspace])
  await writeFile(join(workspace, 'home.txt'), 'from Home\n')
  await writeFile(join(workspace, 'image.png'), new Uint8Array([1, 2, 3]))
  await mkdir(join(workspace, 'page'))
  await writeFile(join(workspace, 'page', 'index.html'), '<h1>Home</h1>')
  await writeFile(join(root, 'outside.txt'), 'outside Home')
  const folder = join(root, 'folder')
  await mkdir(folder)
  await writeFile(join(folder, 'folder.txt'), 'from effective folder\n')
  const folderWorkdir = { version: 1 as const, nodeId: 'local', capabilityId: 'fixture-folder' }
  const states: Record<string, SessionState> = {
    'web:orchestrator': { sessionId: 'web:orchestrator', segmentIndex: 0, sessionKind: 'orchestrator', mode: 'session', parentSessionId: null },
    'web:coordinator-topic': {
      sessionId: 'web:coordinator-topic', segmentIndex: 0, mode: 'session', sessionKind: 'topic',
      parentSessionId: null, createdBySessionId: 'web:orchestrator', parent: { id: 'web:orchestrator' },
    },
    'web:legacy-child': { sessionId: 'web:legacy-child', segmentIndex: 0, parent: { id: 'heartbeat:reflector-1750000000000' } },
    'web:task-child': { sessionId: 'web:task-child', segmentIndex: 0, parentSessionId: 'cron:fresh-encapsulator' },
    'web:chat-grandchild': { sessionId: 'web:chat-grandchild', segmentIndex: 0, parentSessionId: 'web:task-child' },
    'web:chat-normal': { sessionId: 'web:chat-normal', segmentIndex: 0, description: 'Reflect: ordinary conversation' },
    'heartbeat:reflector-fixture': { sessionId: 'heartbeat:reflector-fixture', segmentIndex: 0 },
    'web:cycle': { sessionId: 'web:cycle', segmentIndex: 0, parent: { id: 'web:cycle' } },
    'cron:generic': {
      sessionId: 'cron:generic', segmentIndex: 0, agentType: 'reflector', workdir: folderWorkdir,
      parentSessionId: 'cron:fresh-reflector',
      automation: {
        jobId: 'user-job', name: 'Self reflection', runId: 'generic', startedAt: '2026-01-01T00:00:00Z', contextMode: 'fresh',
        config: { source: 'cron', schedule: 'every 1h', agentType: 'reflector' },
      },
    },
    'web:generic-child': { sessionId: 'web:generic-child', segmentIndex: 0, parentSessionId: 'cron:generic', workdir: folderWorkdir },
  }
  const homeIds = ['web:orchestrator', 'web:legacy-child', 'web:task-child', 'web:chat-grandchild']
  for (const job of Object.values(LEARNING_AUTOMATIONS)) {
    const legacyId = `heartbeat:${job.agentType}-1750000000000`
    const freshId = `cron:fresh-${job.agentType}`
    states[legacyId] = { sessionId: legacyId, segmentIndex: 0, agentType: job.agentType }
    states[freshId] = {
      sessionId: freshId, segmentIndex: 0, agentType: job.agentType, mode: 'task',
      automationVersion: 1, parentSessionId: null,
      automation: {
        jobId: job.id, name: job.name, runId: freshId, startedAt: '2026-01-01T00:00:00Z', contextMode: 'fresh',
        config: { source: 'learning', schedule: 'every 1h', agentType: job.agentType },
      },
    }
    homeIds.push(legacyId, freshId)
  }
  const original = structuredClone(states)
  const app = new Hono()
  const manager = {
    workspace, getSessionState: (id: string) => states[id] ?? null,
    workdirCapabilityLookup: (ref: { capabilityId: string }) => ref.capabilityId === 'fixture-folder'
      ? { node: 'online', capability: { kind: 'workdir', online: true, path: folder } } : { node: 'missing' },
  }
  sessionsApiPlugin(manager as unknown as SessionManager)(app)
  for (const id of homeIds) {
    const base = `/api/sessions/${encodeURIComponent(id)}`
    const listing = await (await app.request(`${base}/files`)).json()
    assertEquals(listing.workdir, { kind: 'local', displayPath: workspace, scope: 'home' })
    assert(listing.entries.some((entry: { name: string }) => entry.name === 'home.txt'))
    const preview = await (await app.request(`${base}/preview?path=home.txt`)).json()
    assertEquals(preview.content, 'from Home\n')
    assertEquals(preview.sourcePath, join(workspace, 'home.txt'))
    assertEquals(await (await app.request(`${base}/raw?path=home.txt`)).text(), 'from Home\n')
    const image = await app.request(`${base}/raw?path=image.png`)
    assertEquals(image.status, 200)
    assertEquals(decodeURIComponent(image.headers.get('x-shadow-source-path')!), join(workspace, 'image.png'))
    assertEquals(new Uint8Array(await image.arrayBuffer()), new Uint8Array([1, 2, 3]))
    assertEquals(await (await app.request(`${base}/static/page/index.html`)).text(), '<h1>Home</h1>')
    const status = await (await app.request(`${base}/git/status`)).json()
    assertEquals(status.available, true)
    assert(status.entries.some((entry: { path: string }) => entry.path === 'home.txt'))
    const diff = await (await app.request(`${base}/git/diff?path=home.txt`)).json()
    assertEquals(diff.sourcePath, join(workspace, 'home.txt'))
    assert(diff.hunks.some((hunk: { lines: string[] }) => hunk.lines.includes('+from Home')))
    for (const route of ['files', 'preview', 'raw', 'git/diff']) {
      assertEquals((await app.request(`${base}/${route}?path=../outside.txt`)).status, 400)
    }
    const execution = resolveSessionFileBase(workspace, id, states[id])
    assert(execution.available && execution.locality === 'local')
    assertNotEquals(execution.path, workspace)
  }
  for (const id of ['web:coordinator-topic', 'web:chat-normal', 'heartbeat:reflector-fixture', 'web:cycle', 'heartbeat:reflector-missing']) {
    assertEquals((await app.request(`/api/sessions/${encodeURIComponent(id)}/preview?path=home.txt`)).status, 404)
  }
  for (const id of ['cron:generic', 'web:generic-child']) {
    const base = `/api/sessions/${encodeURIComponent(id)}`
    const listing = await (await app.request(`${base}/files`)).json()
    assertEquals(listing.workdir, { kind: 'local', displayPath: folder })
    const preview = await (await app.request(`${base}/preview?path=folder.txt`)).json()
    assertEquals(preview.content, 'from effective folder\n')
    assertEquals(preview.sourcePath, undefined)
    assertEquals((await app.request(`${base}/preview?path=home.txt`)).status, 404)
  }
  assertEquals(states, original)
  states['cron:fresh-reflector']!.workdir = { version: 1, nodeId: 'child', capabilityId: 'remote-workdir' }
  assertEquals((await app.request('/api/sessions/cron%3Afresh-reflector/files')).status, 503)
  const remoteApp = new Hono()
  sessionsApiPlugin({
    ...manager,
    workdirCapabilityLookup: () => ({ node: 'online', capability: { kind: 'workdir', online: true } }),
  } as unknown as SessionManager)(remoteApp)
  assertEquals((await remoteApp.request('/api/sessions/cron%3Afresh-reflector/files')).status, 501)
  assertEquals(await (await remoteApp.request('/api/sessions/cron%3Afresh-reflector/git/status')).json(),
    { available: false, reason: 'remote_unsupported', entries: [] })
})

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
        capabilityId: 'folder-capability',
      },
    },
  )

  assertEquals(resolution.available, false)
  if (resolution.available) return
  assertEquals(workdirUnavailableApiResult('discord:top', resolution), {
    error: 'workdir_unavailable',
    key: 'discord:top',
    nodeId: 'child-node',
    capabilityId: 'folder-capability',
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
    getNodeInventory: () => ({
      nodes: [{ nodeId: 'child-1', capabilities: [{ capabilityId: 'workdir-1', kind: 'workdir', displayPath: '/srv/folder' }] }],
    }),
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
        displayPathSnapshot: '/untrusted-old-snapshot',
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
    workdir: { kind: 'remote', displayPath: '/srv/folder' },
    entries: [
      { name: 'folder', type: 'dir', ext: '', size: 0, mtime: null },
      { name: 'a.md', type: 'file', ext: '.md', size: 0, mtime: null },
      { name: 'z.txt', type: 'file', ext: '.txt', size: 0, mtime: null },
    ],
  })
  const searchResponse = await app.request('/api/sessions/remote/files/search?query=notes')
  assertEquals(searchResponse.status, 200)
  assertEquals(await searchResponse.json(), { paths: ['folder/notes.md'], truncated: false })
  assertEquals(executor.requests.at(-1)?.args, { path: '.', query: 'notes' })
  assertEquals((await app.request('/api/sessions/remote/files/search?query=')).status, 400)

  const previewResponse = await app.request(
    '/api/sessions/remote/preview?path=notes.txt',
  )
  assertEquals(previewResponse.status, 200)
  assertEquals(await previewResponse.json(), {
    key: 'remote',
    path: 'notes.txt',
    binary: false,
    encoding: 'utf-8',
    size: 12,
    truncated: false,
    content: 'hello remote',
  })

  const rawResponse = await app.request(
    '/api/sessions/remote/raw?path=notes.txt',
  )
  assertEquals(rawResponse.status, 501)
  const encoded = await app.request('/api/sessions/remote/preview?path=notes.txt&encoding=shift_jis')
  assertEquals(encoded.status, 501)
  assertEquals(await encoded.json(), { error: 'remote_encoding_unavailable' })
  assertEquals((await app.request('/api/sessions/remote/preview?path=notes.txt&encoding=invalid')).status, 400)
  assertEquals(executor.requests.length, 3)
  const gitStatus = await remoteGitRequest('status')
  assertEquals(gitStatus, { available: true, entries: [{ path: 'a.md', status: 'modified' }] })
  assertEquals((await remoteGitRequest('diff?path=a.md')).path, 'a.md')
  assertEquals(executor.requests.slice(-2).map(request => [request.nodeId, request.capabilityId, request.operation]),
    [['child-1', 'workdir-1', 'workdir.git.status'], ['child-1', 'workdir-1', 'workdir.git.diff']])
  async function remoteGitRequest(operation: string) {
    const response = await app.request(`/api/sessions/remote/git/${operation}`)
    assertEquals(response.status, 200)
    return response.json()
  }
  sessions.getNodeInventory = () => undefined
  const withoutMetadata = await (await app.request('/api/sessions/remote/files')).json()
  assertEquals(withoutMetadata.workdir.displayPath, null)
})
