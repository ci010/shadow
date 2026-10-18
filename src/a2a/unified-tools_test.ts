import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { Bus } from '../bus/bus.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { IdentityManager } from '../agent/identity.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { BackgroundTaskManager, backgroundExecutionId } from '../agent/background-task.ts'
import { createProjectScope } from '../projects/scope.ts'
import { ChannelManager } from '../channels/manager.ts'
import { ConfigSchema } from '../config/schema.ts'
import { EventService } from '../events/service.ts'
import { HandoffManager } from '../sessions/handoff/manager.ts'
import { SessionManager } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { SessionStore } from '../sessions/session-store.ts'
import type { LLMProvider } from '../providers/provider.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { MessageTool } from '../tools/message.ts'
import { SubagentTool } from '../tools/subagent.ts'
import { CancelTool } from '../tools/cancel.ts'
import { ReplyTool } from '../tools/reply.ts'
import { ContinuationTool } from '../tools/background.ts'
import { ExecTool } from '../tools/shell.ts'
import { requireToolText } from '../tools/tool.ts'
import { DownloadTool } from '../tools/download.ts'
import { Aria2Downloader } from '../downloader/aria2.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { defaultManagedShell } from '../execution/processes/shells.ts'
import { CommandHandlerManager } from '../tools/shell-commands/command-handler.ts'
import { createAgentsHandler } from '../vfs/agents.ts'
import { createBgTasksHandler, createSessionsHandler } from '../vfs/mounts.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { SearchTool } from '../tools/search.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { A2aClientTools } from './client.ts'
import { A2aConfigSchema } from './config.ts'
import { A2aService, type A2aRunner } from './service.ts'
import { A2aStore } from './store.ts'
import { A2aSessions } from './sessions.ts'
import { registerA2aRoutes } from './routes.ts'

