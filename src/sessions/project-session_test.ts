import assert, { deepEqual, equal, rejects } from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import { ProcessManager } from '../agent/process-manager.ts'
import { buildUserChatMessage } from '../agent/message-builder.ts'
import { Bus } from '../bus/bus.ts'
import { WebChannel } from '../channels/web.ts'
import type { InboundMessage } from '../bus/events.ts'
import type { LLMProvider } from '../providers/provider.ts'
import type { HandoffManager } from '../handoff/manager.ts'
import { CommandHandlerManager } from '../tools/commands/command-handler.ts'
import { WriteTool } from '../tools/filesystem.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { ExecTool } from '../tools/shell.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import { localProjectWorkdirRef, managedSessionWorkdirRef, resolveSessionLocations, type WorkdirCapabilityLookup } from './locality.ts'
import { sessionsApiPlugin } from './routes.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { Session } from './session.ts'
import { channelMessageInput, type SessionTurnFact } from './input.ts'

const llm: LlmRuntimeConfig = { model: 'fixture', contextWindow: 100_000, temperature: 0 }

test('project attachment context distinguishes absolute private uploads from relative project uploads', async () => {
  await mkdir('.test-data', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.test-data', 'project-media-'))
  try {
    const project = join(root, 'project')
    const privateData = join(root, 'session')
    await mkdir(join(project, 'uploads'), { recursive: true })
    await mkdir(join(privateData, 'uploads'), { recursive: true })
    await writeFile(join(privateData, 'uploads', 'image.png'), 'private image')
    await writeFile(join(project, 'uploads', 'image.png'), 'project image')
    const input = channelMessageInput(message('a', [
        join(privateData, 'uploads', 'image.png'),
        join(privateData, 'uploads', 'notes.txt'),
        'uploads/image.png', './uploads/image.png', 'uploads/notes.txt',
      ]))
    assert(input.kind === 'message')
    const built = await buildUserChatMessage(
      input,
      root, project,
    )
    assert(Array.isArray(built.content))
    deepEqual(built.content.slice(2), [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('private image').toString('base64')}`, detail: 'auto' } },
      { type: 'text', text: `[file: ${join(privateData, 'uploads', 'notes.txt')}]` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('project image').toString('base64')}`, detail: 'auto' } },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('project image').toString('base64')}`, detail: 'auto' } },
      { type: 'text', text: '[file: uploads/notes.txt]' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function message(chatId: string, media?: string[]): InboundMessage {
  return {
    channel: 'web', chatId, senderId: 'fixture', messageId: crypto.randomUUID(),
    content: 'Write project fixtures', timestamp: new Date().toISOString(), media,
  }
}

function manager(
  workspace: string,
  store: SessionStore,
  tools: Tools,
  provider: LLMProvider,
  workdirCapabilityLookup: WorkdirCapabilityLookup,
) {
  const fixtureBus = new Bus()
  return Object.assign(new SessionManager({
    workspace, store, tools, provider, workdirCapabilityLookup, bus: fixtureBus,
    context: { buildSystemPrompt: async () => 'Synthetic project context' },
    agentTypes: {
      resolve: () => ({ name: 'fixture', description: '', prompt: '', ephemeral: true, source: 'builtin' }),
    },
  } as unknown as SessionManagerDeps), { fixtureBus })
}

async function dispatchAndFinish(sessions: ReturnType<typeof manager>, msg: InboundMessage) {
  const completed = Promise.withResolvers<SessionTurnFact>()
  const subscription = sessions.fixtureBus.on('session.turn.finished', (fact) => {
    if (fact.inputId === msg.messageId) completed.resolve(fact)
  })
  try {
    await sessions.dispatch(msg, llm)
    const fact = await completed.promise
    await sessions.getActiveSession(`web:${msg.chatId}`)?.completion
    if (fact.status === 'failed') throw new Error(fact.error)
    equal(fact.status, 'completed')
  } finally {
    sessions.fixtureBus.off(subscription)
  }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: uploads before the first fork send retain their own data owner after restart`, async () => {
    await mkdir('.test-data', { recursive: true })
    const root = await mkdtemp(join(process.cwd(), '.test-data', 'fork-upload-'))
    const home = join(root, 'main')
    const project = join(root, 'project')
    await mkdir(project)
    const lookup: WorkdirCapabilityLookup = () => ({
      node: 'online', capability: { kind: 'workdir', online: true, path: project },
    })
    const provider: LLMProvider = {
      name: 'fixture', listModels: () => ['fixture'],
      chat: async () => { throw new Error('No LLM should be called by the upload/fork API test') },
    }
    const tools = new Tools(home)
    let store: SessionStore = new Store(join(home, 'sessions'))
    let sessions = manager(home, store, tools, provider, lookup)
    let channel = new WebChannel(new Bus(), { workspace: home, sessionManager: sessions })
    channel.setReceiver(async (msg) => ({
      status: 'accepted', sessionId: `web:${msg.chatId}`, inputId: msg.messageId,
    }))
    let app = new Hono()
    const uploads: Array<{ chatId: string; parentChatId: string; path: string; projectId?: string; ownerSessionId?: string }> = []
    const verifyUpload = async (upload: typeof uploads[number]) => {
      const urls = [
        `/api/media?chatId=${upload.chatId}&path=${encodeURIComponent(upload.path)}`,
        `/api/chat/uploads/${basename(upload.path)}?chatId=${upload.chatId}`,
      ]
      for (const url of urls) {
        const response = await app.request(url)
        equal(response.status, 200)
        equal(await response.text(), 'uploaded before fork creation')
      }
      const state = sessions.getSessionState(`web:${upload.chatId}`)
      if (state) {
        equal(state.workspaceRoot, upload.ownerSessionId)
        equal(state.projectId, upload.projectId)
        const locations = resolveSessionLocations(home, state, undefined, lookup)
        equal(locations.sessionDataDir, sessionWorkspacePath(home, upload.ownerSessionId ?? state.sessionId))
        assert(locations.workdir.available && locations.workdir.locality === 'local')
        equal(locations.workdir.path, upload.projectId ? project : locations.sessionDataDir)
      }
    }
    try {
      await store.init()
      await sessions.start()
      await channel.start(app)
      await sessions.buildSession('web:project-parent', undefined, {
        projectId: 'folder-a', workdir: localProjectWorkdirRef('folder-a'),
      })
      await sessions.buildSession('web:legacy-parent')
      await sessions.buildSession('web:managed-parent', undefined, {
        workdir: managedSessionWorkdirRef('web:managed-parent'),
      })
      for (const parentChatId of ['project-parent', 'fork-project-parent', 'legacy-parent', 'managed-parent']) {
        const chatId = `fork-${parentChatId}`
        const form = new FormData()
        form.set('chatId', chatId)
        form.set('file', new File(['uploaded before fork creation'], 'attachment.txt'))
        const response = await app.request('/api/chat/upload', { method: 'POST', body: form })
        equal(response.status, 200)
        const { path } = await response.json() as { path: string }
        assert(isAbsolute(path))
        equal(path, join(sessionWorkspacePath(home, `web:${chatId}`), 'uploads', basename(path)))
        const upload = { chatId, parentChatId, path, projectId: sessions.getSessionState(`web:${parentChatId}`)?.projectId }
        uploads.push(upload)
        await verifyUpload(upload)
        const sent = await app.request('/api/chat/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, parentChatId, content: 'First fork message', media: [path], stream: false }),
        })
        equal(sent.status, 200)
        await verifyUpload(upload)
        equal((await app.request(`/api/media?chatId=${parentChatId}&path=${encodeURIComponent(path)}`)).status, 404)
      }
      await sessions.buildSession('web:subagent', { id: 'web:managed-parent' }, {
        workspaceRoot: 'web:managed-parent', workdir: managedSessionWorkdirRef('web:managed-parent'),
      })
      equal(resolveSessionLocations(home, sessions.getSessionState('web:subagent')!).sessionDataDir, sessionWorkspacePath(home, 'web:managed-parent'))
      const subagentForm = new FormData()
      subagentForm.set('chatId', 'subagent')
      subagentForm.set('file', new File(['uploaded before fork creation'], 'subagent.txt'))
      const subagentResponse = await app.request('/api/chat/upload', { method: 'POST', body: subagentForm })
      equal(subagentResponse.status, 200)
      const subagentUpload = {
        ...await subagentResponse.json() as { path: string },
        chatId: 'subagent', parentChatId: 'managed-parent', ownerSessionId: 'web:managed-parent',
      }
      equal(subagentUpload.path, join(sessionWorkspacePath(home, 'web:managed-parent'), 'uploads', basename(subagentUpload.path)))
      uploads.push(subagentUpload)
      await verifyUpload(subagentUpload)
      const remoteWorkdir = { ...managedSessionWorkdirRef('remote-owner'), nodeId: 'remote-node' }
      await sessions.buildSession('web:remote-parent', undefined, { workdir: remoteWorkdir })
      await sessions.buildSession('web:remote-fork', { id: 'web:remote-parent' })
      deepEqual(sessions.getSessionState('web:remote-fork')?.workdir, remoteWorkdir)
      equal(sessions.getSessionState('web:remote-fork')?.workspaceRoot, undefined)

      await channel.stop()
      await sessions.stop()
      store.close?.()
      store = new Store(join(home, 'sessions'))
      await store.init()
      sessions = manager(home, store, tools, provider, lookup)
      await sessions.start()
      app = new Hono()
      channel = new WebChannel(new Bus(), { workspace: home, sessionManager: sessions })
      channel.setReceiver(async (msg) => ({
        status: 'accepted', sessionId: `web:${msg.chatId}`, inputId: msg.messageId,
      }))
      await channel.start(app)
      for (const upload of uploads) await verifyUpload(upload)
      deepEqual(sessions.getSessionState('web:remote-fork')?.workdir, remoteWorkdir)
      equal(sessions.getSessionState('web:subagent')?.workspaceRoot, 'web:managed-parent')
    } finally {
      await channel.stop()
      await sessions.stop()
      store.close?.()
      await rm(root, { recursive: true, force: true })
    }
  })

  test(`${Store.name}: folder cwd, session grouping, forks, and restart preserve project isolation`, async () => {
    await mkdir('.test-data', { recursive: true })
    const root = await mkdtemp(join(process.cwd(), '.test-data', 'project-session-'))
    const home = join(root, 'main')
    const folders = { a: join(root, 'project-a'), b: join(root, 'project-b') }
    for (const path of [home, ...Object.values(folders)]) await mkdir(path)
    const lookup: WorkdirCapabilityLookup = (ref) => {
      const path = ref.capabilityId === 'local-project-v1:a' ? folders.a
        : ref.capabilityId === 'local-project-v1:b' ? folders.b : undefined
      let online = false
      try { online = !!path && statSync(path).isDirectory() } catch { /* missing folder */ }
      return { node: 'online', capability: path ? { kind: 'workdir', online, path } : undefined }
    }
    let store: SessionStore = new Store(join(home, 'sessions'))
    const tools = new Tools(home)
    const observedCwds: Array<string | undefined> = []
    tools.addHook({
      name: 'observe-cwd',
      beforeExecute: async (_name, _args, ctx) => { observedCwds.push(ctx.cwd) },
      afterExecute: async () => undefined,
    })
    tools.register(new WriteTool(home))
    tools.register(new ExecTool(
      home, 10_000, new CommandHandlerManager(), new ProcessManager(),
      process.platform === 'win32' ? 'powershell' : 'sh',
      {} as BackgroundTaskManager,
    ))
    const provider: LLMProvider = {
      name: 'fixture',
      listModels: () => ['fixture'],
      chat: async (messages) => messages.at(-1)?.role === 'tool'
        ? { content: 'Done', toolCalls: [] }
        : {
          content: null,
          toolCalls: [
            { id: 'write-1', name: 'write', arguments: { path: 'relative.txt', content: 'project file' } },
            {
              id: 'exec-1', name: 'exec', arguments: {
                script: process.platform === 'win32'
                  ? "Set-Content -LiteralPath shell.txt -Value (Get-Location).Path -NoNewline"
                  : 'pwd > shell.txt',
              },
            },
          ],
        },
    }
    let sessions = manager(home, store, tools, provider, lookup)
    try {
      await store.init()
      await sessions.start()
      for (const id of ['a', 'b'] as const) {
        await sessions.buildSession(`web:${id}`, undefined, {
          projectId: id, projectName: 'unrelated-planning-notes',
          workdir: localProjectWorkdirRef(id), description: `Project ${id}`,
        })
        await dispatchAndFinish(sessions, message(id))
        equal(await readFile(join(folders[id], 'relative.txt'), 'utf8'), 'project file')
        equal((await readFile(join(folders[id], 'shell.txt'), 'utf8')).trim(), folders[id])
        equal(existsSync(join(sessionWorkspacePath(home, `web:${id}`), 'relative.txt')), false)
      }
      deepEqual(observedCwds, [folders.a, folders.a, folders.b, folders.b])
      equal(existsSync(join(home, 'relative.txt')), false)
      equal(existsSync(join(home, 'shell.txt')), false)
      await sessions.buildSession('web:fork', { id: 'web:a', physicalId: 'web_a-0', index: 3 })
      await sessions.buildSession('web:nested', { id: 'web:fork' })
      for (const id of ['web:fork', 'web:nested']) {
        const state = sessions.getSessionState(id)!
        equal(state.projectId, 'a')
        deepEqual(state.workdir, localProjectWorkdirRef('a'))
        equal(state.workspaceRoot, undefined)
        equal(resolveSessionLocations(home, state, undefined, lookup).sessionDataDir, sessionWorkspacePath(home, id))
      }
      await sessions.buildSession('web:legacy', undefined, { projectName: 'a' })
      equal(sessions.getSessionState('web:legacy')!.projectId, undefined)
      const legacy = resolveSessionLocations(home, sessions.getSessionState('web:legacy')!, undefined, lookup)
      assert(legacy.workdir.available && legacy.workdir.locality === 'local')
      equal(legacy.workdir.path, sessionWorkspacePath(home, 'web:legacy'))

      await sessions.addChild('web:a', 'web:fork')
      await sessions.setSessionConfig('web:a', { temperature: 0.2 })
      const saved = JSON.parse(JSON.stringify(sessions.getSessionState('web:a')))
      await sessions.stop()
      store.close?.()
      store = new Store(join(home, 'sessions'))
      await store.init()
      sessions = manager(home, store, tools, provider, lookup)
      await sessions.start()
      deepEqual(JSON.parse(JSON.stringify(sessions.getSessionState('web:a'))), saved)
      equal(sessions.getSessionState('web:nested')!.projectId, 'a')
      equal((await store.listSessions()).find((s) => s.sessionId === 'web:a')?.projectId, 'a')
      equal(sessions.listSessions().find((s) => s.sessionId === 'web:a')?.projectId, 'a')
      const app = new Hono()
      sessionsApiPlugin(sessions)(app)
      const graph = await (await app.request('/api/sessions/graph')).json()
      equal(graph.sessions.find((s: { sessionId: string }) => s.sessionId === 'web:a').projectId, 'a')
      equal(graph.nodes.find((s: { logicalId: string }) => s.logicalId === 'web:a').projectId, 'a')
      const persisted = Promise.withResolvers<void>()
      const stopped = Promise.withResolvers<void>()
      const originalSave = store.saveState.bind(store)
      store.saveState = async (id, state) => {
        await originalSave(id, state)
        if (id === 'web:a' && state.segmentIndex === 1) persisted.resolve()
      }
      const compacting = new Session(
        home, 'web:a', sessions.getSessionState('web:a')!,
        (await sessions.getHistory('web:a')).messages,
        provider, new SessionTools(tools, home), new Bus(), store,
        {
          create: async () => ({
            targetSessionId: 'web_a-1', timestamp: new Date().toISOString(),
            context: { summary: 'Fixture', currentObjective: '', recentTranscript: [] },
            prompt: 'Compacted project fixture',
          }),
        } as unknown as HandoffManager,
        () => stopped.resolve(), undefined, undefined, undefined, lookup,
      )
      const timeout = setTimeout(() => persisted.reject(new Error('Compaction did not persist')), 5_000)
      try {
        compacting.requestCompact(llm)
        await persisted.promise
        const compactedState = await store.getState('web:a')
        equal(compactedState?.segmentIndex, 1)
        deepEqual(compactedState?.workdir, localProjectWorkdirRef('a'))
        equal(compactedState?.projectId, 'a')
        equal(compactedState?.projectName, 'unrelated-planning-notes')
        deepEqual(compactedState?.children, ['web:fork'])
        equal(compactedState?.description, 'Project a')
        equal(compactedState?.config?.temperature, 0.2)
        equal((await store.readFirstRecord('web_a-1'))?.summary_context, 'Compacted project fixture')
      } finally {
        clearTimeout(timeout)
        compacting.stop()
        await stopped.promise
        store.saveState = originalSave
      }
      await writeFile(join(folders.b, 'relative.txt'), 'other project unchanged')
      await dispatchAndFinish(sessions, message('a'))
      equal(await readFile(join(folders.b, 'relative.txt'), 'utf8'), 'other project unchanged')

      await rm(folders.a, { recursive: true })
      await rejects(dispatchAndFinish(sessions, message('a')), /workdir unavailable/)
      equal(existsSync(folders.a), false)
      await sessions.buildSession('web:unknown', undefined, {
        workdir: { ...localProjectWorkdirRef('unknown'), displayPathSnapshot: folders.b },
      })
      await rejects(dispatchAndFinish(sessions, message('unknown')), /workdir unavailable/)
      await sessions.buildSession('web:remote', undefined, {
        workdir: { ...localProjectWorkdirRef('b'), nodeId: 'remote', displayPathSnapshot: folders.b },
      })
      await rejects(dispatchAndFinish(sessions, message('remote')), /remote executor/)
      equal(await readFile(join(folders.b, 'relative.txt'), 'utf8'), 'other project unchanged')
    } finally {
      await sessions.stop()
      store.close?.()
      await rm(root, { recursive: true, force: true })
    }
  })
}
