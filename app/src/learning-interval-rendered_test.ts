import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { setAutomationInterval } from './automations.ts'

test('interval client validates whole minutes and sends only the selected interval', async () => {
  const calls: unknown[] = []
  const request = async (url: unknown, init?: RequestInit) => { calls.push([String(url), JSON.parse(String(init?.body))]); return Response.json({ automation: { id: 'learning:reflector' } }) }
  for (const value of [0, NaN, 1.5, 35792]) await assert.rejects(setAutomationInterval('https://example.test/', 'learning:reflector', value, new AbortController().signal, request as typeof fetch))
  assert.equal(calls.length, 0)
  await setAutomationInterval('https://example.test/projects/a/', 'learning:reflector', 2, new AbortController().signal, request as typeof fetch)
  assert.deepEqual(calls, [['https://example.test/projects/a/api/automations/learning%3Areflector', { intervalMs: 120000 }]])
})

test('bottom card saves one job, exposes failures, and ignores stale/unmounted mutations', async () => {
  const file = new URL('./components/AutomationConversationSettings.vue', import.meta.url)
  const source = compileScript(parse(readFileSync(file, 'utf8')).descriptor, { id: 'interval', inlineTemplate: true }).content
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const pending: { base: string; id: string; minutes: number; signal: AbortSignal; resolve: () => void; reject: (error: Error) => void }[] = []
  const native = createRequire(file), mod = { exports: {} as { default: vue.Component } }
  new Function('require', 'module', 'exports', js)((id: string) => {
    if (id === 'vue') return { ...vue, vModelText: {} }
    if (id.endsWith('.vue')) return { default: { render: () => null } }
    if (id.endsWith('i18n.ts')) return { t: (key: string) => key }
    if (id.endsWith('model-selection.ts')) return { useModelSelection: () => null }
    if (id.endsWith('automations.ts')) return { setAutomationInterval: (base: string, id: string, minutes: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => pending.push({ base, id, minutes, signal, resolve, reject })) }
    return native(id)
  }, mod, mod.exports)
  interface Node { tag: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node }
  const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [] })
  const renderer = vue.createRenderer<Node, Node>({ createElement: node, createText: text => node('#text', text), createComment: text => node('#comment', text), insert(child, parent) { child.parent = parent; parent.children.push(child) }, remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1) }, setText: (n, text) => { n.text = text }, setElementText: (n, text) => { n.text = text }, parentNode: n => n.parent ?? null, nextSibling: () => null, patchProp: (n, key, _old, value) => { n.props[key] = value } })
  const props = vue.reactive({ apiBase: 'https://example.test/a/', job: { id: 'learning:reflector', source: 'learning', intervalMs: 60000, editable: true, enabled: false }, active: true })
  let saved = 0
  const root = node('root'), app = renderer.createApp({ setup: () => () => vue.h(mod.exports.default, { ...props, onSaved: () => saved++ }) }); app.mount(root)
  const find = (tag: string, n = root): Node | undefined => n.tag === tag ? n : n.children.map(child => find(tag, child)).find(Boolean)
  const submit = async () => { find('input')!.props['onUpdate:modelValue'](2); await vue.nextTick(); find('form')!.props.onSubmit({ preventDefault() {} }); await vue.nextTick() }
  await submit(); assert.equal(pending[0]!.id, 'learning:reflector'); assert.equal(pending[0]!.minutes, 2)
  pending[0]!.reject(new Error('Save failed')); await new Promise(resolve => setImmediate(resolve)); assert.equal(find('p')!.text, 'Save failed')
  await submit(); props.job = { ...props.job, id: 'learning:encapsulator' }; await vue.nextTick(); assert.equal(pending[1]!.signal.aborted, true); pending[1]!.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(saved, 0)
  await submit(); pending[2]!.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(saved, 1); assert.equal(props.job.enabled, false)
  await submit(); app.unmount(); assert.equal(pending[3]!.signal.aborted, true); pending[3]!.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(saved, 1)
})

test('Learning settings navigation is removed and old URLs redirect to its automation', () => {
  const settings = readFileSync(new URL('./components/ProjectSettings.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(settings, /id: 'learning'|saveLearning|LearningRuntimeStatus|learningEnabled/)
  const router = readFileSync(new URL('./router.ts', import.meta.url), 'utf8')
  assert.match(router, /settings\/learning', redirect:.*automation: 'learning:reflector'/)
  for (const [file, expression] of [
    ['AutomationSidebar.vue', "current.source === 'learning' ? current.enabled"],
    ['AutomationDetail.vue', "job.source === 'learning' ? job.enabled"],
    ['AutomationConversationInfo.vue', "automation.source === 'learning' ? automation.enabled"],
  ]) assert.ok(readFileSync(new URL(`./components/${file}`, import.meta.url), 'utf8').includes(expression!))
})
