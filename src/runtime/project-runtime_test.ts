import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { ConfigSchema } from '../config/schema.ts'
import { startMainRuntime, type MainRuntimeHandle } from '../index.ts'
import type { CloneOperation, ProjectRecord } from '../projects/contracts.ts'
import { createTempWorkspace } from '../testing/workspace.ts'

test('Main serves authorized project creation and restores its session association on restart', async () => {
  const root = await createTempWorkspace()
  const originalCwd = process.cwd()
  const workspace = join(root, 'main')
  const folder = join(root, 'project')
  let runtime: MainRuntimeHandle | undefined
  try {
    await mkdir(workspace)
    await mkdir(folder)
    process.chdir(root)
    await writeFile(join(folder, 'sentinel.txt'), 'project-only-sentinel')
    const reservation = createServer().listen({ host: '127.0.0.1', port: 0 })
    await once(reservation, 'listening')
    const address = reservation.address()
    assert.ok(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => error ? reject(error) : resolve())
    })
    const credential = randomUUID()
    const config = ConfigSchema.parse({
      agent: { workspace, model: 'fixture-model@openai' },
      providers: { openai: { apiKey: 'fixture-not-used', baseUrl: 'http://127.0.0.1:1/v1' } },
      channels: {},
      mcp: {},
    })
    const configPath = join(root, 'bot.config.json')
    await writeFile(configPath, JSON.stringify(config))
    const options = { configPath, gateway: { host: '127.0.0.1', port, launchCredential: credential } }
    runtime = await startMainRuntime(config, options)
    await runtime.ready
    const url = `http://127.0.0.1:${port}`
    const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }
    const request = (path: string, body?: unknown) => fetch(`${url}${path}`, {
      headers,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    })
    const unauthorized = await fetch(`${url}/api/projects/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    })
    assert.equal(unauthorized.status, 401)
    const empty = await request('/api/projects')
    assert.deepEqual(await empty.json(), { projects: [] })
    const opened = await request('/api/projects/register', { path: folder })
    assert.equal(opened.status, 200)
    const { project } = await opened.json() as { project: ProjectRecord }
    assert.equal(project.path.toLowerCase(), folder.toLowerCase())
    const created = await request(`/api/projects/${project.id}/sessions`, {})
    assert.equal(created.status, 200)
    const { sessionId, chatId } = await created.json() as { sessionId: string; chatId: string }
    assert.equal(sessionId, `web:${chatId}`)
    assert.match(chatId, /^chat-/)
    const assertAssociation = async () => {
      const response = await request('/api/sessions/graph')
      assert.equal(response.status, 200)
      const graph = await response.json() as { sessions: { sessionId: string; projectId?: string }[] }
      assert.equal(graph.sessions.find((session) => session.sessionId === sessionId)?.projectId, project.id)
      const base = `/api/sessions/${encodeURIComponent(sessionId)}`
      const context = await request(`${base}/context`)
      assert.equal(context.status, 200)
      const { systemPrompt } = await context.json() as { systemPrompt: string }
      assert.ok(systemPrompt.includes(`**Workspace root (this session)**: \`${project.path}\``))
      const files = await request(`${base}/files`)
      assert.equal(files.status, 200)
      assert.ok((await files.text()).includes('sentinel.txt'))
      const preview = await request(`${base}/preview?path=sentinel.txt`)
      assert.equal(preview.status, 200)
      assert.ok((await preview.text()).includes('project-only-sentinel'))
    }
    await assertAssociation()
    const git = promisify(execFile)
    await git('git', ['init', '--quiet', folder])
    await git('git', ['-C', folder, 'add', 'sentinel.txt'])
    await git('git', [
      '-C', folder, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'no-hooks')}`,
      'commit', '--quiet', '-m', 'fixture',
    ])
    const operationId = randomUUID()
    const clone = await request('/api/projects/clone', {
      operationId, url: pathToFileURL(folder).href, parentPath: root, directoryName: 'cloned',
    })
    assert.equal(clone.status, 202)
    let operation = (await clone.json() as { operation: CloneOperation }).operation
    for (let attempt = 0; attempt < 400 && operation.state === 'running'; attempt++) {
      await setTimeout(20)
      const status = await request(`/api/projects/clone/${operationId}`)
      assert.equal(status.status, 200)
      operation = (await status.json() as { operation: CloneOperation }).operation
    }
    assert.equal(operation.state, 'succeeded', operation.error)
    assert.ok(operation.project)
    await runtime.shutdown()
    await runtime.finished
    runtime = await startMainRuntime(config, options)
    await runtime.ready
    assert.deepEqual(await (await request('/api/projects')).json(), { projects: [project, operation.project] })
    await assertAssociation()
    const reopened = await request('/api/projects/register', { path: folder })
    assert.deepEqual(await reopened.json(), { project })
  } finally {
    await runtime?.shutdown()
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})
