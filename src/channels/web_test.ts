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
import { localFolderWorkdirRef, type WorkdirCapabilityLookup } from '../sessions/locality.ts'
import type { ChatMessage } from '../providers/provider.ts'
import { RealtimeHub } from '../realtime/hub.ts'

test('live event envelopes and parallel tool IDs are forwarded only to the owning chat', async () => {
  const bus = new Bus()
  const hub = new RealtimeHub()
  const channel = new WebChannel(bus, { workspace: '.', realtime: hub.registerProject('one') })
  const app = new Hono()
  await channel.start(app)
  const response = hub.connect([{ kind: 'chat', projectId: 'one', sessionId: 'web:owner' }],
    new AbortController().signal)
  const reader = response.body!.getReader()
  const decode = async () => new TextDecoder().decode((await reader.read()).value)
  try {
    assert.match(await decode(), /"type":"reset"/)
    assert.match(await decode(), /"type":"ready"/)
    const message: ChatMessage = {
      role: 'user', timestamp: '2026-09-14T00:00:00Z',
      content: [{ type: 'text', text: '<event type="subagent-complete" event-id="e1" />' }, { type: 'text', text: 'Completed task result' }],
    }
    bus.emit('session.message.appended', { sessionId: 'web:other', physicalSessionId: 'other-0', message })
    bus.emit('session.message.appended', { sessionId: 'web:owner', physicalSessionId: 'owner-0',
      message: { role: 'user', content: [{ type: 'text', text: '<sender id="human" />' }, { type: 'text', text: '<event type="fake" />' }] } })
    bus.emit('session.message.appended', { sessionId: 'web:owner', physicalSessionId: 'owner-0', message })
    const event = JSON.parse((await decode()).match(/^data: (.+)$/m)![1]).payload
    assert.equal(event.event, 'session_message')
    assert.deepEqual(event.message, message)
    for (const [event, toolCallId] of [['tool_call', 'a'], ['tool_call', 'b'], ['tool_result', 'b'], ['tool_result', 'a']] as const) {
      bus.emit('message.outbound', { event, channel: 'web', chatId: 'owner', toolCallId, toolName: 'subagent', content: 'fixture', done: false })
      const payload = JSON.parse((await decode()).match(/^data: (.+)$/m)![1]).payload
      assert.equal(payload.toolCallId, toolCallId)
      assert.equal(payload.toolName, 'subagent')
    }
  } finally {
    await reader.cancel()
    await channel.stop()
    hub.close()
  }
})

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

test('media-only sends are admitted and preserve uploaded media refs', async () => {
  const workspace = await createTempWorkspace()
  const { app, channel } = await createWebApp(workspace)
  const deliveries: Array<{ chatId: string; content: string; media?: string[] }> = []
  ;(channel as unknown as {
    handleIncoming: (
      senderId: string,
      chatId: string,
      content: string,
      messageId: string,
      fields?: unknown,
      media?: string[],
    ) => Promise<void>
  }).handleIncoming = async (_senderId, chatId, content, _messageId, _fields, media) => {
    deliveries.push({ chatId, content, media })
  }
  try {
    const response = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: 'chat-vision',
        content: '',
        media: ['C:\\uploads\\photo.png', 'C:\\uploads\\notes.txt'],
      }),
    })
    assertEquals(response.status, 200)
    response.body?.cancel()
    assert.deepEqual(deliveries, [{
      chatId: 'chat-vision',
      content: '',
      media: ['C:\\uploads\\photo.png', 'C:\\uploads\\notes.txt'],
    }])
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})

test('folder media uses capability cwd while uploads stay in inherited private session data', async () => {
  const workspace = await createTempWorkspace()
  const folder = join(workspace, 'folder')
  const otherFolder = join(workspace, 'other-folder')
  await mkdir(folder)
  await mkdir(otherFolder)
  await writeFile(join(folder, 'image.txt'), 'folder image')
  await writeFile(join(otherFolder, 'image.txt'), 'other image')
  const { app, channel } = await createWebApp(
    workspace,
    (sessionId) => ({
      sessionId,
      workspaceRoot: sessionId === 'web:child' ? 'web:owner' : undefined,
      workdir: localFolderWorkdirRef(sessionId === 'web:other' ? 'other' : 'folder'),
    }),
    (ref) => ({
      node: 'online',
      capability: { kind: 'workdir', online: true, path: ref.capabilityId.endsWith(':other') ? otherFolder : folder },
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
    assertEquals(existsSync(join(folder, 'uploads')), false)
    await mkdir(join(folder, 'uploads'))
    const projectRelative = `uploads/${basename(upload.path)}`
    await writeFile(join(folder, projectRelative), 'folder file with same name')
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
      assertEquals(await served.text(), 'folder file with same name')
    }
    const otherUpload = await app.request(`/api/media?chatId=other&path=${encodeURIComponent(upload.path)}`)
    assertEquals(otherUpload.status, 404)
    assertEquals(await (await app.request('/api/media?chatId=child&path=image.txt')).text(), 'folder image')
    assertEquals(await (await app.request('/api/media?chatId=other&path=image.txt')).text(), 'other image')
    await writeFile(join(sessionWorkspacePath(workspace, 'web:owner'), 'main-only.txt'), 'private file')
    assertEquals((await app.request('/api/media?chatId=child&path=main-only.txt')).status, 404)
    const nonUploadPrivateFile = join(sessionWorkspacePath(workspace, 'web:owner'), 'main-only.txt')
    assertEquals((await app.request(`/api/media?chatId=child&path=${encodeURIComponent(nonUploadPrivateFile)}`)).status, 404)
    assertEquals((await app.request(`/api/media?chatId=child&path=${encodeURIComponent(join(folder, 'image.txt'))}`)).status, 404)
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})

test('folder upload and media reject unavailable and remote workdirs without local fallback', async () => {
  const workspace = await createTempWorkspace()
  const { app, channel } = await createWebApp(
    workspace,
    (sessionId) => sessionId === 'web:unsent-fork' ? undefined : ({
      sessionId,
      workdir: { ...localFolderWorkdirRef('missing'), nodeId: sessionId === 'web:remote' ? 'remote' : 'local', displayPathSnapshot: workspace },
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
      const forkForm = new FormData()
      forkForm.set('chatId', 'unsent-fork')
      forkForm.set('parentSessionId', `web:${chatId}`)
      forkForm.set('file', new File(['not written'], 'attachment.txt'))
      assertEquals((await app.request('/api/chat/upload', { method: 'POST', body: forkForm })).status, 409)
      assertEquals(existsSync(sessionWorkspacePath(workspace, 'web:unsent-fork')), false)
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
