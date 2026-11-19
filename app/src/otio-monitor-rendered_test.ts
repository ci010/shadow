import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import ts from 'typescript'
import { createRenderer, h, markRaw, nextTick, reactive, ref, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { MAX_ANNOTATION_BYTES, MAX_ANNOTATION_DIMENSION } from './image-annotation.ts'
import { mobileSessionKey } from './mobile-client.ts'
import * as mobileResources from './mobile-resources.ts'

class ElementFixture {
  props: Record<string, unknown> = {}
  children: ElementFixture[] = []
  parent?: ElementFixture
  constructor(public tag: string, public text = '') { markRaw(this) }
  fire(name: string) {
    const handler = this.props[`on${name[0]!.toUpperCase()}${name.slice(1)}`] as (event: unknown) => void
    handler({ type: name, currentTarget: this })
  }
  removeAttribute(name: string) { delete this.props[name] }
}
class VideoFixture extends ElementFixture {
  paused = true
  ended = false
  seeking = false
  readyState = 0
  duration = 10
  videoWidth = 640
  videoHeight = 360
  time = 0
  seeks: number[] = []
  plays = 0
  callbacks = new Map<number, VideoFrameRequestCallback>()
  private counter = 0
  constructor() { super('video') }
  get currentTime() { return this.time }
  set currentTime(target: number) { this.seeks.push(target); this.seeking = true }
  settle(actual = this.seeks.at(-1)!) {
    this.time = actual
    this.seeking = false
    this.readyState = 4
    this.fire('seeked')
  }
  pause() { this.paused = true }
  async play() { this.paused = false; this.plays++ }
  load() {}
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) { this.callbacks.set(++this.counter, callback); return this.counter }
  cancelVideoFrameCallback(id: number) { this.callbacks.delete(id) }
  present(mediaTime: number) {
    for (const [id, callback] of [...this.callbacks]) {
      this.callbacks.delete(id)
      callback(0, { mediaTime, presentationTime: performance.now() } as VideoFrameCallbackMetadata)
    }
  }
}
class ImageFixture extends ElementFixture {
  complete = false
  naturalWidth = 1280
  naturalHeight = 720
  constructor() { super('img') }
}

const path = new URL('./components/files/OtioMonitor.vue', import.meta.url)
const { descriptor } = parse(readFileSync(path, 'utf8'))
const source = compileScript(descriptor, { id: 'otio-monitor-fixture', inlineTemplate: true }).content
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const module = { exports: {} as { default: Component } }
const require = createRequire(path)
new Function('require', 'module', 'exports', outputText)(
  (id: string) => id.endsWith('/mobile-resources.ts') ? mobileResources : require(id), module, module.exports,
)

