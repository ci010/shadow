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
import { physicalSessionId } from '../sessions/session-identity.ts'
import { localFolderWorkdirRef, type WorkdirLookup } from '../sessions/locality.ts'
import type { ChatMessage } from '../providers/provider.ts'
import { RealtimeHub } from '../realtime/hub.ts'
import { FolderError } from '../folders/registry.ts'
import { registerGatewayRoutes } from '../gateway/server.ts'
import { MessageTool } from '../tools/message.ts'
import { buildUserChatMessage } from '../agent/message-builder.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { createResponseContext } from '../sessions/response-context.ts'
import { channelMessageInput } from '../sessions/input.ts'

test('explicit web queue delivery becomes a queue input and invalid policies are rejected before admission', async () => {
  const channel = new WebChannel(new Bus(), {})
  const app = new Hono()
  const deliveries: ReturnType<typeof channelMessageInput>[] = []
  channel.setReceiver(async message => {
    deliveries.push(channelMessageInput(message))
    return { status: 'accepted', sessionId: `web:${message.chatId}`, inputId: message.messageId }
  })
  await channel.start(app)
  const send = (extra: Record<string, unknown> = {}) => app.request('/api/chat/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: 'queue-fixture', content: 'Exact queued content', ...extra }),
  })
  try {
    for (const extra of [{ delivery: 'queue' }, {}]) assert.equal((await send(extra)).status, 200)
    assert.deepEqual(deliveries.map(input => input.kind === 'message' && input.policy), ['queue', 'interactive'])
    assert.equal(deliveries[0].kind === 'message' && deliveries[0].content, 'Exact queued content')
    for (const extra of [{ delivery: 'steering' }, { delivery: true }, { delivery: 'queue', retry: true }]) {
      assert.equal((await send(extra)).status, 400)
    }
    assert.equal(deliveries.length, 2)
  } finally { await channel.stop() }
})

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
    const responseContext = createResponseContext('turn', { kind: 'session', sessionId: 'web:peer' }, 'session', 'web')
    bus.emit('message.outbound', { event: 'response', channel: 'web', chatId: 'owner',
      content: 'Exact final result', media: ['report.txt'], responseContext, done: true })
    const payload = JSON.parse((await decode()).match(/^data: (.+)$/m)![1]).payload
    assert.deepEqual(payload.responseContext, responseContext)
    assert.equal(payload.content, 'Exact final result')
    assert.deepEqual(payload.media, ['report.txt'])
    assert.equal(payload.done, true)
  } finally {
    await reader.cancel()
    await channel.stop()
    hub.close()
  }
})

test('display provenance does not filter or relabel synchronous REST content and media', async () => {
  const bus = new Bus()
  const channel = new WebChannel(bus, {})
  const app = new Hono()
  channel.setReceiver(async message => {
    bus.emit('message.outbound', {
      event: 'response', channel: 'web', chatId: message.chatId, replyTo: message.messageId,
      done: true, content: 'Complete unabridged result', media: ['report.txt'],
      responseContext: createResponseContext('turn', { kind: 'event', eventId: 'event', type: 'fixture', source: 'worker' }, 'session', 'web'),
    })
    return { status: 'accepted', sessionId: `web:${message.chatId}`, inputId: message.messageId }
  })
  await channel.start(app)
  try {
    const response = await app.request('/api/chat/message', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: 'owner', content: 'Read result' }) })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.content, 'Complete unabridged result')
    assert.deepEqual(body.media, ['report.txt'])
    assert.equal(body.responseContext, undefined)
    assert.equal(body.chatId, 'owner')
  } finally { await channel.stop() }
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
  workdirLookup?: WorkdirLookup,
) {
  const app = new Hono()
  const sessionManager = {
    getSessionState,
    workdirLookup,
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
  channel.setReceiver(async message => {
    deliveries.push({ chatId: message.chatId, content: message.content, media: message.media })
    return { status: 'accepted', sessionId: `web:${message.chatId}`, inputId: message.messageId }
  })
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
      workdir: { online: true, path: ref.workdirId.endsWith(':other') ? otherFolder : folder },
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
    const absoluteFolderFile = await app.request(`/api/media?chatId=child&path=${encodeURIComponent(join(folder, 'image.txt'))}&download=1`)
    assertEquals(absoluteFolderFile.status, 200)
    assertEquals(await absoluteFolderFile.text(), 'folder image')
    assert.match(absoluteFolderFile.headers.get('Content-Disposition')!, /^attachment;/)
    assertEquals((await app.request(`/api/media?chatId=child&path=${encodeURIComponent(join(otherFolder, 'image.txt'))}`)).status, 404)
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
      workdir: { online: ref.nodeId === 'remote', path: workspace },
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

test('web media rejects missing identity, outside absolute paths, and traversal without path leaks', async () => {
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
    const workdirEscape = join(sessionRoot, 'linked', 'secret.txt')
    assertEquals((await app.request(`/api/media?chatId=chat-a&path=${encodeURIComponent(workdirEscape)}`)).status, 404)
    assertEquals((await app.request('/api/chat/uploads/linked/secret.txt?chatId=chat-a')).status, 404)
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true })
  }
})

