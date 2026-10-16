import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createRenderer, nextTick, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

test('selected automation renders actual metrics, unknown usage, frequency and refresh without model calls', async t => {
  const url = new URL('./components/AutomationProfile.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: 'profile', inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component } }
  const loadVue = (file: URL): Component => {
    const parsed = parse(readFileSync(file, 'utf8'))
    const compiled = compileScript(parsed.descriptor, { id: file.pathname, inlineTemplate: true }).content
    const js = ts.transpileModule(compiled, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const mod = { exports: {} as { default: Component } }
    const native = createRequire(file)
    const require = (id: string): unknown => id.endsWith('.vue') ? { default: loadVue(new URL(id, file)) } : id.endsWith('i18n.ts') ? { t: (key: string, params?: Record<string, unknown>) => key.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? name)), formatNumber: (value: number) => value.toLocaleString(), formatDateTime: (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', options).format(date) } : native(id)
    new Function('require', 'module', 'exports', js)(require, mod, mod.exports)
    return mod.exports.default
  }
  module.exports.default = loadVue(url)
  interface Node { tag: string; text: string; props: Record<string, unknown>; children: Node[]; parent?: Node }
  const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [] })
  const renderer = createRenderer<Node, Node>({
    createElement: node, createText: text => node('#text', text), createComment: text => node('#comment', text),
    insert: (child, parent, anchor) => { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) }, remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1) },  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    parentNode: node => node.parent ?? null, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null, patchProp: (node, key, _previous, value) => { node.props[key] = value },
  })
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    requests.push(String(input))
    return Response.json({ profile: { frequency: { description: 'Explicit full / delta organization', scope: 'current_runtime' }, runs: { total: 1, failed: 0, partial: 0, cancelled: 0, unknown: 0 }, usage: { providerCalls: 3, toolCalls: 2, inputTokens: 0, outputTokens: null, knownUsageCalls: 2, unknownUsageCalls: 1, untrackedSessions: 0 }, coverage: 'partial', window: { from: '2026-10-10T00:00:00.000Z', asOf: '2026-10-11T00:00:00.000Z' }, limitations: ['No cost estimates'] } })
  })
  const root = node('root'), app = renderer.createApp(module.exports.default, { apiBase: 'https://example.test/projects/current/', featureId: 'system:work-organizer', active: true })
  app.mount(root); t.after(() => app.unmount())
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }
  await settle()
  const text = (n: Node): string => n.text + n.children.map(text).join(' ')
  assert.match(text(root), /Recorded provider calls 3/); assert.match(text(root), /Input tokens 0.*Output tokens Unknown/)
  assert.match(text(root), /Explicit full \/ delta organization/); assert.match(text(root), /Usage known \/ unknown calls: 2 \/ 1/)
  const find = (n: Node): Node | undefined => n.tag === 'button' ? n : n.children.map(find).find(Boolean)
  ;(find(root)?.props.onClick as () => void)(); await settle()
  assert.equal(requests.length, 2)
  assert.ok(requests.every(url => url === 'https://example.test/projects/current/api/automations/system%3Awork-organizer/profile'))
})