async function fixture(root: string, storage: 'jsonl' | 'sqlite', runner: A2aRunner) {
  const workspace = join(root, 'home')
  const store: SessionStore = storage === 'jsonl'
    ? new JsonlSessionStore(join(workspace, '.sessions'))
    : new SqliteSessionStore(join(workspace, '.sessions'))
  await store.init()
  const bus = new Bus()
  const agentTypes = new AgentTypesManager(workspace)
  await agentTypes.load()
  const localEntered = Promise.withResolvers<void>()
  let blockLocal = false
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => [],
    async chat(_messages, _tools, options) {
      if (blockLocal) {
        const signal = options!.signal!
        const wait = Promise.withResolvers<never>()
        const abort = () => wait.reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        localEntered.resolve()
        try { signal.throwIfAborted(); return await wait.promise }
        finally { signal.removeEventListener('abort', abort) }
      }
      return { content: 'Local fixture reply', toolCalls: [] }
    },
  }
  const notifications: string[] = []
  const events: EventService = new EventService(workspace, bus, (id, input) => {
    if (input.kind === 'message' && input.source.kind === 'event') notifications.push(input.source.type)
    return sessions.deliver(id, input)
  })
  const scope = createProjectScope('p')
  const backgroundTasks = new BackgroundTaskManager(bus, events, scope)
  const handoffManager = new HandoffManager(provider, 100000, {}, workspace, store)
  const contextBuilder = new ContextBuilder(workspace)
  contextBuilder.register({ name: 'agent', getPromptSection: context => context.agent.prompt })
  const tools = new Tools(workspace)
  const sessions: SessionManager = new SessionManager({
    projectId: 'p', workspace, store, bus, provider, events, backgroundTasks, handoffManager, agentTypes,
    identity: new IdentityManager(workspace), context: contextBuilder, tools,
    getLlmRuntimeConfig: () => ({ model: 'fixture', temperature: 0, contextWindow: 100000 }),
  })
  await sessions.start()
  await sessions.buildSession('web:owner', undefined, { agentType: 'general', mode: 'session' })
  await sessions.buildSession('web:other', undefined, { agentType: 'general', mode: 'session' })
  const app = new Hono()
  const ready = Promise.withResolvers<number>()
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => ready.resolve(info.port))
  server.once('error', error => ready.reject(error))
  const endpoint = `http://127.0.0.1:${await ready.promise}/projects/peer/a2a`
  const inbound = new A2aStore(join(root, 'remote')); inbound.init()
  const service = new A2aService('peer', A2aConfigSchema.parse({
    server: { url: endpoint, agentType: 'fixture', callers: { test: 'UNUSED_TEST_AUTH' } },
  }).server!, inbound, runner)
  const project = new Hono()
  registerA2aRoutes(project, service, () => 'test')
  app.route('/projects/peer', project)
  const config = A2aConfigSchema.parse({ agents: { peer: {
    endpointUrl: endpoint, cardUrl: `${endpoint}/.well-known/agent-card.json`,
  } } })
  const outboundPath = join(root, 'outbound')
  const journal = new A2aStore(outboundPath); journal.init()
  const client = new A2aClientTools('p', config, journal)
  const remote = new A2aSessions('p', config, journal, client, context => {
    if (sessions.getSessionState(context.sessionId)?.mode !== 'session') throw new Error('Durable owner required')
  })
  const channels = new ChannelManager(ConfigSchema.parse({}), bus, sessions, async () => { throw new Error('Unused channel') })
  const subagent = new SubagentTool(bus, sessions, agentTypes, channels, remote)
  const message = new MessageTool(bus, id => sessions.canReceiveSessionMessage(id),
    id => sessions.getSessionState(id)?.parent, id => sessions.getSessionState(id)?.children,
    (id, input) => sessions.deliver(id, input), (source, target) => sessions.canSendSessionMessage(source, target),
    undefined, undefined, remote)
  const cancel = new CancelTool(sessions, remote, backgroundTasks)
  const reply = new ReplyTool(sessions.yields, sessions.inputs, remote)
  tools.register(subagent); tools.register(message); tools.register(cancel); tools.register(reply)
  const context = (owner = 'web:owner', allowed?: string[], blocked?: string[]): ExecutionContext => {
    const scoped = new SessionTools(tools, workspace, allowed, blocked)
    scoped.setExecutionScope('session', ['task', 'call'])
    return {
      projectId: 'p', sessionId: owner, physicalSessionId: SessionManager.currentPhysicalId(sessions.getSessionState(owner)!),
      messageId: crypto.randomUUID(), toolCallId: crypto.randomUUID(), toolCallName: 'subagent',
      signal: new AbortController().signal, channel: 'web', chatId: 'owner', senderId: 'fixture', tools: scoped,
    }
  }
  const wait = async (taskId: string) => {
    for await (const _event of service.resubscribe({ id: taskId, tenant: '' }, new ServerCallContext({
      user: { isAuthenticated: true, userName: 'test' }, requestedVersion: '1.0',
    }))) { /* Wait for terminal state or requested input. */ }
  }
  return {
    subagent, message, cancel, reply, remote, context, sessions, journal, inbound, service, client,
    config, outboundPath, agentTypes, store, wait, localEntered, backgroundTasks, notifications, workspace,
    blockLocal: () => { blockLocal = true },
    async close() {
      await client.close()
      await service.close()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await sessions.stop()
      await handoffManager.stop()
      await backgroundTasks.stop()
      await events.stop()
      await agentTypes.stopWatching()
      bus.stopAll()
      await store.close?.()
      scope.close()
    },
  }
}

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`unified remote discovery, delegation, VFS and messaging preserve references (${storage})`, async () => {
    await withTempWorkspace(async root => {
      const texts: string[] = []
      const f = await fixture(root, storage, { async run(_record, message) {
        const text = message.parts.map(part => part.content?.value).join('\n')
        texts.push(text)
        return { status: 'completed', content: `Remote: ${text}` }
      } })
      try {
        const ctx = f.context()
        const agents = createAgentsHandler(f.agentTypes, f.remote)
        assert.match(await agents.read('', ctx), /"name": "a2a:peer"/)
        assert.match(await agents.read('a2a:peer', ctx), /"kind": "remote"/)
        assert.match(await agents.read('general', ctx), /"kind": "local"/)
        const args = { agent_type: 'a2a:peer', description: 'Remote test', task: 'Only this text' }
        const first = JSON.parse(await f.subagent.execute(args, ctx))
        assert.match(first.sessionId, /^remote:/)
        assert.equal(f.sessions.getSessionState(first.sessionId), null, 'No local executable session or workdir is created')
        await f.wait(first.taskId)
        assert.deepEqual(texts, ['Only this text'])
        const views = createSessionsHandler(f.sessions, undefined, f.remote)
        const read = JSON.parse(await views.read(first.sessionId, ctx))
        assert.equal(read.status, 'completed')
        assert.equal(read.result.artifacts[0].parts[0].text, 'Remote: Only this text')
        assert.match(await views.read('', ctx), /Owned remote conversations/)
        assert.ok((await views.list(ctx)).some(entry => entry.name === first.executionId))
        const duplicate = JSON.parse(await f.subagent.execute(args, ctx))
        assert.equal(duplicate.handle, first.handle)
        const nextContext = f.context()
        const nextArgs = { sessionId: first.sessionId, content: 'Follow-up' }
        const second = JSON.parse(await f.message.execute(nextArgs, nextContext))
        await f.wait(second.taskId)
        assert.equal(second.sessionId, first.sessionId)
        assert.equal(second.contextId, first.contextId)
        assert.notEqual(second.executionId, first.executionId)
        assert.equal(JSON.parse(await f.message.execute(nextArgs, nextContext)).handle, second.handle)
        await assert.rejects(f.message.execute({ ...nextArgs, content: 'Different retry' }, nextContext), /different arguments/)
        assert.equal(JSON.parse(await views.read(`${first.sessionId}/executions`, ctx)).length, 2)
        const restored = new A2aStore(f.outboundPath); restored.init()
        const restoredClient = new A2aClientTools('p', f.config, restored)
        try {
          const restoredRemote = new A2aSessions('p', f.config, restored, restoredClient, () => {})
          assert.equal(JSON.parse(await restoredRemote.read(first.sessionId, ctx)).executionId, second.executionId)
          assert.equal(JSON.parse(await restoredRemote.read(first.executionId, ctx)).handle, first.handle)
        } finally { await restoredClient.close() }
        assert.deepEqual(texts, ['Only this text', 'Follow-up'])
      } finally { await f.close() }
    })
  })

  test(`cancel waits for an owned local execution and persists its outcome (${storage})`, async t => {
    await withTempWorkspace(async root => {
      const f = await fixture(root, storage, { async run() { throw new Error('No remote execution expected') } })
      try {
        f.blockLocal()
        const ctx = f.context()
        const spawned = JSON.parse(await f.subagent.execute({ description: 'Local task', task: 'Local input' }, ctx))
        await f.localEntered.promise
        const bg = createBgTasksHandler(f.backgroundTasks, f.sessions, f.remote)
        assert.match(await bg.read(spawned.executionId, ctx), /"mode": "task"/)
        assert.ok((await bg.list(ctx)).some(entry => entry.name === spawned.executionId))
        assert.equal(f.backgroundTasks.listTasks().length, 0, 'No second lifecycle in BackgroundTaskManager')
        await assert.rejects(f.cancel.execute({ executionId: spawned.executionId }, f.context('web:other')), /owner/)
        await assert.rejects(f.cancel.execute({ executionId: 'web:owner' }, ctx), /owner|durable/)
        const cancelled = JSON.parse(await f.cancel.execute({ executionId: spawned.executionId }, ctx))
        assert.equal(cancelled.status, 'cancelled')
        assert.equal((await f.store.getState(spawned.executionId))?.executionStatus, 'cancelled')
        assert.equal(f.sessions.getActiveSession(spawned.executionId), undefined)
        assert.match(await createSessionsHandler(f.sessions).read(spawned.executionId, ctx), /status=cancelled/)
        assert.equal(JSON.parse(await f.cancel.execute({ executionId: spawned.executionId }, ctx)).status, 'cancelled')
        assert.match(await bg.read(spawned.executionId, ctx), /"status": "cancelled"/)
        await t.waitFor(() => assert.equal(f.notifications.filter(type => type === 'subagent-cancelled').length, 1))
      } finally { await f.close() }
    })
  })

  test(`v:bg aggregates owned executions without copying state or widening access (${storage})`, async t => {
    await withTempWorkspace(async root => {
      const f = await fixture(root, storage, { async run() { return { status: 'completed', content: 'Remote result' } } })
      try {
        const ctx = f.context()
        const background = f.backgroundTasks.createDeferredTask({
          kind: 'process', title: 'Own process', sessionId: ctx.sessionId, onCancel: () => {},
        })
        const foreign = f.backgroundTasks.createDeferredTask({ kind: 'tool', title: 'Foreign process', sessionId: 'web:other' })
        f.backgroundTasks.createDeferredTask({ kind: 'tool', title: 'Unbound process' })
        const local = JSON.parse(await f.subagent.execute({ mode: 'call', description: 'Call', task: 'Finish' }, ctx))
        const external = JSON.parse(await f.remote.start('a2a:peer', 'Remote', f.context()))
        await f.wait(external.taskId)
        const view = createBgTasksHandler(f.backgroundTasks, f.sessions, f.remote)
        const bgId = backgroundExecutionId(background.taskId)
        const expected = [bgId, local.executionId, external.executionId].sort()
        assert.deepEqual((await view.list(ctx)).map(entry => entry.name).sort(), expected)
        const names = await view.list(ctx, { content: false })
        assert.deepEqual(names.map(entry => entry.name).sort(), expected)
        assert.ok(names.every(entry => entry.content === ''))
        const vfs = new VirtualFs()
        vfs.mount('v:bg', 'Executions', view.read, view.list)
        const search = new SearchTool(f.workspace, undefined, vfs)
        for (const query of [{ handler: 'glob', path: 'v:bg', query: '**' }, { handler: 'grep', path: 'v:bg', query: 'executionId' }]) {
          const found = await search.execute(query, ctx)
          for (const id of expected) assert.ok(found.includes(`v:bg/${id}`), found)
          assert.ok(!found.includes(foreign.taskId), found)
        }
        assert.deepEqual((await view.list(ctx, { subpath: external.sessionId })).map(entry => entry.name), [external.executionId])
        assert.deepEqual((await view.list(ctx, { subpath: bgId })).map(entry => entry.name), [bgId])
        assert.match(await view.read(local.executionId, ctx), /Local fixture reply/)
        assert.match(await view.read(bgId, ctx), /Own process/)
        assert.match(await view.read(external.executionId, ctx), /Remote result/)
        await assert.rejects(async () => view.read(external.sessionId, ctx), /conversations belong in v:sessions/)
        assert.equal(f.notifications.length, 0, 'Listing and blocking calls never add completion notifications')
        assert.equal(f.sessions.getSessionState(external.sessionId), null)
        assert.equal(f.backgroundTasks.listTasks().length, 3, 'Local and remote executions stay in their original stores')
        assert.deepEqual((await view.list(f.context('web:other'))).map(entry => entry.name), [backgroundExecutionId(foreign.taskId)])
        for (const id of expected) await assert.rejects(async () => view.read(id, f.context('web:other')), /owner/i)
        for (const other of [{ ...ctx, projectId: 'other' }, { ...ctx, sessionId: '' }]) {
          await assert.rejects(async () => view.read('', other), /owning session/)
        }
        await assert.rejects(async () => view.read(background.taskId, ctx), /Execution not found or access denied.*full executionId.*bg:/)
        const continuation = new ContinuationTool(f.backgroundTasks, f.sessions)
        assert.match(await continuation.execute({ executionId: bgId, continuation: 'Next step' }, ctx), /bg:/)
        await assert.rejects(continuation.execute({ executionId: bgId, continuation: 'Steal' }, f.context('web:other')), /owner/)
        await assert.rejects(continuation.execute({ executionId: local.executionId, continuation: 'No new callback' }, ctx), /bg:/)
        const revoked = t.mock.method(f.sessions, 'assertFolderAccess', () => { throw new Error('Folder revoked') })
        await assert.rejects(async () => view.read(bgId, ctx), /Folder revoked/)
        await assert.rejects(f.cancel.execute({ executionId: bgId }, ctx), /Folder revoked/)
        await assert.rejects(continuation.execute({ executionId: bgId, continuation: 'No' }, ctx), /Folder revoked/)
        revoked.mock.restore()
        const aborted = new AbortController()
        aborted.abort(new Error('Turn aborted'))
        await assert.rejects(f.cancel.execute({ executionId: bgId }, { ...ctx, signal: aborted.signal }), /Turn aborted/)
        assert.equal(f.backgroundTasks.listTasks(ctx.sessionId)[0].status, 'running')
        assert.equal(JSON.parse(await f.cancel.execute({ executionId: bgId }, ctx)).status, 'cancelled')
      } finally { await f.close() }
    })
  })

  test(`background downloads return directly readable owner-scoped execution paths (${storage})`, async () => {
    await withTempWorkspace(async root => {
      const f = await fixture(root, storage, { async run() { throw new Error('No remote execution expected') } })
      try {
        const payload = 'synthetic download output'
        const downloader = new Aria2Downloader(async () => {
          await writeFile(join(root, 'fixture.bin.shadow-part'), payload)
        }, () => process.execPath, async () => 'aria2 version 1.37.0\n')
        const tool = new DownloadTool(downloader, 'p', f.backgroundTasks)
        const ctx = f.context()
        const receipt = JSON.parse(await tool.execute({
          action: 'start', directory: root, filename: 'fixture.bin', url: 'https://example.org/fixture.bin',
          sha256: createHash('sha256').update(payload).digest('hex'), approved: true,
        }, ctx))
        assert.match(receipt.executionId, /^bg:[a-f0-9]{16}$/)
        assert.equal(receipt.outputPath, `v:bg/${receipt.executionId}`)
        const view = createBgTasksHandler(f.backgroundTasks, f.sessions, f.remote)
        const vfs = new VirtualFs()
        vfs.mount('v:bg', 'Executions', view.read, view.list)
        assert.match((await vfs.resolve(receipt.outputPath, ctx))!, /Execution ID: bg:/)
        await f.backgroundTasks.awaitTask(receipt.taskId, 2000)
        assert.match((await vfs.resolve(receipt.outputPath, ctx))!, /Status: completed/)
        await assert.rejects(async () => vfs.resolve(`v:bg/${receipt.taskId}`, ctx), /full executionId.*bg:/)
        await assert.rejects(async () => vfs.resolve(receipt.outputPath, f.context('web:other')), /owner/)
        await assert.rejects(async () => vfs.resolve(receipt.outputPath, { ...ctx, projectId: 'other' }), /owning session/)
        const cancelled = JSON.parse(await f.cancel.execute({ executionId: receipt.executionId }, ctx))
        assert.equal(cancelled.status, 'completed', 'Cancel preserves an already-completed transfer')
      } finally { await f.close() }
    })
  })

  test(`in-flight calls are visible in v:bg but still return through the original invocation (${storage})`, async () => {
    await withTempWorkspace(async root => {
      const f = await fixture(root, storage, { async run() { throw new Error('Not remote') } })
      try {
        f.blockLocal()
        const ctx = f.context()
        let returned = false
        const pending = f.subagent.execute({ mode: 'call', description: 'Blocking', task: 'Wait' }, ctx)
          .then(value => { returned = true; return JSON.parse(value) })
        await f.localEntered.promise
        const view = createBgTasksHandler(f.backgroundTasks, f.sessions, f.remote)
        const entries = await view.list(ctx)
        assert.equal(entries.length, 1)
        assert.equal(JSON.parse(entries[0].content).mode, 'call')
        assert.equal(returned, false)
        const receipt = JSON.parse(await f.cancel.execute({ executionId: entries[0].name }, ctx))
        assert.equal(receipt.status, 'cancelled')
        const result = await pending
        assert.equal(result.executionId, entries[0].name)
        assert.equal(result.status, 'cancelled')
        assert.equal(f.notifications.length, 0)
      } finally { await f.close() }
    })
  })

  test(`concurrent messages cannot admit a second task into an active remote context (${storage})`, async () => {
    await withTempWorkspace(async root => {
      let runs = 0
      const f = await fixture(root, storage, { async run(_record, _message, _signal, interaction) {
        if (++runs === 1) return { status: 'completed', content: 'Ready' }
        return { status: 'completed', content: await interaction.ask('Pending input') }
      } })
      try {
        const ctx = f.context()
        const first = JSON.parse(await f.remote.start('a2a:peer', 'Start', ctx))
        await f.wait(first.taskId)
        await f.remote.read(first.sessionId, ctx)
        const results = await Promise.allSettled([
          f.remote.message(first.sessionId, 'One', f.context()),
          f.remote.message(first.sessionId, 'Two', f.context()),
        ])
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
        assert.equal(results.filter(result => result.status === 'rejected').length, 1)
        assert.equal(f.journal.outbound.size, 2, 'Rejected concurrency must not leave an uncertain duplicate submission')
        assert.equal(runs, 2)
        await assert.rejects(f.client.call('a2a_send', {
          agent: 'peer', message: 'Reuse stale handle', context: first.handle,
        }, f.context()), /still active/)
      } finally { await f.close() }
    })
  })

  test(`cancel preserves a completed local call instead of relabelling it (${storage})`, async () => {
    await withTempWorkspace(async root => {
      const f = await fixture(root, storage, { async run() { throw new Error('No remote execution expected') } })
      try {
        const ctx = f.context()
        const completed = JSON.parse(await f.subagent.execute({
          mode: 'call', description: 'Completed call', task: 'Return immediately',
        }, ctx))
        assert.equal(completed.status, 'completed')
        assert.equal(JSON.parse(await f.cancel.execute({ executionId: completed.executionId }, ctx)).status, 'completed')
        assert.equal((await f.store.getState(completed.executionId))?.executionStatus, 'completed')
      } finally { await f.close() }
    })
  })

  test(`lost remote responses remain discoverable and never cause automatic resubmission (${storage})`, async t => {
    await withTempWorkspace(async root => {
      let runs = 0
      const f = await fixture(root, storage, { async run() {
        runs++
        return { status: 'completed', content: 'Side effect occurred' }
      } })
      const nativeFetch = globalThis.fetch
      const fetchMock = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await nativeFetch(...args)
        if (args[1]?.method === 'POST') {
          await response.arrayBuffer()
          throw new Error('Synthetic lost response')
        }

        return response
      })
      const errors = t.mock.method(console, 'error', () => {})
      try {
        const ctx = f.context()
        await assert.rejects(f.remote.start('a2a:peer', 'One effect', ctx), /outcome is unknown/)
        assert.ok(errors.mock.callCount() > 0, 'Unknown delivery is logged explicitly')
        const entries = f.remote.entries(ctx)
        const sessionId = entries.find(entry => !entry.name.includes('/'))!.name
        const snapshot = JSON.parse(await f.remote.read(sessionId, ctx))
        assert.equal(snapshot.status, 'uncertain')
        assert.equal(snapshot.taskId, undefined)
        assert.equal(JSON.parse(await f.remote.start('a2a:peer', 'One effect', ctx)).status, 'uncertain')
        await assert.rejects(f.remote.message(sessionId, 'More work', f.context()), /uncertain/)
        await assert.rejects(f.remote.cancel(snapshot.executionId, ctx), /No remote task ID/)
        assert.equal(runs, 1)
      } finally {
        fetchMock.mock.restore()
        errors.mock.restore()
        await f.close()
      }
    })
  })

  test(`legacy outbound records remain readable and continuable after restart (${storage})`, async () => {
    await withTempWorkspace(async root => {
      const f = await fixture(root, storage, { async run() { return { status: 'completed', content: 'Legacy' } } })
      try {
        const ctx = f.context()
        const first = JSON.parse(await f.remote.start('a2a:peer', 'Legacy task', ctx))
        await f.wait(first.taskId)
        await f.remote.read(first.sessionId, ctx)
        const legacy = structuredClone(f.journal.outbound.get(first.handle)!)
        delete legacy.conversationId
        delete legacy.previous
        f.journal.saveCall(legacy)
        const restored = new A2aStore(f.outboundPath); restored.init()
        const client = new A2aClientTools('p', f.config, restored)
        try {
          const remote = new A2aSessions('p', f.config, restored, client, () => {})
          assert.equal(JSON.parse(await remote.read(first.sessionId, ctx)).status, 'completed')
          const next = JSON.parse(await remote.message(first.sessionId, 'Continue', f.context()))
          assert.equal(next.sessionId, first.sessionId)
          assert.equal(next.contextId, first.contextId)
        } finally { await client.close() }
      } finally { await f.close() }
    })
  })
}