test('generated absolute workdir attachments use inherited ownership, not arbitrary sibling sessions', async () => {
  const workspace = await createTempWorkspace()
  const file = join(sessionWorkspacePath(workspace, 'web:owner'), 'runs', 'review notes', 'report.html')
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, '<html>Generated report</html>')
  const { app, channel } = await createWebApp(workspace, sessionId => ({
    sessionId, ...(sessionId === 'web:child' ? { workspaceRoot: 'web:owner' } : {}),
  }))
  try {
    for (const method of ['GET', 'HEAD']) {
      const response = await app.request(`/api/media?chatId=child&path=${encodeURIComponent(file)}&download=1`, { method })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('Content-Disposition')!, /^attachment;/)
      assert.equal(await response.text(), method === 'HEAD' ? '' : '<html>Generated report</html>')
    }
    assert.equal((await app.request(`/api/media?chatId=sibling&path=${encodeURIComponent(file)}`)).status, 404)
    assert.equal((await app.request(`/api/media?sessionId=web%3Achild&path=${encodeURIComponent(file)}`)).status, 404)
    const ranged = await app.request(`/api/media?chatId=child&path=${encodeURIComponent(file)}`, { headers: { Range: 'bytes=0-5' } })
    assert.equal(ranged.status, 206)
    assert.equal(await ranged.text(), '<html>')
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
      node: 'online', workdir: { online: true, path: folder },
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
    node: 'online', workdir: { online: ref.nodeId === 'remote', path: workspace },
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


test('web chat context rejects missing IDs before reading context and preserves existing sessions', async () => {
  const app = new Hono()
  const reads: string[] = []
  const channel = new WebChannel(new Bus(), { sessionManager: {
    getSessionState: (id: string) => id === 'web:existing' ? { sessionId: id } : null,
    getContext: async ({ sessionId }: { sessionId: string }) => { reads.push(sessionId); return { systemPrompt: 'Existing prompt', tools: [] } },
    getHistory: async () => ({ messages: [{ role: 'user', content: 'Existing history' }] }),
    getCommandResults: async () => [], getYieldRecords: async () => [],
  } as unknown as SessionManager })
  await channel.start(app)
  try {
    for (const id of ['unknown', 'deleted', 'other-project']) {
      const response = await app.request(`/api/chat/session?chatId=${id}`)
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), { error: 'session_not_found' })
    }
    assert.deepEqual(reads, [])
    const response = await app.request('/api/chat/session?chatId=existing')
    assert.equal(response.status, 200)
    assert.equal((await response.json()).systemPrompt, 'Existing prompt')
    assert.deepEqual(reads, ['web:existing'])
  } finally { await channel.stop() }
})


