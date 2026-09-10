import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createTempWorkspace } from '../testing/workspace.ts'
import { Hono } from 'hono'
import { basename, isAbsolute, join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import { WebChannel } from './web.ts'
import { localProjectWorkdirRef, type WorkdirCapabilityLookup } from '../sessions/locality.ts'

async function createWebApp(
  workspace: string,
  getSessionState: (sessionId: string) => unknown = () => null,
  workdirCapabilityLookup?: WorkdirCapabilityLookup,
) {
  const app = new Hono()
  const sessionManager = {
    getSessionState,
    workdirCapabilityLookup,
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
    const legacyRelative = await app.request(
      `/api/media?chatId=chat-a&path=${encodeURIComponent(`uploads/${basename(uploaded.path)}`)}`,
    )
    assertEquals(legacyRelative.status, 200)
    assertEquals(await legacyRelative.text(), 'session image')

    const otherSession = await app.request(
      `/api/media?chatId=chat-b&path=${encodeURIComponent(uploaded.path)}`,
    )
    assertEquals(otherSession.status, 404)
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})

test('project media uses capability cwd while uploads stay in inherited private session data', async () => {
  const workspace = await createTempWorkspace()
  const project = join(workspace, 'project')
  const otherProject = join(workspace, 'other-project')
  await mkdir(project)
  await mkdir(otherProject)
  await writeFile(join(project, 'image.txt'), 'project image')
  await writeFile(join(otherProject, 'image.txt'), 'other image')
  const { app, channel } = await createWebApp(
    workspace,
    (sessionId) => ({
      sessionId,
      workspaceRoot: sessionId === 'web:child' ? 'web:owner' : undefined,
      workdir: localProjectWorkdirRef(sessionId === 'web:other' ? 'other' : 'project'),
    }),
    (ref) => ({
      node: 'online',
      capability: { kind: 'workdir', online: true, path: ref.capabilityId.endsWith(':other') ? otherProject : project },
    }),
  )
  try {
    const form = new FormData()
    form.set('chatId', 'child')
    form.set('file', new File(['private upload'], 'attachment.txt'))
    const response = await app.request('/api/chat/upload', { method: 'POST', body: form })
    assertEquals(response.status, 200)
    const upload = await response.json() as { path: string }
    assert(isAbsolute(upload.path))
    assertEquals(upload.path, join(sessionWorkspacePath(workspace, 'web:owner'), 'uploads', basename(upload.path)))
    assertEquals(await readFile(upload.path, 'utf8'), 'private upload')
    assertEquals(existsSync(join(project, 'uploads')), false)
    await mkdir(join(project, 'uploads'))
    const projectRelative = `uploads/${basename(upload.path)}`
    await writeFile(join(project, projectRelative), 'project file with same name')
    for (const url of [
      `/api/media?chatId=child&path=${encodeURIComponent(upload.path)}`,
      `/api/chat/uploads/${basename(upload.path)}?chatId=child`,
    ]) {
      const served = await app.request(url)
      assertEquals(served.status, 200)
      assertEquals(await served.text(), 'private upload')
    }
    for (const path of [projectRelative, `./${projectRelative}`]) {
      const served = await app.request(`/api/media?chatId=child&path=${encodeURIComponent(path)}`)
      assertEquals(served.status, 200)
      assertEquals(await served.text(), 'project file with same name')
    }
    const otherUpload = await app.request(`/api/media?chatId=other&path=${encodeURIComponent(upload.path)}`)
    assertEquals(otherUpload.status, 404)
    assertEquals(await (await app.request('/api/media?chatId=child&path=image.txt')).text(), 'project image')
    assertEquals(await (await app.request('/api/media?chatId=other&path=image.txt')).text(), 'other image')
    await writeFile(join(sessionWorkspacePath(workspace, 'web:owner'), 'main-only.txt'), 'private file')
    assertEquals((await app.request('/api/media?chatId=child&path=main-only.txt')).status, 404)
    const nonUploadPrivateFile = join(sessionWorkspacePath(workspace, 'web:owner'), 'main-only.txt')
    assertEquals((await app.request(`/api/media?chatId=child&path=${encodeURIComponent(nonUploadPrivateFile)}`)).status, 404)
    assertEquals((await app.request(`/api/media?chatId=child&path=${encodeURIComponent(join(project, 'image.txt'))}`)).status, 404)
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})

test('project upload and media reject unavailable and remote workdirs without local fallback', async () => {
  const workspace = await createTempWorkspace()
  const { app, channel } = await createWebApp(
    workspace,
    (sessionId) => ({
      sessionId,
      workdir: { ...localProjectWorkdirRef('missing'), nodeId: sessionId === 'web:remote' ? 'remote' : 'local', displayPathSnapshot: workspace },
    }),
    (ref) => ({
      node: 'online',
      capability: { kind: 'workdir', online: ref.nodeId === 'remote', path: workspace },
    }),
  )
  try {
    for (const chatId of ['missing', 'remote']) {
      const form = new FormData()
      form.set('chatId', chatId)
      form.set('file', new File(['not written'], 'attachment.txt'))
      assertEquals((await app.request('/api/chat/upload', { method: 'POST', body: form })).status, 409)
      assertEquals((await app.request(`/api/media?chatId=${chatId}&path=file.txt`)).status, 404)
      assertEquals(existsSync(sessionWorkspacePath(workspace, `web:${chatId}`)), false)
    }
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
  await mkdir(join(sessionRoot, 'uploads'))
  await mkdir(outsideDir)
  await writeFile(join(outsideDir, 'secret.txt'), 'outside')
  await symlink(
    outsideDir,
    join(sessionRoot, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await symlink(
    outsideDir,
    join(sessionRoot, 'uploads', 'linked'),
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
    const privateEscape = join(sessionRoot, 'uploads', 'linked', 'secret.txt')
    assertEquals((await app.request(`/api/media?chatId=chat-a&path=${encodeURIComponent(privateEscape)}`)).status, 404)
    assertEquals((await app.request('/api/chat/uploads/linked/secret.txt?chatId=chat-a')).status, 404)
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})
