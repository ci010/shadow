import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

// Exercise the real ChatTab loader, including request cancellation and state writes.
const source = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
const start = source.indexOf('async function loadReadonlySession(')
const end = source.indexOf('// ── Segment navigation', start)
assert.ok(start >= 0 && end > start)
const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const errorText = 'Could not load execution context. Reopen it to retry.'
function harness() {
  const ref = <T>(value: T) => ({ value })
  const state = {
    activeSessionId: ref('run-a'), loadingHistory: ref(false),
    readonlyContextError: ref('old failure'), systemPrompt: ref('old prompt'), tools: ref<unknown[]>(['old tool']),
    messagesContainer: ref(null), decisionRecordError: ref(''), previousPhysicalId: ref(null),
    viewingPhysicalId: ref<string | null>('old segment'), physicalIdStack: ref<string[]>(['old']), composerError: ref(''),
  }
  let response = () => Promise.resolve(Response.json({ error: 'archived_context_unavailable' }, { status: 409 }))
  const histories: unknown[] = []
  let fetches = 0
  const deps = {
    ...state, livePool: {}, disconnectEventStream() {}, scrollToBottom() {},
    currentTimelinePrevious: null, seedRecentTimeline: async () => {},
    buildUrl: (path: string) => path, t: (key: string) => key,
    chatReadScope: () => ({ projectId: 'fixture' }),
    chatResources: {
      readReadonly: async () => Response.json({ messages: ['persisted history'] }),
      readDocument: () => { fetches++; return response() },
    },
    collapseHistory: (value: unknown) => value, mergeCommandResults: (value: unknown) => value,
    parseDecisionRecords: (value: unknown) => value,
    applyCurrentTimeline: (value: unknown) => histories.push(value),
  }
  const load = new Function(...Object.keys(deps), `let historyRequest; let lastReadonlyRefresh; ${code}; return loadReadonlySession`)(...Object.values(deps)) as (background?: boolean) => Promise<void>
  return { state, load, histories, fetches: () => fetches, respond: (next: typeof response) => { response = next } }
}

test('explicit archived context is normal: retains history, clears stale context/error, never rebuilds', async () => {
  const h = harness()
  await h.load()
  assert.deepEqual(h.histories, [['persisted history']])
  assert.equal(h.state.readonlyContextError.value, '')
  assert.equal(h.state.systemPrompt.value, '')
  assert.deepEqual(h.state.tools.value, [])
  assert.equal(h.state.composerError.value, '')
  assert.equal(h.fetches(), 1)
})

for (const [name, response] of [
  ['other conflict', () => Promise.resolve(Response.json({ error: 'other_conflict' }, { status: 409 }))],
  ['server failure', () => Promise.resolve(Response.json({ error: 'archived_context_unavailable' }, { status: 500 }))],
  ['malformed conflict', () => Promise.resolve(new Response('not json', { status: 409 }))],
  ['network failure', () => Promise.reject(new Error('offline'))],
] as const) {
  test(`${name} retains genuine context failure without losing readable history`, async () => {
    const h = harness()
    h.respond(response)
    await h.load()
    assert.equal(h.state.readonlyContextError.value, errorText)
    assert.equal(h.state.composerError.value, '')
    assert.deepEqual(h.histories, [['persisted history']])
    assert.equal(h.state.systemPrompt.value, '')
    assert.deepEqual(h.state.tools.value, [])
  })
}

test('success clears failure; background history refresh preserves context without refetching', async () => {
  const h = harness()
  h.respond(() => Promise.resolve(Response.json({ systemPrompt: 'current prompt', tools: ['current tool'] })))
  await h.load()
  assert.equal(h.state.readonlyContextError.value, '')
  assert.equal(h.state.systemPrompt.value, 'current prompt')
  assert.deepEqual(h.state.tools.value, ['current tool'])
  await h.load(true)
  assert.equal(h.fetches(), 1)
  assert.equal(h.state.systemPrompt.value, 'current prompt')
  assert.deepEqual(h.state.tools.value, ['current tool'])
})

test('a newer selection cancels late context body writes from the previous run', async () => {
  const h = harness()
  let finish!: (value: unknown) => void
  const body = new Promise(resolve => { finish = resolve })
  h.respond(() => Promise.resolve({ ok: true, status: 200, json: () => body } as Response))
  const old = h.load()
  assert.equal(h.state.systemPrompt.value, '', 'clear old prompt immediately during load')
  assert.equal(h.state.readonlyContextError.value, '')
  await Promise.resolve()
  h.state.activeSessionId.value = 'run-b'
  h.respond(() => Promise.resolve(Response.json({ error: 'archived_context_unavailable' }, { status: 409 })))
  await h.load()
  finish({ systemPrompt: 'late prompt', tools: ['late tool'] })
  await old
  assert.equal(h.state.systemPrompt.value, '')
  assert.deepEqual(h.state.tools.value, [])
  assert.equal(h.state.readonlyContextError.value, '')
  assert.deepEqual(h.histories, [['persisted history']], 'aborted run must not replace selected history')
  assert.equal(h.state.loadingHistory.value, false)
})
