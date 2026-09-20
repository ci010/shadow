import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, reactive } from 'vue'
import { filterSlashCommands, parseSlashCommands, slashCommandQuery, useSlashCommandCatalog } from './slash-commands.ts'

const commands = [
  { name: 'help', description: 'List commands' },
  { name: 'sessions', description: 'Active conversations' },
  { name: 'status', description: 'Current activity' },
]
const settle = () => new Promise(resolve => setImmediate(resolve))
function harness(t: TestContext) {
  const pending: { url: string; signal?: AbortSignal | null; resolve: (response: Response) => void; reject: (reason: Error) => void }[] = []
  t.mock.method(globalThis, 'fetch', (url: URL, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => pending.push({ url: String(url), signal: init.signal, resolve, reject })))
  const source = reactive({ apiBase: 'http://localhost:3123/projects/a', sessionId: 'web:one', enabled: false })
  let catalog!: ReturnType<typeof useSlashCommandCatalog>
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({ setup() {
    catalog = useSlashCommandCatalog(() => source)
    return () => null
  } }))
  app.mount({})
  t.after(() => app.unmount())
  return { source, catalog, pending }
}

test('only a leading command token with an end caret triggers completion', () => {
  for (const [text, expected] of [['/', ''], ['/sta', 'sta'], ['  /StA', 'sta'], ['/agent-', 'agent-']] as const) {
    assert.equal(slashCommandQuery(text, text.length), expected)
  }
  for (const text of ['', 'hello /', '/status ', '/config set', '/tmp/file', '//path', '\n/status', '/status\n', 'https://example.test/']) {
    assert.equal(slashCommandQuery(text, text.length), null)
  }
  assert.equal(slashCommandQuery('/status', 2), null)
  assert.equal(slashCommandQuery('/status', 0, 7), null)
  assert.deepEqual(filterSlashCommands(commands, 'st'), [commands[2]])
  assert.deepEqual(filterSlashCommands(commands, ''), commands)
  assert.deepEqual(filterSlashCommands(commands, 'unknown'), [])
})

test('catalog responses are validated before being rendered or inserted', () => {
  assert.deepEqual(parseSlashCommands({ commands }), commands)
  for (const value of [
    null, {}, { commands: [{}] }, { commands: [...commands, commands[0]] },
    { commands: [{ name: '/help', description: '' }] },
    { commands: [{ name: 'help\n/send', description: '' }] },
    { commands: [{ name: 'help', description: 42 }] },
    { commands: Array(129).fill(commands[0]) },
  ]) assert.throws(() => parseSlashCommands(value), /Invalid slash command catalog/)
})

test('catalog loads only on demand, preserves Project scope, and closes without stale data', async t => {
  const { source, catalog, pending } = harness(t)
  assert.equal(pending.length, 0)
  source.enabled = true
  assert.equal(pending.length, 1)
  assert.equal(pending[0].url, 'http://localhost:3123/projects/a/api/chat/commands?sessionId=web%3Aone')
  assert.equal(catalog.loading.value, true)
  pending[0].resolve(Response.json({ commands }))
  await settle()
  assert.deepEqual(catalog.commands.value, commands)
  source.enabled = false
  assert.deepEqual(catalog.commands.value, [])
  assert.equal(catalog.loading.value, false)
  source.enabled = true
  source.enabled = false
  assert.equal(pending[1].signal?.aborted, true)
  pending[1].resolve(Response.json({ commands }))
  await settle()
  assert.deepEqual(catalog.commands.value, [])
})

test('session and Project changes abort reads and reject late catalog results', async t => {
  const { source, catalog, pending } = harness(t)
  source.enabled = true
  source.sessionId = 'web:orchestrator'
  assert.equal(pending[0].signal?.aborted, true)
  source.apiBase = 'http://localhost:3123/projects/b'
  assert.equal(pending[1].signal?.aborted, true)
  pending[2].resolve(Response.json({ commands: [commands[2]] }))
  await settle()
  pending[0].resolve(Response.json({ commands }))
  pending[1].reject(new Error('Old owner request'))
  await settle()
  assert.deepEqual(catalog.commands.value, [commands[2]])
  assert.equal(catalog.error.value, '')
})

test('load and wire errors are explicit and retryable without sending chat', async t => {
  const { source, catalog, pending } = harness(t)
  source.enabled = true
  pending[0].resolve(new Response('', { status: 503 }))
  await settle()
  assert.match(catalog.error.value, /Could not load commands/)
  const firstRetry = catalog.refresh()
  pending[1].resolve(Response.json({ commands: 'malformed' }))
  await firstRetry
  assert.match(catalog.error.value, /Could not load commands/)
  const secondRetry = catalog.refresh()
  pending[2].resolve(Response.json({ commands }))
  await secondRetry
  assert.equal(catalog.error.value, '')
  assert.deepEqual(catalog.commands.value, commands)
})