test('cancel really terminates owned background shell processes for immediate and timed-out exec', async t => {
  await withTempWorkspace(async root => {
    const f = await fixture(root, 'jsonl', { async run() { throw new Error('Not remote') } })
    const processes = new ProcessManager()
    try {
      const exec = new ExecTool(f.workspace, 120000, new CommandHandlerManager(), processes, defaultManagedShell(), f.backgroundTasks)
      const view = createBgTasksHandler(f.backgroundTasks, f.sessions, f.remote)
      for (const timeout_ms of [0, 1]) {
        const ctx = f.context()
        const result = requireToolText(await exec.execute({
          script: 'node -e "console.log(\'ready\'); setInterval(()=>{},1000)"', timeout_ms,
        }, ctx))
        const executionId = /Execution ID: (bg:[a-f0-9]{16})/.exec(result)?.[1]
        assert.ok(executionId, result)
        const pid = Number(/PID=(\d+)/.exec(result)?.[1])
        assert.ok(processes.get(pid)?.isolated, 'POSIX background processes need a dedicated cancellation group')
        await t.waitFor(async () => assert.match(await view.read(executionId, ctx), /ready/), { timeout: 10000 })
        assert.equal(JSON.parse(await f.cancel.execute({ executionId }, ctx)).status, 'cancelled')
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
        assert.match(await view.read(executionId, ctx), /Status: cancelled/)
        assert.equal(f.notifications.length, 0)
      }
    } finally {
      for (const managed of processes.list()) await processes.terminate(managed)
      await f.close()
    }
  })
})

