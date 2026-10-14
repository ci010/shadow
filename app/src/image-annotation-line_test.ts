import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { AnnotationPointer, annotationPoint, annotationSizeError, AnnotationLoadError, annotationLoadErrorMessage, drawAnnotationStroke, markedImageName, isAnnotationUndo } from './image-annotation.ts'

async function harness(local = true, mime = 'image/png') {
  const source = await readFile(new URL('./components/files/ImageAnnotationPreview.vue', import.meta.url), 'utf8')
  const script = source.split('<script setup lang="ts">')[1]!.split('</script>')[0]!.replace(/^import .*$/gm, '')
  const operations: unknown[][] = []
  const context = {
    clearRect() { operations.push(['clear']) }, drawImage() {}, getImageData() {}, beginPath() {}, arc() {}, fill() {},
    moveTo(x: number, y: number) { operations.push(['move', x, y]) },
    lineTo(x: number, y: number) { operations.push(['line', x, y]) }, stroke() {},
  }
  const target = { width: 200, height: 100, getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
    setPointerCapture() {}, hasPointerCapture: () => false, focus() {},
    toBlob(callback: (blob: Blob) => void) { callback(new Blob(['marked'], { type: 'image/png' })) },
  }
  const file = new File(['image'], 'paste.png', { type: mime })
  const props = { src: '/image', name: 'paste.png', localFile: local ? file : undefined, sourceKey: 'source', contextKey: 'context', active: true, editable: true }
  const updates: any[] = []
  const watches: Function[] = []
  let fetched = 0
  class FakeElement {
    editable = false
    contains(target: unknown) { return target instanceof FakeElement }
    closest(selector: string) { return selector === 'dialog[open]' ? this : this.editable ? this : null }
  }
  const document = { activeElement: new FakeElement() }
  const bindings = {
    Element: FakeElement, document,
    withDefaults: (value: object, defaults: object) => Object.assign({}, defaults, value), defineProps: () => props, defineEmits: () => (name: string, payload: unknown) => updates.push([name, payload]),
    ref: (value?: unknown) => ({ value }), computed: (getter: Function) => ({ get value() { return getter() } }),
    watch: (getter: Function) => watches.push(getter), onMounted() {}, onBeforeUnmount() {},
    t: (text: string) => text, AnnotationPointer, annotationPoint, annotationSizeError, AnnotationLoadError,
    annotationLoadErrorMessage, drawAnnotationStroke, markedImageName, isAnnotationUndo,
    imageSourcePath: () => '/original.png', startImageReferenceDrag() { throw new Error('must not reference-drag local images') },
    fetch: async () => { fetched++; return { ok: true, headers: new Headers(), blob: async () => file } },
    Image: class { naturalWidth = 200; naturalHeight = 100; async decode() {} },
  }
  const js = ts.transpileModule(script + '\nreturn { canvas, preview, stage, spaceHeld, panning, panDown, panMove, panUp, panLostCapture, windowBlur, zoom, zoomSize, zoomWheel, keyChange, tool, strokes, loadImage, pointerDown, pointerMove, pointerUp, undoStroke, clearMarks, dragStart, sourceError, loaded };', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const component = new Function(...Object.keys(bindings), js)(...Object.values(bindings))
  component.preview.value = new FakeElement()
  component.canvas.value = target
  target.getBoundingClientRect = () => ({ left: 0, top: 0, width: component.zoomSize.value?.width ?? 100, height: component.zoomSize.value?.height ?? 50 })
  await component.loadImage()
  const event = (x: number, y: number, extra = {}) => ({ pointerId: 1, button: 0, buttons: 1, isPrimary: true, ctrlKey: false, shiftKey: false, clientX: x, clientY: y, preventDefault() {}, ...extra })
  return { component, event, operations, updates, props, watches, fetched, document }
}

test('line preview replaces endpoint, preserves prior marks and exports two-point stroke through undo pipeline', async () => {
  const { component: c, event, operations, updates } = await harness()
  c.pointerDown(event(1, 2)); c.pointerUp(event(3, 4))
  const freehand = structuredClone(c.strokes[0])
  c.tool.value = 'line'
  c.pointerDown(event(10, 10))
  c.pointerMove(event(20, 15)); c.pointerMove(event(30, 20))
  assert.deepEqual(c.strokes[1].points, [{ x: 20, y: 20 }, { x: 60, y: 40 }])
  assert.deepEqual(c.strokes[0], freehand)
  assert.equal(operations.filter(op => op[0] === 'clear').length, 2)
  c.pointerUp(event(40, 25))
  assert.deepEqual(c.strokes[1].points, [{ x: 20, y: 20 }, { x: 80, y: 50 }])
  assert.ok(updates.at(-2)[1].file instanceof File)
  c.undoStroke()
  assert.deepEqual(c.strokes, [freehand])
  c.undoStroke()
  assert.equal(updates.at(-1)[1].file, null)
})

test('Shift selects a transient line and freehand retains sampled points; Ctrl-drag never marks', async () => {
  const { component: c, event } = await harness()
  c.pointerDown(event(1, 1, { shiftKey: true }))
  c.pointerMove(event(2, 2)); c.pointerUp(event(3, 3))
  assert.equal(c.strokes[0].points.length, 2)
  assert.equal(c.tool.value, 'freehand')
  c.pointerDown(event(4, 4)); c.pointerMove(event(5, 5)); c.pointerUp(event(6, 6))
  assert.equal(c.strokes[1].points.length, 3)
  c.pointerDown(event(7, 7, { ctrlKey: true }))
  assert.equal(c.strokes.length, 2)
})

test('local files load without fetch, omit source on export and cannot reference-drag; identity is watched', async () => {
  const { component: c, event, updates, fetched, watches, props } = await harness()
  assert.equal(fetched, 0)
  assert.equal(c.loaded.value, true)
  assert.equal(c.sourceError.value, '')
  c.pointerDown(event(1, 1)); c.pointerUp(event(2, 2))
  const update = updates.findLast(([name]) => name === 'image-context')[1]
  assert.ok(update.file instanceof File)
  assert.equal('source' in update, false)
  let prevented = false
  c.dragStart({ ctrlKey: true, dataTransfer: {}, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.ok(watches[0]().includes(props.localFile))
  const remote = await harness(false)
  assert.equal(remote.fetched, 1)
  remote.component.pointerDown(remote.event(1, 1)); remote.component.pointerUp(remote.event(2, 2))
  assert.deepEqual(remote.updates.findLast(([name]) => name === 'image-context')[1].source, { path: '/original.png', modified: true })
})

test('native clipboard files without MIME still decode locally before marking', async () => {
  const { component: c, event, updates } = await harness(true, '')
  assert.equal(c.loaded.value, true)
  c.pointerDown(event(1, 1)); c.pointerUp(event(2, 2))
  assert.equal(updates.findLast(([name]) => name === 'image-context')[1].file.type, 'image/png')
})


test('attachment Ctrl+Z works from modal focus and leaves text input undo alone', async () => {
  const { component: c, event, document, updates } = await harness()
  c.pointerDown(event(1, 1)); c.pointerUp(event(2, 2))
  c.pointerDown(event(3, 3)); c.pointerUp(event(4, 4))
  let prevented = 0
  const key = { type: 'keydown', key: 'z', ctrlKey: true, shiftKey: false, metaKey: false, altKey: false,
    isComposing: false, keyCode: 90, repeat: false, defaultPrevented: false,
    preventDefault() { prevented++ }, stopPropagation() {} }
  document.activeElement.editable = true
  c.keyChange(key)
  assert.equal(c.strokes.length, 2)
  document.activeElement.editable = false
  c.keyChange(key)
  assert.equal(c.strokes.length, 1)
  c.keyChange(key)
  assert.equal(c.strokes.length, 0)
  assert.equal(updates.at(-1)[1].file, null)
  assert.equal(prevented, 2)
})

test('Ctrl-wheel zooms only the display, clamps scale and preserves drawing coordinates and exports', async () => {
  const { component: c, event, updates } = await harness()
  let prevented = 0
  const wheel = (deltaY: number, ctrlKey = true) => ({ ctrlKey, deltaY, deltaMode: 0,
    preventDefault() { prevented++ }, stopPropagation() {} })
  c.zoomWheel(wheel(-100, false))
  assert.equal(c.zoom.value, 1)
  c.zoomWheel(wheel(-100))
  assert.ok(c.zoom.value > 1)
  assert.equal(c.canvas.value.width, 200)
  assert.equal(c.canvas.value.height, 100)
  assert.equal(updates.length, 0)
  const size = c.zoomSize.value
  c.pointerDown(event(size.width / 2, size.height / 2))
  c.zoomWheel(wheel(-100)) // Do not change the view mid-stroke.
  assert.deepEqual(c.zoomSize.value, size)
  c.pointerUp(event(size.width / 2, size.height / 2))
  assert.deepEqual(c.strokes[0].points[0], { x: 100, y: 50 })
  for (let i = 0; i < 30; i++) c.zoomWheel(wheel(-1000))
  assert.equal(c.zoom.value, 4)
  for (let i = 0; i < 30; i++) c.zoomWheel(wheel(1000))
  assert.equal(c.zoom.value, 0.25)
  assert.ok(prevented > 0)
  await c.loadImage()
  assert.equal(c.zoom.value, 1)
  assert.equal(c.zoomSize.value, undefined)
})


test('pan releases capture on space-up, cancellation and blur without adding marks', async () => {
  const { component: c, event, updates } = await harness()
  let captured = false
  c.stage.value = { scrollLeft: 100, scrollTop: 100,
    setPointerCapture() { captured = true }, hasPointerCapture() { return captured }, releasePointerCapture() { captured = false } }
  const key = { type: 'keydown', code: 'Space', key: ' ', ctrlKey: false, metaKey: false, altKey: false,
    isComposing: false, defaultPrevented: false, preventDefault() {}, stopPropagation() {} }
  const p = (extra = {}) => event(10, 10, { stopPropagation() {}, ...extra })
  c.keyChange(key)
  assert.equal(c.spaceHeld.value, true)
  c.panDown(p())
  assert.equal(c.panning.value, true)
  c.panMove(p({ clientX: 30, clientY: 40 }))
  assert.equal(c.stage.value.scrollLeft, 80)
  assert.equal(c.stage.value.scrollTop, 70)
  c.keyChange({ ...key, type: 'keyup' })
  assert.equal(captured, false)
  assert.equal(c.panning.value, false)
  c.panDown(p({ button: 1, buttons: 4 }))
  c.panUp(p({ type: 'pointercancel' }))
  assert.equal(captured, false)
  c.panDown(p({ button: 1, buttons: 4 }))
  c.windowBlur()
  assert.equal(c.panning.value, false)
  assert.equal(captured, false)
  assert.equal(c.strokes.length, 0)
  assert.equal(updates.length, 0)
})