test('chat session response includes segment navigation without another history read', async () => {
  const app = new Hono()
  let historyReads = 0
  let state = { sessionId: 'web:segmented', segmentIndex: 2 }
  const history = [{ role: 'user', content: 'History' }]
  const tools = [{ name: 'read', description: 'Read' }]
  const channel = new WebChannel(new Bus(), { sessionManager: {
    getSessionState: () => state,
    getContext: async () => ({ systemPrompt: 'Prompt', tools }),
    getHistory: async () => { historyReads++; return { messages: history } },
    getCommandResults: async () => ['command'], getYieldRecords: async () => ['decision'],
  } as unknown as SessionManager })
  await channel.start(app)
  try {
    for (const index of [2, 0]) {
      state = { ...state, segmentIndex: index }
      const response = await app.request('/api/chat/session?chatId=segmented')
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.deepEqual(body, { chatId: 'segmented', systemPrompt: 'Prompt', history, tools,
        commandResults: ['command'], decisionRecords: ['decision'], segmentIndex: index,
        currentPhysicalId: physicalSessionId(state),
        previousPhysicalId: index ? physicalSessionId(state, index - 1) : null })
    }
    assert.equal(historyReads, 2)
  } finally { await channel.stop() }
})


test('chat history conditional reads validate all response fields and never hide deletion', async () => {
  const app = new Hono()
  let exists = true
  let prompt = 'Prompt'
  let history = [{ role: 'user', content: 'History' }]
  let commands: string[] = []
  let decisions: string[] = []
  let tools: string[] = []
  let segmentIndex = 0
  const channel = new WebChannel(new Bus(), { sessionManager: {
    getSessionState: () => exists ? { sessionId: 'web:cached', segmentIndex } : null,
    getContext: async () => ({ systemPrompt: prompt, tools }),
    getHistory: async () => ({ messages: history }),
    getCommandResults: async () => commands, getYieldRecords: async () => decisions,
  } as unknown as SessionManager })
  await channel.start(app)
  const read = (etag?: string) => app.request('/api/chat/session?chatId=cached', {
    headers: etag ? { 'If-None-Match': etag } : {},
  })
  try {
    let response = await read()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-cache')
    let etag = response.headers.get('etag')!
    assert.ok(etag)
    const unchanged = await read(etag)
    assert.equal(unchanged.status, 304)
    assert.equal(await unchanged.text(), '')
    assert.equal((await read(`"other", W/${etag}`)).status, 304)
    for (const change of [
      () => { history = [{ role: 'user', content: 'Edited history of the same length' }] },
      () => { prompt = 'Changed context' },
      () => { tools = ['read'] },
      () => { commands = ['command'] },
      () => { decisions = ['decision'] },
      () => { segmentIndex = 1 },
    ]) {
      change()
      response = await read(etag)
      assert.equal(response.status, 200)
      assert.notEqual(response.headers.get('etag'), etag)
      etag = response.headers.get('etag')!
      assert.equal((await read(etag)).status, 304)
    }
    exists = false
    assert.equal((await read(etag)).status, 404)
  } finally { await channel.stop() }
})


