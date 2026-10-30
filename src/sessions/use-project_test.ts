import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { folderIdentifier, selectFolder } from '../folders/identifier.ts'
import { UseProjectTool } from '../tools/use-project.ts'
import { ExecTool } from '../tools/shell.ts'
import { CommandHandlerManager } from '../tools/shell-commands/command-handler.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { defaultManagedShell } from '../execution/processes/shells.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import { ReadTool } from '../tools/read.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { ChatMessage, LLMProvider } from '../providers/provider.ts'
import { BaseSession } from './base-session.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState } from './session-store.ts'
import { isRuntimeContextEvent } from './runtime-context-event.ts'

class SwitchingSession extends BaseSession {
  input() { return this.appendMessages({ model: 'test', temperature: 0, contextWindow: 100000 }, { role: 'user', content: 'Actual user' }) }
  run() {
    const signal = new AbortController().signal
    const ctx: ExecutionContext = { projectId: 'test-project', sessionId: this.id, physicalSessionId: this.physicalSessionId,
      channel: 'web', chatId: 'test', senderId: 'owner', messageId: 'test', tools: this.tools, signal }
    return this.runLlmLoop(ctx, { model: 'test', temperature: 0, contextWindow: 100000 }, signal)
  }
}

test('human-readable selectors are stable across ordering and growth, with collision rejection and full ID fallback', () => {
  const a = { id: '12345678-1234-4123-8123-123456789abc', name: 'App' }
  const b = { id: '87654321-1234-4123-8123-123456789abd', name: 'Docs' }
  assert.equal(folderIdentifier(a.id, a.name), 'app-12345678')
  assert.equal(selectFolder([b, a], 'app'), a)
  const duplicate = { ...b, name: 'App' }
  assert.throws(() => selectFolder([a, duplicate], 'app'), /ambiguous/)
  assert.equal(selectFolder([duplicate, a], folderIdentifier(a.id, a.name)), a)
  const colliding = { ...a, id: '12345678-0000-4000-8000-000000000000' }
  assert.throws(() => selectFolder([a, colliding], 'app-12345678'), /ambiguous/)
  assert.equal(selectFolder([a, colliding], a.id), a)
  assert.equal(selectFolder([b, a], folderIdentifier(a.id)), a)
  assert.equal(selectFolder([a, b], a.id), a)
  assert.notEqual(folderIdentifier(a.id), folderIdentifier(b.id))
  assert.throws(() => selectFolder([a], '$alias/path'), /Unknown/)
  assert.throws(() => selectFolder([a, a], a.id), /ambiguous/)
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: sole switch commits folder/cwd, relative reads, events and restored state together`, async () => {
    await withTempWorkspace(async home => {
      const folders = new FolderRegistry(home)
      await folders.init()
      for (const name of ['a', 'b']) {
        await mkdir(join(home, name))
        await writeFile(join(home, name, 'value.txt'), name)
        await writeFile(join(home, name, 'AGENTS.md'), `Instructions ${name}`)
      }
      const a = await folders.register(join(home, 'a')), b = await folders.register(join(home, 'b'))
      const store = new Store(join(home, 'sessions')); await store.init()
      let closed = false
      const state: SessionState = { projectId: 'test-project', sessionId: 'web:switch', segmentIndex: 0, physicalIdVersion: 2, mode: 'session' }
      await store.saveState(state.sessionId, state)
      const bus = new Bus(), changes: string[] = []
      bus.on('session.changed', e => { changes.push(e.sessionId) })
      const base = new Tools(home)
      base.register(new UseProjectTool({ projectId: 'test-project', folders }))
      base.register(new ReadTool(home))
      base.register(new ExecTool(home, 10000, new CommandHandlerManager(), new ProcessManager(), defaultManagedShell(), {} as BackgroundTaskManager))
      const tools = new SessionTools(base, home)
      const requests: ChatMessage[][] = []
      const calls = [
        [{ id: 'a', name: 'use_project', arguments: { folder: folderIdentifier(a.id) } }],
        [{ id: 'read-a', name: 'read', arguments: { path: 'value.txt' } }],
        [{ id: 'bad', name: 'use_project', arguments: { folder: 'missing' } }],
        [{ id: 'parallel', name: 'use_project', arguments: { folder: b.id } }, { id: 'parallel-read', name: 'read', arguments: { path: 'value.txt' } }],
        [{ id: 'b', name: 'use_project', arguments: { folder: b.id } }],
        [{ id: 'read-b', name: 'read', arguments: { path: 'value.txt' } }],
        [{ id: 'exec-b', name: 'exec', arguments: { script: `"${process.execPath}" -e "console.log(process.cwd());console.log(require('fs').readFileSync('value.txt','utf8'))"`, timeout_ms: 10000 } }],
      ]
      const provider: LLMProvider = { name: 'test', listModels: () => [], chat: async messages => {
        if ([3, 4].includes(requests.length)) assert.equal(state.folderId, a.id, 'failed and parallel switches preserve selection')
        requests.push(structuredClone(messages))
        assert.equal(messages[0]?.content, 'Unchanged system policy')
        return { content: '', toolCalls: calls[requests.length - 1] ?? [] }
      } }
      try {
        const session = new SwitchingSession(home, state.sessionId, state, [{ role: 'system', content: 'Unchanged system policy' }], provider, tools, bus, store, ref => folders.lookupWorkdir(ref) ?? { node: 'missing' })
        await session.input()
        assert(isRuntimeContextEvent(session.history[1]!))
        assert.equal(session.history[2]?.content, 'Actual user')
        await session.input()
        assert.equal(session.history.filter(isRuntimeContextEvent).length, 1, 'Repeated input deduplicates initial snapshot')
        await session.run()
        const result = (id: string) => session.history.find(m => m.tool_call_id === id)?.content as string
        assert.match(result('a'), /Working context committed/)
        assert.doesNotMatch(result('a'), /Instructions a/)
        assert(JSON.stringify(session.history).includes('Instructions a'))
        assert.doesNotMatch(result('a'), /Project instructions|Discoverable skills|available_skills|Unchanged system policy/)
        assert.match(state.workingContext!, /Selected-folder skills/)
        assert.match(state.workingContext!, /supersedes the old default/)
        assert.equal(result('read-a'), 'a')
        assert.match(result('bad'), /Unknown/)
        assert.match(result('parallel'), /sole direct top-level/)
        assert.match(result('parallel-read'), /a/)
        assert.equal(result('read-b'), 'b')
        assert(result('exec-b').includes(b.path))
        assert.equal(state.folderId, b.id)
        assert.deepEqual(changes, [state.sessionId, state.sessionId])
        assert.equal(session.history.filter(isRuntimeContextEvent).length, 3)
        for (const id of ['a', 'b']) {
          const index = session.history.findIndex(m => m.tool_call_id === id)
          assert(isRuntimeContextEvent(session.history[index + 1]!))
        }
        const restored = await store.getState(state.sessionId)
        assert.equal(restored?.folderId, b.id)
        assert.equal(restored?.workdir?.workdirId, `local-project-v1:${b.id}`)
        assert.equal(restored?.workingContext, state.workingContext)
        assert.equal((await store.listSessions())[0]?.folderId, b.id, 'UI list uses committed folder')
        // A failed commit must leave the live state and emitted selector unchanged.
        const previous = structuredClone(state)
        const original = store.saveState.bind(store)
        store.saveState = async () => { throw new Error('synthetic save failure') }
        calls.push([], [{ id: 'failed-save', name: 'use_project', arguments: { folder: a.id } }])
        await session.run()
        assert.match(result('failed-save'), /synthetic save failure/)
        assert.deepEqual({ ...state, lastActivityAt: undefined }, { ...previous, lastActivityAt: undefined })
        assert.deepEqual(changes, [state.sessionId, state.sessionId])
        store.saveState = original
        store.close?.(); closed = true
        const reopened = new Store(join(home, 'sessions')); await reopened.init()
        try {
          const recovered = await reopened.getState(state.sessionId)
          assert.equal(recovered?.workingContext, state.workingContext)
          const replay = new SwitchingSession(home, state.sessionId, recovered!, [{ role: 'system', content: 'Unchanged system policy' }],
            { name: 'recovery', listModels: () => [], chat: async messages => {
              assert.equal(messages.filter(isRuntimeContextEvent).length, 1, 'commit is replayable even without its original context event')
              assert(JSON.stringify(messages).includes('Instructions b'))
              return { content: 'Recovered', toolCalls: [] }
            } }, tools, bus, reopened, ref => folders.lookupWorkdir(ref) ?? { node: 'missing' })
          await replay.run()
        } finally { reopened.close?.() }
      } finally { if (!closed) store.close?.(); bus.stopAll() }
    })
  })
}

test('remote, unavailable and nested switch fail before committing', async () => {
  const context = { projectId: 'p', toolCallName: 'use_project', signal: new AbortController().signal,
    switchProjectFolder: async () => { throw new Error('must not commit') } } as unknown as ExecutionContext
  const remote = { path: 'C:\\DO-NOT-READ', identity: { version: 1 as const, rootId: 'a'.repeat(64), ancestorIds: [] }, id: 'remote', kind: 'remote' as const, name: 'remote', createdAt: '', projectId: 'p',
    workdir: { version: 2 as const, nodeId: 'child', workdirId: 'repo', displayPathSnapshot: 'C:\\DO-NOT-READ' } }
  const tool = new UseProjectTool({ projectId: 'p', folders: { list: () => [remote], requireAvailable: async () => remote, requireExecutionAvailable: async () => remote, acquireAccess: () => () => {} } })
  await assert.rejects(tool.execute({ folder: 'remote' }, context), /Remote folder switching is unavailable/)
  await assert.rejects(tool.execute({ folder: 'remote' }, { ...context, scriptInvocation: true }), /sole direct/)
  await assert.rejects(tool.execute({ folder: 'remote' }, { ...context, projectId: 'foreign' }), /mismatch/)
})


test('unavailable folder and unreadable root instructions never reach the commit boundary', async () => {
  await withTempWorkspace(async home => {
    const folders = new FolderRegistry(home); await folders.init()
    await mkdir(join(home, 'repo'))
    const folder = await folders.register(join(home, 'repo'))
    const tool = new UseProjectTool({ projectId: 'p', folders })
    let commits = 0
    const ctx = { projectId: 'p', toolCallName: 'use_project', signal: new AbortController().signal,
      switchProjectFolder: async () => { commits++; return 'committed' } } as unknown as ExecutionContext
    await mkdir(join(home, 'repo', 'AGENTS.md'))
    await assert.rejects(tool.execute({ folder: folder.id }, ctx))
    assert.equal(commits, 0)
    const { rm } = await import('node:fs/promises')
    await rm(join(home, 'repo'), { recursive: true })
    await assert.rejects(tool.execute({ folder: folder.id }, ctx), /unavailable/)
    assert.equal(commits, 0)
  })
})
