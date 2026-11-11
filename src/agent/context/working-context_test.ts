import { BaseSession } from '../../sessions/base-session.ts'
import { Bus } from '../../bus/bus.ts'
import { SessionTools, Tools } from '../../tools/registry.ts'
import { JsonlSessionStore } from '../../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../../sessions/session-store-sqlite.ts'
import { discoverFolderMcp, FolderMcpDiscoveryError } from '../../mcp/folder.ts'
import { McpConnection } from '../../mcp/client.ts'
import type { SessionState } from '../../sessions/session-store.ts'
import type { SessionInput } from '../../sessions/input.ts'
import { isRuntimeContextEvent } from '../../sessions/runtime-context-event.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { FolderRegistry } from '../../folders/registry.ts'
import { localFolderWorkdirRef } from '../../sessions/locality.ts'
import { prepareWorkingContext } from './working-context.ts'
import { UseProjectTool } from '../../tools/use-project.ts'
import type { ExecutionContext } from '../../tools/context.ts'

test('initial local instructions and discovery use exactly the switch preparation path', async () => {
  await withTempWorkspace(async home => {
    const root = join(home, 'repo')
    await mkdir(root)
    await writeFile(join(root, 'AGENTS.md'), 'Scoped root rules')
    const folders = new FolderRegistry(home); await folders.init()
    const folder = await folders.register(root)
    const workdir = { available: true as const, locality: 'local' as const, path: root, workdir: localFolderWorkdirRef(folder.id) }
    const initial = await prepareWorkingContext(workdir, folder.id, folder)
    let switched = ''
    const tool = new UseProjectTool({ projectId: 'p', folders })
    await tool.execute({ folder: folder.id }, {
      projectId: 'p', toolCallName: 'workspace_use', signal: new AbortController().signal,
      switchProjectFolder: async (prepared: { content: string }) => { switched = prepared.content; return 'receipt' },
    } as unknown as ExecutionContext)
    assert.equal(initial, switched)
    assert.match(initial, /^# Working context snapshot\n- Selected Project workspace: .*\n- Default cwd: .*\n\nThis committed/m)
    assert.match(initial, /- Source: .*\n- Scope: this folder and descendants only\./)
    assert.doesNotMatch(initial, /directory resources|registered resource/)
    assert.match(initial, /Scoped root rules/)
    assert(initial.includes(join(root, 'AGENTS.md').replaceAll('\\', '\\\\')))
    assert.match(initial, /descendants only/)
    assert.match(initial, /Selected-folder skills/)
    assert.match(initial, /MCP/)
  })
})

test('no-folder, unknown metadata, remote and unavailable snapshots do not read metadata paths', async () => {
  const remote = { version: 2 as const, nodeId: 'child', workdirId: 'repo', displayPathSnapshot: 'DO-NOT-READ' }
  const folder = { id: 'f', name: 'repo', path: '\u0000invalid-main-path', createdAt: '', projectId: 'p' }
  for (const workdir of [
    { available: true as const, locality: 'remote' as const, workdir: remote },
    { available: false as const, reason: 'node-missing' as const, workdir: remote },
  ]) {
    const content = await prepareWorkingContext(workdir, folder.id, folder)
    assert(!content.includes('DO-NOT-READ'))
    assert.doesNotMatch(content, /Applicable workspace instructions/)
    assert.match(content, /remote|unavailable/)
  }
  const local = { available: true as const, locality: 'local' as const, path: '/effective', workdir: localFolderWorkdirRef('f') }
  const unselected = await prepareWorkingContext(local)
  assert.match(unselected, /Selected Project workspace: none/)
  assert.match(unselected, /use session data for working files/)
  assert.match(unselected, /Only when the requested outcome includes a final local file/)
  assert.match(unselected, /Do not create a delivery folder when the requested outcome does not require local files/)
  assert.doesNotMatch(unselected, /Without a selected Workspace, save finished deliverables/)
  const unknown = await prepareWorkingContext(local, 'unknown')
  assert.match(unknown, /"id":"unknown"/)
  assert.doesNotMatch(unknown, /Applicable workspace instructions|"name"/)
})


class AdmissionSession extends BaseSession {
  admit(input: SessionInput) {
    return this.processInput(input, { model: 'test', temperature: 0, contextWindow: 100000 }, new AbortController().signal)
  }
}

test('bounded host work-organizer skips folder preparation and snapshot publication; normal tasks/calls retain it', async t => {
  await withTempWorkspace(async home => {
    const store = new JsonlSessionStore(join(home, 'sessions')); await store.init()
    const bus = new Bus()
    try {
      for (const kind of ['bounded', 'task', 'call'] as const) {
        const id = kind === 'bounded' ? 'work-organizer:fixture' : `web:${kind}`
        const state: SessionState = { sessionId: id, segmentIndex: 0, mode: kind === 'call' ? 'call' : 'task',
          agentType: kind === 'bounded' ? 'work-organizer' : 'general', folderId: 'selected' }
        const tools = new SessionTools(new Tools(home), home)
        const prepare = t.mock.method(tools, 'workingContextFolder', () => {
          assert.notEqual(kind, 'bounded', 'bounded task must not even discover its folder')
          return undefined
        })
        let inferred = false
        const session = new AdmissionSession(home, id, state, [{ role: 'system', content: 'Bounded or normal policy' }], {
          name: 'test', listModels: () => [], chat: async messages => {
            inferred = true
            const events = messages.filter(isRuntimeContextEvent)
            assert.equal(events.length, kind === 'bounded' ? 0 : 1)
            if (kind === 'bounded') assert.doesNotMatch(JSON.stringify(messages), /working-context|Default cwd|AGENTS|Selected-folder skills|MCP/)
            else {
              assert(JSON.stringify(events).includes('Default cwd'))
              assert(messages.indexOf(events[0]!) < messages.findIndex(m => JSON.stringify(m.content).includes('Actual task')))
            }
            return { content: 'Done', toolCalls: [] }
          },
        }, tools, bus, store)
        const result = await session.admit({ kind: 'message', id: `input-${kind}`, timestamp: new Date().toISOString(), policy: 'queue',
          source: { kind: 'user', sender: { senderId: 'owner', admin: true, channel: kind === 'bounded' ? 'work-organizer' : 'web', chatId: kind, messageId: `input-${kind}` } }, content: 'Actual task' })
        assert.equal(result?.status, 'completed')
        assert(inferred)
        assert.equal(prepare.mock.callCount(), kind === 'bounded' ? 0 : 1)
        assert.equal(state.workingContext === undefined, kind === 'bounded')
      }
    } finally { store.close?.(); bus.stopAll() }
  })
})

for (const file of ['.mcp.json', '.vscode/mcp.json']) {
  for (const failure of ['malformed', 'schema', 'oversized', 'unreadable'] as const) {
    test(`${file}: ${failure} MCP declaration warns without blocking context or workspace switch`, async t => {
      await withTempWorkspace(async home => {
        const root = join(home, 'repo')
        await mkdir(join(root, '.vscode'), { recursive: true })
        await writeFile(join(root, 'AGENTS.md'), 'Scoped root rules still apply')
        if (failure === 'unreadable') await mkdir(join(root, file))
        else await writeFile(join(root, file), failure === 'malformed' ? '{"secret":"private-value", invalid}'
          : failure === 'oversized' ? 'private-value'.repeat(11_000)
          : JSON.stringify({ [file === '.mcp.json' ? 'mcpServers' : 'servers']: { broken: { type: 'unsupported', env: { TOKEN: 'private-value' } } } }))
        const folders = new FolderRegistry(home); await folders.init()
        const folder = await folders.register(root)
        const workdir = { available: true as const, locality: 'local' as const, path: root, workdir: localFolderWorkdirRef(folder.id) }
        const connect = t.mock.method(McpConnection.prototype, 'connect', async () => { throw new Error('Must not connect during context preparation') })
        const initial = await prepareWorkingContext(workdir, folder.id, folder)
        assert.match(initial, /Scoped root rules still apply/)
        assert.match(initial, /Warning: (Invalid|Cannot read) folder MCP declaration/)
        assert.match(initial, /Selected-folder MCP sources are unavailable/)
        assert.doesNotMatch(initial, /private-value|No supported folder MCP declarations/)
        assert(initial.includes(file))
        let switched = ''
        const tool = new UseProjectTool({ projectId: 'p', folders })
        await tool.execute({ workspace: folder.id }, {
          projectId: 'p', toolCallName: 'workspace_use', signal: new AbortController().signal,
          switchProjectFolder: async (prepared: { content: string }) => { switched = prepared.content; return 'receipt' },
        } as unknown as ExecutionContext)
        assert.equal(switched, initial)
        // Tolerant context preparation is not permission to load an invalid integration.
        await assert.rejects(discoverFolderMcp(folder), error => error instanceof FolderMcpDiscoveryError && !error.message.includes('private-value'))
        assert.equal(connect.mock.callCount(), 0)
      })
    })
  }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  for (const source of ['user', 'session'] as const) {
    test(`${Store.name}: first ${source} input is persisted and processed despite invalid folder MCP`, async t => {
      await withTempWorkspace(async home => {
        const root = join(home, 'repo'); await mkdir(root)
        await writeFile(join(root, 'AGENTS.md'), 'Scoped root rules still apply')
        // Reproduces the incompatible transport alias that blocked the reported peer session.
        await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'private-value' } } } }))
        const folders = new FolderRegistry(home); await folders.init()
        const folder = await folders.register(root)
        const store = new Store(join(home, 'sessions')); await store.init()
        const bus = new Bus()
        try {
          const tools = new Tools(home)
          tools.register(new UseProjectTool({ projectId: 'p', folders }))
          const connect = t.mock.method(McpConnection.prototype, 'connect', async () => { throw new Error('Must not connect during startup') })
          const id = 'web:mcp-startup'
          const state: SessionState = { sessionId: id, segmentIndex: 0, mode: 'session', folderId: folder.id, workdir: localFolderWorkdirRef(folder.id) }
          let providerCalls = 0, persisted = 0
          const appended: string[] = []
          bus.on('session.message.appended', event => { appended.push(JSON.stringify(event.message)) })
          const session = new AdmissionSession(home, id, state, [{ role: 'system', content: 'Fixture policy' }], {
            name: 'test', listModels: () => [], chat: async messages => {
              providerCalls++
              assert.equal(persisted, 1, 'admitted input must be durable before inference')
              const records = await Array.fromAsync(store.readSessionLog(session.physicalSessionId))
              assert(JSON.stringify(records).includes('Actual initial request'))
              assert(JSON.stringify(records).includes('Warning: Invalid folder MCP declaration'))
              assert.doesNotMatch(JSON.stringify(messages), /private-value/)
              assert(JSON.stringify(messages).includes('Scoped root rules still apply'))
              return { content: 'Initial request processed', toolCalls: [] }
            },
          }, new SessionTools(tools, home), bus, store, ref => folders.lookupWorkdir(ref) ?? { node: 'missing' })
          session.inputPersisted = () => { persisted++ }
          const result = await session.admit({ kind: 'message', id: 'initial', timestamp: new Date().toISOString(), policy: 'next-step', content: 'Actual initial request',
            source: source === 'session' ? { kind: 'session', sessionId: 'web:parent' }
              : { kind: 'user', sender: { senderId: 'owner', channel: 'web', chatId: 'mcp-startup', messageId: 'initial' } } })
          assert.equal(result?.status, 'completed', result?.error)
          assert.equal(providerCalls, 1)
          assert.equal(connect.mock.callCount(), 0)
          assert(appended.some(message => message.includes('Actual initial request')))
          const saved = await store.getState(id)
          assert.match(saved?.workingContext ?? '', /Warning: Invalid folder MCP declaration/)
          assert.equal(saved?.executionStatus, 'completed')
          const records = await Array.fromAsync(store.readSessionLog(session.physicalSessionId))
          assert(records.some(record => record.role === 'assistant' && JSON.stringify(record.content).includes('Initial request processed')))
        } finally { store.close?.(); bus.stopAll() }
      })
    })
  }
}
