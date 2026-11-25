import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { createResourceStores } from './stores/app.ts'

interface Element {
  tag: string; text: string; children: Element[]; parent?: Element
  props: Record<string, unknown>; style: Record<string, string>; isConnected: boolean
  contains(node: Element | undefined): boolean; focus(): void; getBoundingClientRect(): { left: number; top: number }
}

test('follow-up chip renders a read-only plan, refreshes on matching live events and clears on removal or session change', async t => {
  let focused: Element | undefined
  const element = (tag: string, text = ''): Element => Vue.markRaw({ tag, text, children: [], props: {}, style: {}, isConnected: true,
    closest: () => null,
    contains(node) { return this === node || this.children.some(child => child.contains(node)) },
    focus() { focused = this }, getBoundingClientRect: () => ({ left: 260, top: 500 }),
  })
  const restore: Array<() => void> = []
  const body = element('body')
  for (const [name, value] of Object.entries({
    document: Object.defineProperty(Object.assign(new EventTarget(), { hidden: false }), 'activeElement', { get: () => focused }),
    window: Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 640 }),
    ResizeObserver: class { observe() {} disconnect() {} },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    restore.push(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name) })
  }
  const requests: Array<{ url: string; signal?: AbortSignal | null; resolve: (response: Response) => void }> = []
  t.mock.method(globalThis, 'fetch', (url: string, init?: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ url: String(url), signal: init?.signal, resolve })
  }))
  let notify: ((value: { payload: unknown }) => void) | undefined
  const pool = {
    observeHost: (_: unknown, callback: (status: { phase: string }) => void) => { callback({ phase: 'live' }); return () => {} },
    client: () => ({ subscribe: (_: unknown, observer: { event: typeof notify }) => {
      notify = observer.event
      return { ready: async () => {}, close: () => { notify = undefined } }
    } }),
  }
  const url = new URL('./components/SessionWorkControls.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: 'follow-up', inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Vue.Component } }, require = createRequire(url)
  const passthrough = Vue.defineComponent({ emits: ['afterLeave'], setup: (_, { slots }) => () => slots.default?.() })
  new Function('require', 'module', 'exports', outputText)((id: string) => {
    if (id === './OverlayTransition.vue') return { default: passthrough }
    if (id.endsWith('.vue')) return { default: () => null }
    return require(id)
  }, module, module.exports)
  function remove(node: Element) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = undefined
    node.isConnected = false
  }
  const renderer = Vue.createRenderer<Element, Element>({
    createElement: element, createText: text => element('#text', text), createComment: text => element('#comment', text),
    insert(node, parent, anchor) {
      remove(node); node.parent = parent; node.isConnected = true
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node)
    },
    remove, setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    patchProp: (node, key, _, value) => { node.props[key] = value }, parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    querySelector: () => body,
  })
  const root = element('root')
  const props = Vue.reactive({ apiBase: 'http://fixture/projects/a', sessionId: 'web:one', active: true, canWrite: false })
  const app = renderer.createApp({ setup: () => () => Vue.h(module.exports.default, props) })
  app.use(createResourceStores())
  app.provide(Symbol.for('shadow.live-client-pool'), pool)
  app.mount(root)
  t.after(() => { try { app.unmount() } finally { restore.forEach(cleanup => cleanup()) } })
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick() }
  const read = async () => { await new Promise(resolve => setTimeout(resolve, 75)); await settle() }
  const tree = (node: Element): Element[] => [node, ...node.children.flatMap(tree)]
  const chip = () => tree(root).find(node => node.props['data-session-work'] === 'follow-up')
  const dialog = () => tree(body).find(node => node.props.role === 'dialog')!
  const open = async () => { (chip()!.props.onClick as () => void)(); await settle() }
  const invalidate = (sessionId?: string, changes = ['follow-up']) => notify?.({ payload: { event: 'invalidate', sessionId, changes } })
  await read()
  assert.equal(requests[0].url, 'http://fixture/projects/a/api/sessions/web%3Aone/follow-up')
  requests[0].resolve(Response.json({ sessionId: 'web:one', followUp: null }))
  await settle()
  assert.equal(chip(), undefined)
  invalidate('web:other'); invalidate('web:one', ['metadata']); await read()
  assert.equal(requests.length, 1)
  invalidate('web:one'); await read()
  const next = '<strong>Check progress</strong>'
  const nextRun = '2026-11-25T10:15:00Z'
  requests[1].resolve(Response.json({ sessionId: 'web:one', followUp: { next, after: 30, nextRun } }))
  await settle(); await open()
  assert.equal(focused, dialog())
  assert.equal((dialog().props.style as Record<string, string>).left, '12px')
  assert.ok(tree(dialog()).some(node => node.tag === 'dd' && node.text === next))
  assert.ok(tree(dialog()).some(node => node.tag === 'dd' && node.text === '30 s'))
  assert.ok(tree(dialog()).some(node => node.tag === 'time' && node.props.datetime === nextRun && node.text !== nextRun))
  ;(dialog().props.onKeydown as (event: unknown) => void)({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  await settle(); assert.equal(focused, chip()); assert.equal(chip()?.props['aria-expanded'], false)
  await open(); invalidate(); await read()
  requests[2].resolve(Response.json({ sessionId: 'web:one', followUp: { next, after: 30, nextRun: null } }))
  await settle()
  assert.ok(tree(dialog()).some(node => node.text === 'No scheduled check'))
  invalidate(); await read()
  requests[3].resolve(Response.json({ sessionId: 'web:one', followUp: null }))
  await settle()
  assert.equal(chip(), undefined); assert.equal(dialog().style.display, 'none')
  invalidate(); await read()
  props.sessionId = 'web:two'; await settle()
  assert.equal(requests[4].signal?.aborted, true)
  requests[4].resolve(Response.json({ sessionId: 'web:one', followUp: { next, after: 30, nextRun } }))
  await settle(); assert.equal(chip(), undefined)
  props.active = false; await settle(); assert.equal(notify, undefined)
})
