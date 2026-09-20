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
import { FolderError } from '../folders/registry.ts'
import { registerGatewayRoutes } from '../gateway/server.ts'
import { MessageTool } from '../tools/message.ts'
import { buildUserChatMessage } from '../agent/message-builder.ts'
import { SessionTools, Tools } from '../tools/registry.ts'

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

test('peer progress is projected once with its persisted author envelope, not as assistant stream text', async () => {
  const bus = new Bus()
  const hub = new RealtimeHub()
  const channel = new WebChannel(bus, { workspace: '.', realtime: hub.registerProject('one') })
  const reader = hub.connect([{ kind: 'chat', projectId: 'one', sessionId: 'web:owner' }],
    new AbortController().signal).body!.getReader()
  const decode = async () => new TextDecoder().decode((await reader.read()).value)
  let persisted: ChatMessage | undefined
  const tool = new MessageTool(bus, () => true, () => undefined, () => [], async (sessionId, input) => {
    assert.equal(input.kind, 'message')
    if (input.kind !== 'message') throw new Error('Expected peer message')
    persisted = await buildUserChatMessage(input, '.', '.')
    bus.emit('session.message.appended', { sessionId, physicalSessionId: 'owner-0', message: persisted })
    return { status: 'accepted', sessionId, inputId: input.id }
  })
  try {
    await decode()
    await decode()
    await tool.execute({ sessionId: 'web:owner', content: '**Initial** progress', intent: 'progress', silent: true }, {
      sessionId: 'web:peer', physicalSessionId: 'peer-0', messageId: 'cause',
      channel: 'web', chatId: 'peer', senderId: 'fixture', senderName: 'A & B',
      signal: new AbortController().signal,
      tools: new SessionTools(new Tools('.'), '.'),
    })
    const payload = JSON.parse((await decode()).match(/^data: (.+)$/m)![1]).payload
    assert.equal(payload.event, 'session_message')
    assert.deepEqual(payload.message.content, persisted!.content)
    assert.equal(payload.message.role, 'user')
    assert.equal(payload.message.name, 'A & B')
    assert.ok(Number.isFinite(Date.parse(payload.message.timestamp)))
    bus.emit('message.outbound', { channel: 'web', chatId: 'owner', event: 'response', content: 'Actual reply', done: true })
    const next = JSON.parse((await decode()).match(/^data: (.+)$/m)![1]).payload
    assert.equal(next.event, 'response')
    assert.equal(next.content, 'Actual reply', 'No duplicate peer message or untyped stream chunk precedes the real reply')
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

test('SNS logical session media uses inherited private uploads, not capability workdirs or other sessions', async () => {
  const workspace = await createTempWorkspace()
  const sessionId = 'bot:project-a:bot-a:qq:group%3A123'
  const owner = sessionWorkspacePath(workspace, 'qq:owner')
  const sibling = sessionWorkspacePath(workspace, 'qq:sibling')
  const folder = join(workspace, 'folder')
  for (const root of [owner, sibling, folder]) await mkdir(join(root, 'uploads'), { recursive: true })
  await writeFile(join(owner, 'uploads', '视频.mp4'), '0123456789')
  await writeFile(join(owner, 'private.txt'), 'not an upload')
  await writeFile(join(sibling, 'uploads', 'other.mp4'), 'other session')
  await writeFile(join(folder, 'uploads', '视频.mp4'), 'workdir decoy')
  await writeFile(join(folder, 'workdir.txt'), 'workdir file')
  const { app, channel } = await createWebApp(workspace, id =>
    [sessionId, 'qq:legacy'].includes(id) ? {
      sessionId: id, workspaceRoot: 'qq:owner', workdir: localFolderWorkdirRef('folder'),
    } : null, () => ({
      node: 'online', capability: { kind: 'workdir', online: true, path: folder },
    }))
  const url = (path: string, id = sessionId) =>
    `/api/media?sessionId=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`
  try {
    for (const id of [sessionId, 'qq:legacy']) {
      for (const path of ['uploads/视频.mp4', 'uploads\\视频.mp4', join(owner, 'uploads', '视频.mp4')]) {
        // Backslashes represent path separators only on Windows.
        if (path.includes('\\') && process.platform !== 'win32') continue
        const response = await app.request(url(path, id), { headers: { Range: 'bytes=1-3' } })
        assert.equal(response.status, 206)
        assert.equal(response.headers.get('Content-Type'), 'video/mp4')
        assert.equal(await response.text(), '123')
      }
    }
    const head = await app.request(`${url('uploads/视频.mp4')}&download=1`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('Content-Length'), '10')
    assert.match(head.headers.get('Content-Disposition')!, /^attachment;.*filename\*=UTF-8''%E8%A7%86%E9%A2%91.mp4$/)
    assert.equal(await head.text(), '')
    for (const path of [
      'workdir.txt', 'private.txt', 'uploads/../private.txt', '../qq_sibling/uploads/other.mp4',
      join(sibling, 'uploads', 'other.mp4'), join(folder, 'uploads', '视频.mp4'),
      'uploads/missing.mp4', 'uploads', 'uploads/\0invalid',
    ]) assert.equal((await app.request(url(path))).status, 404, path)
    for (const id of ['qq:unknown', 'bot:project-b:bot-a:qq:group%3A123', '__proto__']) {
      assert.equal((await app.request(url(join(owner, 'uploads', '视频.mp4'), id))).status, 404)
    }
    for (const query of ['chatId=a&sessionId=', 'chatId=&sessionId=qq%3Alegacy', 'chatId=a&sessionId=qq%3Alegacy', 'sessionId=']) {
      assert.equal((await app.request(`/api/media?${query}&path=uploads/file.mp4`)).status, 400)
    }
    await symlink(sibling, join(owner, 'uploads', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await app.request(url('uploads/linked/uploads/other.mp4'))).status, 404)
    await rm(join(owner, 'uploads'), { recursive: true })
    await symlink(join(sibling, 'uploads'), join(owner, 'uploads'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await app.request(url('uploads/other.mp4'))).status, 404)
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})

test('session media and legacy upload serving retain gateway authentication and GET/HEAD folder checks', async () => {
  const workspace = await createTempWorkspace()
  const root = sessionWorkspacePath(workspace, 'qq:chat')
  await mkdir(join(root, 'uploads'), { recursive: true })
  await writeFile(join(root, 'uploads', 'clip.webm'), 'video')
  const app = new Hono()
  registerGatewayRoutes(app, [], { launchCredential: 'media-test-credential' })
  const checked: string[] = []
  let denied = false
  const channel = new WebChannel(new Bus(), { workspace, sessionManager: {
    getSessionState: (id: string) => id === 'qq:chat' || id === 'web:chat'
      ? { sessionId: id, workspaceRoot: 'qq:chat' } : null,
    assertFolderAccess: (id: string) => {
      checked.push(id)
      if (denied) throw new FolderError('folder_unavailable', 'Folder unavailable', 409)
    },
  } as unknown as SessionManager })
  await channel.start(app)
  const headers = { Authorization: 'Bearer media-test-credential' }
  try {
    for (const [url, id] of [
      ['/api/media?sessionId=qq%3Achat&path=uploads%2Fclip.webm', 'qq:chat'],
      ['/api/media?chatId=chat&path=uploads%2Fclip.webm', 'web:chat'],
      ['/api/chat/uploads/clip.webm?chatId=chat', 'web:chat'],
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const count = checked.length
        assert.equal((await app.request(url, { method })).status, 401)
        assert.equal(checked.length, count)
        const response = await app.request(url, { method, headers })
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('Content-Length'), '5')
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
        assert.equal(await response.text(), method === 'HEAD' ? '' : 'video')
        assert.equal(checked.at(-1), id)
        denied = true
        assert.equal((await app.request(url, { method, headers })).status, 409)
        denied = false
      }
      const range = await app.request(`${url}&download=1`, { headers: { ...headers, Range: 'bytes=1-2' } })
      assert.equal(range.status, 206)
      assert.match(range.headers.get('Content-Disposition')!, /^attachment;/)
      assert.equal(await range.text(), 'id')
    }
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})

test('explicit session media refuses remote and unavailable workdirs even when private uploads exist', async () => {
  const workspace = await createTempWorkspace()
  const { app, channel } = await createWebApp(workspace, sessionId => ({
    sessionId,
    workdir: { ...localFolderWorkdirRef('missing'), nodeId: sessionId === 'qq:remote' ? 'remote' : 'local' },
  }), ref => ({
    node: 'online', capability: { kind: 'workdir', online: ref.nodeId === 'remote', path: workspace },
  }))
  try {
    for (const sessionId of ['qq:remote', 'qq:missing']) {
      const root = sessionWorkspacePath(workspace, sessionId)
      await mkdir(join(root, 'uploads'), { recursive: true })
      await writeFile(join(root, 'uploads', 'clip.mp4'), 'not served')
      for (const method of ['GET', 'HEAD']) {
        assert.equal((await app.request(`/api/media?sessionId=${encodeURIComponent(sessionId)}&path=uploads%2Fclip.mp4`, { method })).status, 404)
      }
    }
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})
