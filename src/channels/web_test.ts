import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import { Hono } from 'hono'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import { WebChannel } from './web.ts'

async function createWebApp(
  workspace: string,
  getSessionState: (sessionId: string) => unknown = () => null,
) {
  const app = new Hono()
  const sessionManager = {
    getSessionState,
  } as unknown as SessionManager
  const channel = new WebChannel(new Bus(), { workspace, sessionManager })
  await channel.start(app)
  return { app, channel }
}

test('web media serves an upload only for its chat session', async () => {
  const workspace = await createTempWorkspace()
  const { app, channel } = await createWebApp(
    workspace,
    (sessionId) =>
      sessionId === 'web:chat-a'
        ? { sessionId, workspaceRoot: 'web:owner' }
        : null,
  )
  try {
    const form = new FormData()
    form.set('chatId', 'chat-a')
    form.set('file', new File(['session image'], 'image.txt'))

    const upload = await app.request('/api/chat/upload', {
      method: 'POST',
      body: form,
    })
    assertEquals(upload.status, 200)
    const uploaded = await upload.json() as { path: string }

    const served = await app.request(
      `/api/media?chatId=chat-a&path=${encodeURIComponent(uploaded.path)}`,
    )
    assertEquals(served.status, 200)
    assertEquals(await served.text(), 'session image')

    const otherSession = await app.request(
      `/api/media?chatId=chat-b&path=${encodeURIComponent(uploaded.path)}`,
    )
    assertEquals(otherSession.status, 404)
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})

test('web media rejects missing identity, absolute paths, and traversal without path leaks', async () => {
  const workspace = await createTempWorkspace()
  const outside = join(workspace, 'outside.txt')
  await writeFile(outside, 'outside')
  const { app, channel } = await createWebApp(workspace)
  try {
    const requests = [
      `/api/media?path=${encodeURIComponent('uploads/file.txt')}`,
      `/api/media?chatId=chat-a&path=${encodeURIComponent(outside)}`,
      `/api/media?chatId=chat-a&path=${encodeURIComponent('../outside.txt')}`,
    ]

    for (const request of requests) {
      const response = await app.request(request)
      assertEquals(response.status, request.includes('chatId=') ? 404 : 400)
      const body = await response.text()
      assertEquals(body.includes(workspace), false)
      assertEquals(body.includes(outside), false)
      assert(body.includes('error'))
    }
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})

test('web media rejects links that escape the session workdir', async () => {
  const workspace = await createTempWorkspace()
  const sessionRoot = sessionWorkspacePath(workspace, 'web:chat-a')
  const outsideDir = join(workspace, 'outside')
  await mkdir(sessionRoot, { recursive: true })
  await mkdir(outsideDir)
  await writeFile(join(outsideDir, 'secret.txt'), 'outside')
  await symlink(
    outsideDir,
    join(sessionRoot, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  const { app, channel } = await createWebApp(workspace)
  try {
    const response = await app.request(
      '/api/media?chatId=chat-a&path=linked%2Fsecret.txt',
    )
    assertEquals(response.status, 404)
    const body = await response.text()
    assertEquals(body.includes(workspace), false)
    assertEquals(body.includes(outsideDir), false)
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})