test('unified remote access preserves ownership, grants and local-only argument boundaries', async () => {
  await withTempWorkspace(async root => {
    const f = await fixture(root, 'jsonl', { async run() { return { status: 'completed', content: 'ok' } } })
    try {
      const ctx = f.context()
      const args = { agent_type: 'a2a:peer', description: 'Remote', task: 'Text' }
      await assert.rejects(f.subagent.execute(args, f.context('web:owner', ['subagent'])), /permission/)
      await assert.rejects(f.subagent.execute(args, f.context('web:owner', undefined, ['a2a_send'])), /permission/)
      await assert.rejects(f.subagent.execute({ ...args, mode: 'call' }, ctx), /task mode/)
      for (const extra of [{ report_to: 'web:other' }, { initiative_id: 'work' }, { preload_tools: {} }]) {
        await assert.rejects(f.subagent.execute({ ...args, ...extra }, ctx), /only agent_type/)
      }
      const first = JSON.parse(await f.subagent.execute(args, ctx))
      await f.wait(first.taskId)
      await assert.rejects(f.remote.read(first.sessionId, f.context('web:other')), /Unknown remote session/)
      await assert.rejects(f.remote.read(first.sessionId, { ...ctx, projectId: 'foreign' }), /Project/)
      await assert.rejects(f.remote.read(first.sessionId, {
        ...ctx, remoteWorkdir: {
          nodeId: 'child', capabilityId: 'folder',
          executor: {
            async *execute() { throw new Error('Remote execution must not be reached') },
            async getStatus() { throw new Error('Remote status must not be reached') },
            async cancel() { throw new Error('Remote cancellation must not be reached') },
          },
        },
      }), /remote workdirs/)
      assert.equal(f.remote.entries(f.context('web:other')).length, 0)
      for (const extra of [{ silent: true }, { silent: false }, { intent: 'request' }, { initiativeId: 'work' }]) {
        await assert.rejects(f.message.execute({ sessionId: first.sessionId, content: 'Text', ...extra }, f.context()), /only sessionId/)
      }
      await assert.rejects(f.cancel.execute({ executionId: first.sessionId }, ctx), /executionId/)
      await assert.rejects(f.remote.cancel(first.executionId, f.context('web:other')), /Unknown remote/)
      const callContext = f.context()
      callContext.tools.setExecutionScope('call', [])
      await assert.rejects(f.remote.read(first.sessionId, callContext), /Leaf calls/)
      assert.match(await f.cancel.execute({ executionId: first.executionId }, callContext), /Blocked/)
      const restricted = f.context('web:owner', ['read', 'search'])
      assert.doesNotMatch(await createAgentsHandler(f.agentTypes, f.remote).read('', restricted), /a2a:peer/)
      const views = createSessionsHandler(f.sessions, undefined, f.remote)
      assert.doesNotMatch(await views.read('', restricted), /remote:/)
      await assert.rejects(Promise.resolve().then(() => views.read(first.sessionId, restricted)), /permission/)
    } finally { await f.close() }
  })

})

