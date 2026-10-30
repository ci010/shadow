import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { privateCredentialTransport } from './credential-requests.ts'
const card = readFileSync(new URL('./components/BotChatSetup.vue', import.meta.url), 'utf8')
const chat = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
const editor = readFileSync(new URL('./components/ChannelsView.vue', import.meta.url), 'utf8')
test('Chat embeds the trusted editor without settings navigation and uses lifecycle-scoped private inputs', () => {
  assert.match(chat, /<BotChatSetup :api-base="apiBase"/)
  assert.match(card, /<ChannelsView v-if="request" :key="request\?\.id"/)
  assert.match(card, /privateCredentialTransport\(props.apiBase\)/)
  assert.match(card, /next.projectId === props.projectId && next.sessionId === props.sessionId/)
  assert.match(card, /onBeforeUnmount\(stop\)/)
  assert.match(card, /controller\?\.abort\(\)/)
  assert.match(editor, /window.confirm\(t\('Bind platform user/)
  assert.match(editor, /field.kind === 'password' \? 'new-password'/)
  assert.match(editor, /drafts.value = \{\}/)
})
test('Private chat setup transport rejects nonloopback cleartext', () => {
  assert.equal(privateCredentialTransport('http://example.com'), false)
  assert.equal(privateCredentialTransport('http://127.0.0.1:3000/projects/p'), true)
  assert.equal(privateCredentialTransport('https://example.com/projects/p'), true)
})

test('setup card mounts editor only for bound requests and refreshes from live invalidation, not idle polling', async t => {
  const { parse, compileScript } = await import('vue/compiler-sfc')
  const { default: ts } = await import('typescript')
  const { createRenderer, defineComponent, h } = await import('vue')
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const { randomUUID } = await import('node:crypto')
  const { resolve, dirname } = await import('node:path')
  const { pathToFileURL, fileURLToPath } = await import('node:url')
  const { descriptor } = parse(card)
  const script = compileScript(descriptor, { id: 'bot-setup-test', inlineTemplate: true })
  const sourceDirectory = fileURLToPath(new URL('./components/', import.meta.url))
  let content = script.content.replace("import ChannelsView from './ChannelsView.vue'", "const ChannelsView = { name: 'ChannelsStub', inheritAttrs: false, render() { return 'trusted-editor' } }")
  content = content.replace(/from (['"])vue\1/g, `from '${import.meta.resolve('vue')}'`)
  content = content.replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_match, _quote, path) => `from '${pathToFileURL(resolve(sourceDirectory, path)).href}'`)
  const output = ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const file = new URL(`../../.test-artifacts/bot-setup-${randomUUID()}/component.mjs`, import.meta.url)
  await mkdir(dirname(fileURLToPath(file)), { recursive: true })
  await writeFile(file, output)
  t.after(() => rm(dirname(fileURLToPath(file)), { recursive: true, force: true }))
  const Component = (await import(file.href)).default
  let observer: import('./live-client.ts').LiveObserver | undefined
  let closes = 0
  let calls = 0
  let pending: unknown = null
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ request: pending }) })
  const pool = {
    client: () => ({ subscribe: (_topic: unknown, value: typeof observer) => { observer = value; return { close() { closes++ } } } }),
    observeHost: (_base: string, notify: (value: unknown) => void) => { notify({ phase: 'live' }); return () => {} },
  }
  const nodes: Array<{ text?: string }> = []
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: text => { const node = { text }; nodes.push(node); return node }, createComment: () => ({}),
    insert() {}, remove() {}, setText(node, text) { Object.assign(node, { text }) }, setElementText(node, text) { Object.assign(node, { text }) }, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({ render: () => h(Component, { apiBase: 'http://127.0.0.1/projects/a', projectId: 'a', sessionId: 'web:topic', active: true, canSubmit: true }) }))
  app.provide(Symbol.for('shadow.live-client-pool'), pool)
  app.mount({})
  let mounted = true
  t.after(() => { if (mounted) app.unmount() })
  const settle = () => new Promise(resolve => setImmediate(resolve))
  await settle()
  assert.equal(calls, 1)
  assert.equal(nodes.some(node => node.text === 'trusted-editor'), false)
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(calls, 1, 'Healthy live setup has no one-second poll')
  pending = { id: 'setup-a', projectId: 'a', sessionId: 'web:topic', expiresAt: Date.now() + 60_000 }
  observer!.event!({ payload: { event: 'invalidate', resource: 'interactions' } } as never)
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(calls, 2)
  assert.equal(nodes.some(node => node.text === 'trusted-editor'), true)
  app.unmount()
  mounted = false
  assert.equal(closes, 1)
})