function mount(t: TestContext, kind: 'video' | 'image', requestTicket?: (path: string) => Promise<unknown>) {
  const writes: [ElementFixture, number, number][] = []
  const encoders: ((blob: Blob) => void)[] = []
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    createElement() {
      return {
        width: 0, height: 0,
        getContext: () => ({ drawImage: (input: ElementFixture, _x: number, _y: number, width: number, height: number) => writes.push([input, width, height]) }),
        toBlob: (callback: (blob: Blob) => void) => encoders.push(callback),
      }
    },
  })
  const globals = { document: doc, HTMLVideoElement: VideoFixture }
  const old = Object.entries(globals).map(([name, value]) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    return { name, previous }
  })
  const renderer = createRenderer<ElementFixture, ElementFixture>({
    createElement: tag => tag === 'video' ? new VideoFixture() : tag === 'img' ? new ImageFixture() : new ElementFixture(tag),
    createText: value => new ElementFixture('#text', value), createComment: value => new ElementFixture('#comment', value),
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    setText(node, value) { node.text = value },
    setElementText(node, value) { node.text = value; node.children = [] },
    patchProp(node, key, _old, value) { node.props[key] = value },
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  })
  const root = new ElementFixture('root')
  const props = reactive({ active: true, playing: false, muted: undefined as boolean | undefined, pictureKey: 'first', mediaKind: kind, url: '/api/sessions/s/raw?path=picture', sourceSeconds: 2, label: 'Picture', unavailable: 'No picture' })
  const readies: boolean[] = []
  let monitor: { capture(): Promise<{ file: File; mediaSeconds: number | null }> } | null = null
  const app = renderer.createApp({ render: () => h(module.exports.default, { ...props, ref: (value: typeof monitor) => { monitor = value }, onCaptureReady: (ready: boolean) => readies.push(ready) }) })
  if (requestTicket) app.provide(mobileSessionKey as symbol, {
    origin: ref('https://main.example'), resourceTicket: requestTicket, resourceError: ref(''),
  })
  app.mount(root)
  t.after(() => {
    app.unmount()
    for (const { name, previous } of old) {
      if (previous) Object.defineProperty(globalThis, name, previous)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  const nodes = () => root.children[0]!.children
  return { props, readies, writes, encoders, doc, nodes,
    video: () => nodes().find((node): node is VideoFixture => node instanceof VideoFixture)!,
    image: () => nodes().find((node): node is ImageFixture => node instanceof ImageFixture)!,
    capture: () => monitor!.capture(),
  }
}

const png = () => new Blob(['fake image bytes'], { type: 'image/png' })

test('monitor seeks precisely, uses presented PTS, and abandons capture across same-URL clips', async t => {
  const fixture = mount(t, 'video')
  await nextTick()
  const movie = fixture.video()
  assert.ok(movie)
  assert.equal(movie.props.crossorigin, 'anonymous')
  movie.readyState = 1
  movie.fire('loadedmetadata')
  assert.deepEqual(movie.seeks, [2])
  assert.equal(fixture.readies.at(-1), false)
  const capture = fixture.capture()
  await Promise.resolve()
  assert.equal(fixture.writes.length, 0, 'unresolved seeks may not be drawn')
  movie.present(0) // The previous frame can still be submitted while seeking.
  movie.settle()
  movie.present(1.967)
  await nextTick()
  assert.equal(fixture.readies.at(-1), true)
  assert.deepEqual(fixture.writes[0], [movie, 640, 360])
  fixture.encoders[0]!(png())
  const result = await capture
  assert.equal(result.file.type, 'image/png')
  assert.equal(result.mediaSeconds, 1.967, 'presented PTS differs from the requested offset')

  const stale = fixture.capture()
  await Promise.resolve()
  fixture.props.pictureKey = 'second'
  await nextTick()
  assert.notEqual(fixture.video(), movie)
  assert.equal(movie.props.src, undefined)
  assert.equal(fixture.readies.at(-1), false)
  fixture.encoders[1]!(png())
  await assert.rejects(stale, { name: 'AbortError' })
})

test('monitor plays in sync without per-tick seeks; ranges, bad seeks and hiding disable capture', async t => {
  const fixture = mount(t, 'video')
  fixture.props.playing = true
  await nextTick()
  const movie = fixture.video()
  movie.readyState = 4
  movie.fire('loadedmetadata')
  movie.settle()
  assert.equal(movie.paused, false)
  fixture.props.sourceSeconds = 2.1
  await nextTick()
  assert.deepEqual(movie.seeks, [2])
  fixture.props.playing = false
  await nextTick()
  assert.equal(movie.paused, true)
  assert.deepEqual(movie.seeks, [2, 2.1])
  const capture = fixture.capture()
  movie.settle(2.2)
  await assert.rejects(capture, /could not be captured/)
  assert.equal(fixture.readies.at(-1), false)
  assert.equal(fixture.writes.length, 0)

  fixture.props.sourceSeconds = 10
  await nextTick()
  assert.match(fixture.nodes().find(node => node.props.role === 'status')?.text ?? '', /outside the available media/)
  fixture.doc.hidden = true
  fixture.doc.dispatchEvent(new Event('visibilitychange'))
  await nextTick()
  assert.equal(fixture.video(), undefined)
  assert.equal(movie.props.src, undefined)
})

test('still capture exports intrinsic size, does not invent a media time, and rejects oversized dimensions', async t => {
  const fixture = mount(t, 'image')
  await nextTick()
  const still = fixture.image()
  assert.equal(still.props.crossorigin, 'anonymous')
  still.fire('load')
  const capture = fixture.capture()
  await Promise.resolve()
  assert.deepEqual(fixture.writes[0], [still, 1280, 720])
  fixture.encoders[0]!(png())
  assert.equal((await capture).mediaSeconds, null)
  fixture.props.pictureKey = 'large'
  await nextTick()
  fixture.image().naturalWidth = MAX_ANNOTATION_DIMENSION + 1
  fixture.image().fire('load')
  assert.equal(fixture.readies.at(-1), false)
  await assert.rejects(fixture.capture(), /annotation limit/)
  assert.equal(fixture.writes.length, 1)
})

test('oversize encoded results cannot escape the annotation limit; resuming cancels the next export', async t => {
  const fixture = mount(t, 'image')
  await nextTick()
  fixture.image().fire('load')
  const capture = fixture.capture()
  fixture.encoders[0]!(Object.defineProperty(png(), 'size', { value: MAX_ANNOTATION_BYTES + 1 }))
  await assert.rejects(capture, /20 MiB annotation limit/)
  const resumed = fixture.capture()
  fixture.props.playing = true
  await nextTick()
  assert.equal(fixture.readies.at(-1), false)
  fixture.encoders[1]!(png())
  await assert.rejects(resumed, { name: 'AbortError' })
})

test('video capture without presentation metadata leaves mediaSeconds unknown', async t => {
  const fixture = mount(t, 'video')
  await nextTick()
  const movie = fixture.video()
  Object.defineProperty(movie, 'requestVideoFrameCallback', { value: undefined })
  movie.readyState = 4
  movie.fire('loadedmetadata')
  movie.settle()
  assert.equal(fixture.readies.at(-1), true)
  const capture = fixture.capture()
  fixture.encoders[0]!(png())
  assert.equal((await capture).mediaSeconds, null)
})

test('parent controls embedded audio on the current video; inactive release stops it', async t => {
  const fixture = mount(t, 'video')
  fixture.props.playing = true
  await nextTick()
  const movie = fixture.video()
  assert.equal(movie.props.muted, true)
  movie.readyState = 4
  movie.fire('loadedmetadata')
  movie.settle()
  fixture.props.muted = false
  await nextTick()
  assert.equal(fixture.video(), movie, 'toggling sound must not remount the video')
  assert.equal(movie.props.muted, false)
  assert.equal(movie.paused, false)
  assert.equal(fixture.readies.at(-1), false)
  fixture.props.active = false
  await nextTick()
  assert.equal(movie.paused, true)
  assert.equal(movie.props.src, undefined)
  assert.equal(fixture.video(), undefined)
})

test('pending mobile resource ticket shows a waiting notice and admits only the scoped URL', async t => {
  const pending = Promise.withResolvers<unknown>()
  const paths: string[] = []
  const fixture = mount(t, 'video', path => { paths.push(path); return pending.promise })
  await nextTick()
  assert.deepEqual(paths, ['/api/sessions/s/raw?path=picture'])
  assert.equal(fixture.video(), undefined)
  assert.equal(fixture.nodes().find(node => node.props.role === 'status')?.text, 'Waiting for picture…')
  assert.equal(fixture.readies.at(-1), false)
  const url = `https://main.example${paths[0]}&ticket=test-only`
  pending.resolve({ version: 1, url, expiresAt: new Date(Date.now() + 30_000).toISOString() })
  await new Promise(resolve => setImmediate(resolve))
  await nextTick()
  assert.equal(fixture.video().props.src, url)
})
