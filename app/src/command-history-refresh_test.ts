import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const component = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert(script)
const source = ts.createSourceFile('ChatTab.ts', script, ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'refreshDirectHistory')
assert(declaration)
const scheduler = ts.transpileModule(declaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ESNext },
}).outputText

function fixture() {
  let loads = 0
  const state = {
    disposed: false, paneActive: { value: true }, activeSessionId: { value: 'web:fixture' },
    viewingPhysicalId: { value: null as string | null },
    sendRequest: undefined, historyRequest: undefined,
    directRefreshTimer: undefined, directRefreshPending: false,
    deferActiveHistory: false, requestBusy: { value: false },
    setTimeout,
    loadDirectChat(background: boolean) { assert.equal(background, true); loads++ },
  }
  // Execute the actual component scheduler, with only its reactive inputs stubbed.
  const refresh: unknown = runInNewContext(`${scheduler}\nrefreshDirectHistory`, state)
  assert.equal(typeof refresh, 'function')
  assert(typeof refresh === 'function')
  return { state, refresh, loads: () => loads }
}

test('queued command refresh cannot replace a historical segment selected before the timer fires', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.refresh()
  f.state.viewingPhysicalId.value = 'previous-segment'
  t.mock.timers.tick(50)
  assert.equal(f.loads(), 0)
  assert.equal(f.state.directRefreshPending, true)
  f.state.viewingPhysicalId.value = null
  f.refresh()
  t.mock.timers.tick(50)
  assert.equal(f.loads(), 1, 'Returning to current history can consume the pending refresh')
})

test('a queued refresh cannot load a draft after its conversation is cleared', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.refresh()
  f.state.activeSessionId.value = ''
  t.mock.timers.tick(50)
  assert.equal(f.loads(), 0)
})

const loadDeclaration = source.statements.find(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'loadDirectChat')
assert(loadDeclaration)
const loadScript = ts.transpileModule(loadDeclaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ESNext },
}).outputText

function loadFixture(status = 200) {
  const calls: string[] = []
  const data = { history: ['history'], commandResults: ['command'], decisionRecords: ['decision'],
    systemPrompt: 'prompt', tools: ['tool'], previousPhysicalId: 'prior' }
  const state = {
    deferActiveHistory: false, requestBusy: { value: false }, messages: { value: [] as unknown[] },
    viewingPhysicalId: { value: 'old' as string | null }, historyRequest: undefined as AbortController | undefined,
    AbortController, activeSessionId: { value: 'web:fixture' }, directRefreshPending: false,
    loadingHistory: { value: false }, messagesContainer: { value: null },
    fetch: async (url: string) => { calls.push(url); return { status, ok: status === 200, json: async () => data } },
    buildUrl: (path: string) => path, mergeCommandResults: (history: unknown[], commands: unknown[]) => [...history, ...commands],
    collapseHistory: (history: unknown[]) => history, parseDecisionRecords: (records: unknown[]) => records,
    decisionRecords: { value: [] }, decisionRecordError: { value: '' }, sendRequest: undefined,
    streaming: { value: false }, resetStreamPresentation() {}, streamPhase: { value: undefined },
    streamingToolCallData: { value: null }, systemPrompt: { value: '' }, tools: { value: [] },
    previousPhysicalId: { value: null }, physicalIdStack: { value: ['old'] },
    composerError: { value: '' }, props: { embedded: false }, t: (s: string) => s,
    emit: (...args: unknown[]) => events.push(args), createNewWebChat: () => { drafts++ },
    scrollToBottom() {}, refreshDirectHistory() {}, historySnapshot: undefined as { getPromise(): Promise<void> } | undefined, connectEventStream: () => { streams++ }, disconnectEventStream: () => { streams-- },
  }
  const events: unknown[][] = []
  let drafts = 0, streams = 0
  const load = runInNewContext(`${loadScript}\nloadDirectChat`, state) as () => Promise<void>
  return { state, calls, load, events, drafts: () => drafts, streams: () => streams }
}

test('direct history loads content and navigation from one request', async () => {
  const f = loadFixture()
  await f.load()
  assert.deepEqual(f.calls, ['/api/chat/session'])
  assert.deepEqual(f.state.messages.value, ['history', 'command'])
  assert.deepEqual(f.state.decisionRecords.value, ['decision'])
  assert.equal(f.state.systemPrompt.value, 'prompt')
  assert.deepEqual(f.state.tools.value, ['tool'])
  assert.equal(f.state.previousPhysicalId.value, 'prior')
  assert.equal(f.state.viewingPhysicalId.value, null)
  assert.equal(f.state.physicalIdStack.value.length, 0)
  assert.equal(f.streams(), 1)
})

test('missing direct history recovers stale routes without connecting live', async () => {
  const f = loadFixture(404)
  await f.load()
  assert.deepEqual(f.events, [['deleted', 'web:fixture']])
  assert.equal(f.drafts(), 1)
  assert.equal(f.streams(), 0)
  assert.equal(f.state.loadingHistory.value, false)
})

test('aborted direct history cannot apply content or navigation', async () => {
  const f = loadFixture()
  const pending = f.load()
  f.state.historyRequest?.abort()
  await pending
  assert.equal(f.state.messages.value.length, 0)
  assert.equal(f.state.previousPhysicalId.value, null)
  assert.equal(f.state.viewingPhysicalId.value, 'old')
  assert.equal(f.streams(), 1)
  assert.equal(f.state.loadingHistory.value, false)
})


test('direct initial load subscribes before GET and waits for the bounded readiness gate', async () => {
  const f = loadFixture()
  let ready!: () => void
  const readiness = new Promise<void>(resolve => { ready = resolve })
  f.state.historySnapshot = { getPromise: () => readiness }
  const pending = f.load()
  assert.equal(f.streams(), 1, 'subscribe starts before awaiting initial readiness')
  assert.equal(f.calls.length, 0, 'HTTP does not race the initial subscription snapshot')
  ready()
  await pending
  assert.deepEqual(f.calls, ['/api/chat/session'])
})