test('history append validates complete old prefix and metadata, not client counts', async () => {
  const app = new Hono()
  let history = [{ role: 'user', content: 'x'.repeat(100_000) }]
  let systemPrompt = 'prompt'
  let segmentIndex = 0
  let commands: string[] = []
  let decisions: string[] = []
  const channel = new WebChannel(new Bus(), { sessionManager: {
    getSessionState: () => ({ sessionId: 'web:delta', segmentIndex }),
    getContext: async () => ({ systemPrompt, tools: [] }),
    getHistory: async () => ({ messages: history }),
    getCommandResults: async () => commands, getYieldRecords: async () => decisions,
  } as unknown as SessionManager })
  await channel.start(app)
  const read = (revision = '', count = '1') => app.request(`/api/chat/session?chatId=delta&snapshot=${revision}&historyCount=${count}`)
  try {
    const initial = await (await read()).json()
    assert.ok((await (await read(initial.revision, '999')).json()).data, 'unchanged revision does not excuse a mismatched count')
    history.push({ role: 'system', content: 'inserted context' }, { role: 'assistant', content: 'answer' })
    const response = await read(initial.revision)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const wire = await response.text()
    const append = JSON.parse(wire)
    assert.deepEqual(append.delta.history, history.slice(1))
    assert.ok(wire.length < JSON.stringify(initial).length / 100, 'growing history sends only suffix')
    for (const count of ['-1', '1.0', '01', '9007199254740992', '999', '0']) {
      assert.ok((await (await read(initial.revision, count)).json()).data)
    }
    for (const change of [
      () => { history[0] = { role: 'user', content: 'edited' } },
      () => { systemPrompt = 'changed' },
      () => { commands = ['command'] },
      () => { decisions = ['decision'] },
      () => { segmentIndex++ },
      () => { history = [] },
    ]) {
      const base = await (await read()).json()
      const count = String(history.length)
      change()
      assert.ok((await (await read(base.revision, count)).json()).data, 'changed base falls back to full')
    }
  } finally { await channel.stop() }
})

test('history block reuse requires exact hash/count and bounded offset', async () => {
  const app = new Hono()
  const original = [{ role: 'user', content: 'original' }]
  let history = [...original]
  let systemPrompt = 'old'
  const channel = new WebChannel(new Bus(), { sessionManager: {
    getSessionState: () => ({ sessionId: 'web:block', segmentIndex: 0 }),
    getContext: async () => ({ systemPrompt, tools: [] }),
    getHistory: async () => ({ messages: history }),
    getCommandResults: async () => [], getYieldRecords: async () => [],
  } as unknown as SessionManager })
  await channel.start(app)
  const read = async (params: Record<string, string>) => (await app.request('/api/chat/session?' + new URLSearchParams({ chatId: 'block', ...params }))).json()
  try {
    const base = await read({ snapshot: '' })
    const params = { snapshot: base.revision, historyRevision: base.historyRevision, historyCount: '1' }
    assert.match(base.metadataRevision, /^[a-f0-9]{64}$/)
    history.push({ role: 'assistant', content: 'small append' })
    const omitted = await read({ ...params, metadataRevision: base.metadataRevision })
    assert.equal('metadata' in omitted.delta, false)
    assert.equal(omitted.delta.baseMetadataRevision, base.metadataRevision)
    assert.equal(omitted.metadataRevision, base.metadataRevision)
    assert.ok((await read(params)).delta.metadata, 'old clients still receive metadata')
    assert.ok((await read({ ...params, metadataRevision: 'invalid' })).delta.metadata)
    systemPrompt = 'new'
    const changed = await read({ ...params, metadataRevision: base.metadataRevision })
    assert.equal(changed.delta.metadata.systemPrompt, 'new')
    assert.notEqual(changed.metadataRevision, base.metadataRevision)
    history = [...Array.from({ length: 16 }, () => ({ role: 'system', content: 'leading' })), ...original, { role: 'assistant', content: 'suffix' }]
    const delta = await read(params)
    assert.equal(delta.delta.historyOffset, 16)
    assert.equal(delta.delta.leadingHistory.length, 16)
    assert.deepEqual(delta.delta.history, history.slice(17))
    for (const patch of [
      { historyCount: '-1' }, { historyCount: '01' }, { historyCount: '9007199254740992' },
      { historyCount: '999' }, { historyRevision: 'invalid' }, { historyRevision: 'a'.repeat(64) },
      { snapshot: 'invalid' },
    ]) assert.ok((await read({ ...params, ...patch })).data, 'invalid validator falls back to full')
    history.unshift({ role: 'system', content: 'beyond bound' })
    assert.ok((await read(params)).data, 'offset 17 is outside bounded reuse')
  } finally { await channel.stop() }
})
