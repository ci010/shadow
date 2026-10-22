import { BaseSession } from '../../sessions/base-session.ts'
import { Bus } from '../../bus/bus.ts'
import { SessionTools, Tools } from '../../tools/registry.ts'
import { JsonlSessionStore } from '../../sessions/session-store-jsonl.ts'
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
      projectId: 'p', toolCallName: 'use_project', signal: new AbortController().signal,
      switchProjectFolder: async (prepared: { content: string }) => { switched = prepared.content; return 'receipt' },
    } as unknown as ExecutionContext)
    assert.equal(initial, switched)
    assert.match(initial, /Scoped root rules/)
    assert(initial.includes(join(root, 'AGENTS.md').replaceAll('\\', '\\\\')))
    assert.match(initial, /descendants only/)
    assert.match(initial, /Selected-folder skills/)
    assert.match(initial, /MCP/)
  })
})

test('no-folder, unknown metadata, remote and unavailable snapshots do not read metadata paths', async () => {
  const remote = { version: 1 as const, nodeId: 'child', capabilityId: 'repo', displayPathSnapshot: 'DO-NOT-READ' }
  const folder = { id: 'f', name: 'repo', path: '\u0000invalid-main-path', createdAt: '', projectId: 'p' }
  for (const workdir of [
    { available: true as const, locality: 'remote' as const, workdir: remote },
    { available: false as const, reason: 'node-missing' as const, workdir: remote },
  ]) {
    const content = await prepareWorkingContext(workdir, folder.id, folder)
    assert(!content.includes('DO-NOT-READ'))
    assert.doesNotMatch(content, /Applicable folder instructions/)
    assert.match(content, /remote|unavailable/)
  }
  const local = { available: true as const, locality: 'local' as const, path: '/effective', workdir: localFolderWorkdirRef('f') }
  assert.match(await prepareWorkingContext(local), /Selected Project folder: none/)
  const unknown = await prepareWorkingContext(local, 'unknown')
  assert.match(unknown, /"id":"unknown"/)
  assert.doesNotMatch(unknown, /Applicable folder instructions|"name"/)
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