test('remote messages enforce the outbound work guard without exporting work context', async () => {
  await withTempWorkspace(async root => {
    const texts: string[] = []
    const f = await fixture(root, 'jsonl', { async run(_record, message) {
      texts.push(message.parts.map(part => part.content?.value).join('\n'))
      return { status: 'completed', content: 'Done' }
    } })
    try {
      const ctx = f.context()
      const first = JSON.parse(await f.remote.start('a2a:peer', 'First', ctx))
      await f.wait(first.taskId)
      await f.remote.read(first.sessionId, ctx)
      const blocked = f.context()
      blocked.tools.setWorkGuard({
        snapshot: () => [], prompt: () => '', current: () => false,
        before(tool) {
          assert.equal(tool.name, 'a2a_send')
          throw new Error('Synthetic work basis changed')
        },
      })
      await assert.rejects(f.message.execute({ sessionId: first.sessionId, content: 'Blocked' }, blocked), /work basis changed/)
      assert.equal(f.journal.outbound.size, 1)
      const allowed = f.context()
      let finished = 0
      allowed.tools.setWorkGuard({
        snapshot: () => [], prompt: () => '', current: () => true,
        before(tool, args) {
          assert.equal(tool.name, 'a2a_send')
          assert.deepEqual(args, { agent: 'peer', message: 'Authorized text', context: first.handle })
          return { finish(failed) { assert.equal(failed, false); finished++; return 'STALE WORK RESULT' } }
        },
      })
      const next = JSON.parse(await f.message.execute({
        sessionId: first.sessionId, content: 'Authorized text',
      }, allowed))
      assert.equal(next.notice, 'STALE WORK RESULT')
      assert.equal(finished, 1)
      await f.wait(next.taskId)
      assert.deepEqual(texts, ['First', 'Authorized text'])
      f.config.agents.peer.endpointUrl += '/changed'
      await assert.rejects(f.remote.message(first.sessionId, 'Changed endpoint', f.context()), /configuration changed/)
    } finally { await f.close() }
  })
})

