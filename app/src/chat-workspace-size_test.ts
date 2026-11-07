import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { compileScript, parse } from 'vue/compiler-sfc'
import { createRenderer, h, KeepAlive, nextTick, reactive, ref } from 'vue'

// Run the actual component setup and KeepAlive hooks. Child views and rendering
// are inert; geometry reads throw so activation cannot accidentally force layout.
class Element {
  parent: Element | null = null
  children: Element[] = []
  pointers = new Set<number>()
  getBoundingClientRect(): never { throw new Error('synchronous geometry read') }
  get offsetWidth(): never { throw new Error('synchronous geometry read') }
  get clientWidth(): never { throw new Error('synchronous geometry read') }
  setPointerCapture(id: number) { this.pointers.add(id) }
  hasPointerCapture(id: number) { return this.pointers.has(id) }
  releasePointerCapture(id: number) { this.pointers.delete(id) }
}
const renderer = createRenderer<Element, Element>({
  createElement: () => new Element(), createText: () => new Element(), createComment: () => new Element(),
  insert(node, parent, anchor) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node)
    else parent.children.splice(index, 0, node)
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  },
  setText() {}, setElementText() {}, patchProp() {},
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
})

test('workspace sizes arrive asynchronously; KeepAlive observation and cleanup are idempotent', async t => {
  const directory = resolve('app/.test-artifacts', `workspace-size-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const key = `workspaceSize${randomUUID().replaceAll('-', '')}`
  const route = reactive({ name: 'chat', params: {}, query: {} })
  ;(globalThis as any)[key] = { route }
  t.after(() => { delete (globalThis as any)[key] })
  const source = await readFile(resolve('app/src/components/ChatWorkspace.vue'), 'utf8')
  const script = compileScript(parse(source).descriptor, { id: 'workspace-size' }).content
  await build({
    stdin: { contents: script, loader: 'ts', resolveDir: resolve('app/src/components') },
    outfile: resolve(directory, 'component.mjs'), bundle: true, format: 'esm', platform: 'node', external: ['vue'],
    plugins: [{ name: 'workspace-size-fixture', setup(builder) {
      builder.onResolve({ filter: /\.vue$/ }, () => ({ path: 'child', namespace: 'stub' }))
      builder.onResolve({ filter: /^(vue-router)$|\/i18n\.ts$/ }, args => ({ path: args.path, namespace: 'stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'child'
        ? 'export default {}' : args.path === 'vue-router'
          ? `export const useRoute = () => globalThis[${JSON.stringify(key)}].route; export const useRouter = () => ({replace(){}})`
          : 'export const t = x => x', loader: 'ts' }))
    } }],
  })
  const definition = (await import(pathToFileURL(resolve(directory, 'component.mjs')).href)).default
  definition.render = () => h('div', { ref: 'workspace' })

  const observers: FakeObserver[] = []
  class FakeObserver {
    target?: Element
    options?: ResizeObserverOptions
    disconnects = 0
    constructor(readonly callback: (entries: any[]) => void) { observers.push(this) }
    observe(target: Element, options: ResizeObserverOptions) { this.target = target; this.options = options }
    disconnect() { this.disconnects++ }
    deliver(width: number, contentWidth = width, target = this.target) {
      this.callback([{ target, borderBoxSize: [{ inlineSize: width, blockSize: 600 }], contentRect: { width: contentWidth } }])
    }
  }
  const blur = new Set<() => void>()
  let added = 0, removed = 0
  const globals = {
    HTMLElement: Element, ResizeObserver: FakeObserver,
    window: {
      addEventListener(name: string, callback: () => void) { assert.equal(name, 'blur'); added++; blur.add(callback) },
      removeEventListener(name: string, callback: () => void) { assert.equal(name, 'blur'); removed++; blur.delete(callback) },
    },
  }
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) })
  }
  const shown = ref(true)
  const app = renderer.createApp({ render: () => h(KeepAlive, null, {
    default: () => shown.value ? h(definition, { apiBase: '', managed: true, sessionId: 'main', childSessionId: 'child' }) : null,
  }) })
  const vm = app.mount(new Element())
  let unmounted = false
  t.after(() => { if (!unmounted) app.unmount() })
  await nextTick()
  const state = (vm.$.subTree.component!.subTree.component! as any).setupState
  assert.equal(observers.length, 1, 'mounted + activated create only one observer')
  assert.equal(added, 1)
  assert.equal(state.workspaceWidth, 0, 'mount does not synchronously measure')
  assert.equal(state.wide, false)
  const first = observers[0]
  assert.deepEqual(first.options, { box: 'border-box' })
  first.deliver(1400.5, 1200)
  await nextTick()
  assert.equal(state.workspaceWidth, 1400.5, 'preserve fractional border-box width, not content width')
  assert.equal(state.split, true)
  assert.equal(state.childWidth, 480)
  first.deliver(100, 100, new Element())
  assert.equal(state.workspaceWidth, 1400.5, 'ignore unrelated entries')

  const target = new Element()
  const pointer = { button: 0, currentTarget: target, pointerId: 7, clientX: 100, preventDefault() {} }
  state.startResize(pointer)
  state.resize({ pointerId: 8, clientX: 0 })
  assert.equal(state.childWidth, 480, 'ignore another pointer')
  state.resize({ pointerId: 7, clientX: 50 })
  assert.equal(state.childWidth, 530)
  for (const callback of blur) callback()
  assert.equal(target.pointers.size, 0)
  const keyEvent = (key: string) => ({ key, preventDefault() {} })
  state.resizeKey(keyEvent('Home')); assert.equal(state.childWidth, state.bounds.min)
  state.resizeKey(keyEvent('ArrowLeft')); assert.equal(state.childWidth, state.bounds.min + 24)
  state.resizeKey(keyEvent('ArrowRight')); assert.equal(state.childWidth, state.bounds.min)
  state.resizeKey(keyEvent('End')); assert.equal(state.childWidth, Math.round(state.bounds.max))

  state.startResize(pointer)
  first.deliver(0)
  await nextTick()
  assert.equal(state.workspaceWidth, 0, 'hidden workspace size must not be discarded as falsy')
  assert.equal(state.wide, false)
  assert.equal(state.split, false)
  assert.equal(state.drag, undefined)
  assert.equal(target.pointers.size, 0)
  assert.equal(state.childId, 'child', 'narrow/hidden panes retain child navigation')
  first.callback([{ target: first.target, contentRect: { width: 1400 } }])
  await nextTick()
  assert.equal(state.split, true, 'contentRect fallback restores the border/padding-free workspace')
  route.name = 'project-settings'
  await nextTick()
  assert.equal(state.split, false, 'non-chat route keeps child pane hidden')
  route.name = 'chat'
  await nextTick()
  assert.equal(state.split, true)

  state.startResize(pointer)
  shown.value = false
  await nextTick()
  assert.equal(first.disconnects, 1)
  assert.equal(removed, 1)
  assert.equal(blur.size, 0)
  assert.equal(target.pointers.size, 0, 'deactivation releases captured pointer')
  first.deliver(20)
  assert.equal(state.workspaceWidth, 1400, 'ignore queued delivery after disconnect')
  shown.value = true
  await nextTick()
  assert.equal(observers.length, 2)
  assert.equal(added, 2)
  assert.equal(state.workspaceWidth, 1400, 'reactivation retains last size until asynchronous delivery')
  first.deliver(30)
  assert.equal(state.workspaceWidth, 1400, 'old activation cannot overwrite new one')
  observers[1].deliver(1279)
  await nextTick()
  assert.equal(state.split, false)
  observers[1].deliver(1280)
  await nextTick()
  assert.equal(state.split, true, 'split threshold is unchanged')
  app.unmount()
  unmounted = true
  assert.equal(observers[1].disconnects, 1, 'deactivated + unmounted disconnect only once')
  assert.equal(removed, 2)
  assert.equal(blur.size, 0)
  observers[1].deliver(40)
  assert.equal(state.workspaceWidth, 1280, 'unmount ignores queued deliveries')
})
