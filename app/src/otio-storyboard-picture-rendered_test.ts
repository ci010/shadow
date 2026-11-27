import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'
import { createRenderer, h, markRaw, nextTick, reactive, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

class ElementFixture {
  style = { display: '' }
  props: Record<string, unknown> = {}
  children: ElementFixture[] = []
  parent?: ElementFixture
  constructor(public tag: string) { markRaw(this) }
}
const path = new URL('./components/files/OtioStoryboardPicture.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'))
const source = compileScript(descriptor, { id: 'storyboard-lifecycle', inlineTemplate: true }).content
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const require = createRequire(path)

test('storyboard uses the final native crossing and re-observes new tasks on retained DOM without eager offscreen reads', async t => {
  const draws: { url: string; seconds: number }[] = []
  const observers: ObserverFixture[] = []
  class ObserverFixture {
    target?: ElementFixture
    admissions = 0
    constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) { observers.push(this) }
    observe(target: ElementFixture) { this.target = target; this.admissions++ }
    unobserve(target: ElementFixture) { if (this.target === target) this.target = undefined }
    disconnect() { this.target = undefined }
    emit(...crossings: boolean[]) { this.callback(crossings.map(isIntersecting => ({ isIntersecting }))) }
  }
  const module = { exports: {} as { default: Component } }
  new Function('require', 'module', 'exports', outputText)((id: string) => {
    if (id.endsWith('/mobile-resources.ts')) return { useMobileResources: () => ({ resolve: (url: string) => url }) }
    if (id.endsWith('/otio-storyboard-picture.ts')) return {
      queueStoryboardPicture: (signal: AbortSignal, draw: () => Promise<void>) => { if (!signal.aborted) void draw() },
      drawStoryboardPicture: async (_canvas: unknown, url: string, _kind: string, seconds: number) => { draws.push({ url, seconds }) },
    }
    return require(id)
  }, module, module.exports)
  const document = Object.assign(new EventTarget(), { hidden: false })
  const restore = Object.entries({ document, IntersectionObserver: ObserverFixture }).map(([name, value]) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    return { name, previous }
  })
  const renderer = createRenderer<ElementFixture, ElementFixture>({
    createElement: tag => new ElementFixture(tag), createText: () => new ElementFixture('#text'), createComment: () => new ElementFixture('#comment'),
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    setText() {}, setElementText() {}, patchProp(node, key, _old, value) { node.props[key] = value },
    parentNode: node => node.parent ?? null, nextSibling: () => null,
  })
  const props = reactive({ medium: { path: 'a.mp4', kind: 'video' as const, url: '/a.mp4' }, seconds: 0.5, gap: false, active: true, unlinked: '' })
  const root = new ElementFixture('root')
  const app = renderer.createApp({ render: () => h(module.exports.default, props) })
  app.mount(root)
  t.after(() => {
    app.unmount()
    for (const { name, previous } of restore) {
      if (previous) Object.defineProperty(globalThis, name, previous)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  await nextTick()
  const observer = observers[0]!, element = observer.target
  assert.ok(element)
  assert.equal(draws.length, 0, 'unobserved/offscreen work is lazy')
  observer.emit(false, true) // Native batching during transformed Flow layout.
  await nextTick(); await nextTick()
  assert.deepEqual(draws, [{ url: '/a.mp4', seconds: 0.5 }])
  props.medium = { path: 'b.mp4', kind: 'video', url: '/b.mp4' }
  props.seconds = 2
  await nextTick()
  assert.equal(observer.target, element, 'the source change retains the actual thumbnail DOM')
  assert.ok(observer.admissions >= 2)
  assert.equal(draws.length, 1, 'source change must await fresh native admission')
  observer.emit(true, false)
  await nextTick()
  assert.equal(draws.length, 1, 'the final clipped crossing wins')
  props.active = false
  await nextTick()
  props.active = true
  await nextTick()
  assert.equal(observer.target, element)
  assert.equal(draws.length, 1)
  observer.emit(false, true)
  await nextTick(); await nextTick()
  assert.deepEqual(draws[1], { url: '/b.mp4', seconds: 2 })
})