test('remote requested input remains explicit, reply handles preserve the conversation, and execution cancel is scoped', async t => {
  await withTempWorkspace(async root => {
    const f = await fixture(root, 'jsonl', { async run(_record, _message, signal, interaction) {
      const answer = await interaction.ask('Which language?')
      signal.throwIfAborted()
      return { status: 'completed', content: answer }
    } })
    try {
      const ctx = f.context()
      const first = JSON.parse(await f.remote.start('a2a:peer', 'Ask', ctx))
      await f.wait(first.taskId)
      const waiting = JSON.parse(await f.remote.read(first.sessionId, ctx))
      assert.equal(waiting.status, 'input-required')
      assert.equal(waiting.request.kind, 'input')
      assert.match(waiting.request.request_id, /^remote:.*\/input\//)
      await assert.rejects(f.message.execute({ sessionId: first.sessionId, content: 'TypeScript' }, f.context()), /reply/)
      const args = { request_id: waiting.request.request_id, text: 'TypeScript' }
      await assert.rejects(f.reply.execute(args, f.context('web:other')), /owner/)
      await assert.rejects(f.reply.execute({ ...args, request_id: args.request_id.replace(/.$/, 'z') }, f.context()))
      const guarded = f.context()
      const guard = t.mock.method(guarded.tools, 'getWorkGuard', () => ({
        current: () => false,
        before: () => { throw new Error('Outbound work is blocked') },
      }))
      await assert.rejects(f.reply.execute(args, guarded), /Outbound work is blocked/)
      guarded.workStamps = [{ key: 'topic:web:owner', revision: 1 }]
      await assert.rejects(f.reply.execute(args, guarded), /Work basis changed/)
      assert.equal(f.journal.outbound.size, 1, 'Denied replies cannot reserve or send another execution')
      guard.mock.restore()
      const replyContext = f.context()
      const reply = JSON.parse(await f.reply.execute(args, replyContext))
      await f.wait(reply.taskId)
      assert.equal(reply.sessionId, first.sessionId)
      assert.equal(reply.taskId, first.taskId)
      assert.notEqual(reply.handle, first.handle)
      assert.equal(JSON.parse(await f.reply.execute(args, replyContext)).handle, reply.handle)
      await assert.rejects(f.reply.execute(args, f.context()), /already has a reply/)
      assert.equal(JSON.parse(await f.remote.read(first.sessionId, ctx)).handle, reply.handle)
      const second = JSON.parse(await f.message.execute({ sessionId: first.sessionId, content: 'Ask again' }, f.context()))
      await f.wait(second.taskId)
      assert.equal(JSON.parse(await f.cancel.execute({ executionId: second.executionId }, ctx)).status, 'cancelled')
      assert.equal(JSON.parse(await f.remote.read(first.sessionId, ctx)).status, 'cancelled')
    } finally { await f.close() }
  })
})
