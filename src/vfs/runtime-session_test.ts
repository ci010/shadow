import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRuntimeHandler } from './runtime.ts'
import { RuntimeDiagnosticLog } from '../runtime/diagnostic-log.ts'
import { PromptCaptureStore } from '../sessions/prompt-capture.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { VirtualFs } from './virtual-fs.ts'

const context = { projectId: 'p', sessionId: 'web:root', signal: new AbortController().signal } as ExecutionContext
function fixture(maxBytes = 10000) {
  const states = new Map(['web:root', 'web:other', 'sub-task', 'cron:nightly', 'heartbeat:archived', 'denied', 'foreign'].map(sessionId => [sessionId, {
    sessionId, projectId: sessionId === 'foreign' ? 'other-project' : 'p', name: sessionId,
    mode: sessionId === 'sub-task' ? 'task' : 'session',
  }]))
  const captures = new PromptCaptureStore('p', 20, maxBytes)
  let enabled = true
  const calls: string[] = []
  const sessions = {
    readSessionState: async (id: string) => states.get(id) ?? null,
    getSessionState: (id: string) => id === 'heartbeat:archived' ? null : states.get(id) ?? null,
    listHistoryStates: async () => [...states.values()],
    assertHistoricalFolderAccess: async (id: string) => { if (id === 'denied') throw new Error('Folder access denied') },
    assertFolderAccess: (id: string) => { if (id === 'heartbeat:archived') throw new Error('Do not use live authorization for archived states') },
    getActiveSession: (id: string) => id === 'cron:nightly' ? undefined : {},
    getContext: async ({ sessionId, preview }: { sessionId: string; preview?: boolean }) => {
      calls.push(sessionId)
      return { source: preview ? 'preview' : 'active-history', systemPrompt: `prompt:${sessionId}`, tools: [{ name: 'registry-only' }] }
    },
    getPromptCaptures: (id: string) => enabled ? captures.list(id) : undefined,
  } as unknown as SessionManager
  const handler = createRuntimeHandler(new RuntimeDiagnosticLog(), 'p', (_project, actor) => {
    if (actor !== 'web:root') throw new Error('Invalid actor')
  }, undefined, sessions)
  const capture = (sessionId: string) => captures.capture({ projectId: 'p', sessionId, physicalSessionId: 'physical', turnId: 'turn', iteration: 1, provider: 'fixture' }, [{ role: 'system', content: `captured:${sessionId}` }], [{ type: 'function', function: { name: 'sent-only', description: 'sent', parameters: { type: 'object', properties: {} } } }], { model: 'model' })
  return { handler, calls, capture, disable: () => { enabled = false } }
}

test('session targets include current, other ordinary, subagent, cron and archived sessions', async () => {
  const f = fixture()
  const read = (path: string) => f.handler.read(path, context)
  assert.match(await read(''), /SHADOW_DEBUG_PROMPTS/)
  const index = JSON.parse(await read('sessions'))
  assert.deepEqual(index.map((entry: { sessionId: string }) => entry.sessionId), ['web:root', 'web:other', 'sub-task', 'cron:nightly', 'heartbeat:archived'])
  assert.equal(index[2].mode, 'task')
  assert.equal(index[1].path, 'v:runtime/sessions/web%3Aother')
  for (const [path, id] of [['current', 'web:root'], ['sessions/web%3Aother', 'web:other'], ['sessions/sub-task', 'sub-task']] as const) {
    assert.equal(JSON.parse(await read(`${path}/system-prompt`)).systemPrompt, `prompt:${id}`)
    f.capture(id)
    const tools = JSON.parse(await read(`${path}/tools`))
    assert.equal(tools.sessionId, id)
    assert.equal(tools.boundary, 'provider-input')
    assert.equal(tools.tools[0].function.name, 'sent-only')
    assert.equal(tools.systemMessages, undefined)
  }
  await assert.rejects(async () => read('sessions/cron:nightly/system-prompt'), /Active-history.*unavailable/)
  assert.equal(f.calls.includes('cron:nightly'), false)
  const preview = JSON.parse(await read('sessions/cron:nightly/preview'))
  assert.equal(preview.source, 'preview')
  assert.equal(preview.toolsSource, 'current-registry-policy-not-provider-input')
  for (const id of ['cron:nightly', 'heartbeat:archived']) {
    f.capture(id)
    assert.match(await read(`sessions/${id}/captures`), new RegExp(`captured:${id}`))
  }
  await assert.rejects(async () => read('sessions/heartbeat:archived/preview'), /archived-only/)
  await assert.rejects(async () => read('sessions/heartbeat:archived/system-prompt'), /archived-only/)
  assert.equal(f.calls.includes('heartbeat:archived'), false)
})

test('debug fails closed for missing, denied, foreign, malformed and read-only paths', async () => {
  const { handler, calls } = fixture()
  for (const id of ['missing', 'foreign']) await assert.rejects(async () => handler.read(`sessions/${id}/preview`, context), /Unknown session/)
  await assert.rejects(async () => handler.read('sessions/denied/preview', context), /Folder access denied/)
  for (const path of ['sessions/web:other/nope', 'current/preview/extra', 'sessions/../preview']) await assert.rejects(async () => handler.read(path, context))
  assert.throws(() => handler.read('current/preview', { ...context, projectId: 'foreign' }), /current Project/)
  assert.throws(() => handler.read('current/preview', { ...context, sessionId: 'unknown' }), /Invalid actor/)
  assert.deepEqual(calls, [])
  const vfs = new VirtualFs()
  vfs.mount('v:runtime', 'debug', handler.read, handler.list)
  assert.throws(() => vfs.write('v:runtime/current/preview', { content: 'x' }, context), /read-only/)
  const entries = await handler.list(context)
  for (const path of ['current/tools', 'sessions/sub-task/tools', 'sessions/cron%3Anightly/preview', 'sessions/heartbeat%3Aarchived/captures']) assert.ok(entries.some(entry => entry.name === path))
  assert.deepEqual(calls, [])
  const controller = new AbortController(); controller.abort()
  assert.throws(() => handler.read('sessions', { ...context, signal: controller.signal }))
})

test('capture unavailable, empty and oversized payloads are distinct; reads never substitute registry tools', async () => {
  const f = fixture()
  await assert.rejects(async () => f.handler.read('current/tools', context), /No retained/)
  f.disable()
  await assert.rejects(async () => f.handler.read('current/captures', context), /recording is disabled/)
  assert.deepEqual(f.calls, [])
  const bounded = fixture(1)
  bounded.capture('web:root')
  await assert.rejects(async () => bounded.handler.read('current/tools', context), /omitted-size-limit/)
  assert.match(await bounded.handler.read('current/captures', context), /omitted-size-limit/)
})
