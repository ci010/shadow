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
  const bindings = {
    defineProps: () => props, defineEmits: () => (name: string, payload: unknown) => updates.push([name, payload]),
    ref: (value?: unknown) => ({ value }), computed: (getter: Function) => ({ get value() { return getter() } }),
    watch: (getter: Function) => watches.push(getter), onMounted() {}, onBeforeUnmount() {},
    t: (text: string) => text, AnnotationPointer, annotationPoint, annotationSizeError, AnnotationLoadError,
    annotationLoadErrorMessage, drawAnnotationStroke, markedImageName, isAnnotationUndo,
    imageSourcePath: () => '/original.png', startImageReferenceDrag() { throw new Error('must not reference-drag local images') },
    fetch: async () => { fetched++; return { ok: true, headers: new Headers(), blob: async () => file } },
    Image: class { naturalWidth = 200; naturalHeight = 100; async decode() {} },
  }
  const js = ts.transpileModule(script + '\nreturn { canvas, tool, strokes, loadImage, pointerDown, pointerMove, pointerUp, undoStroke, clearMarks, dragStart, sourceError, loaded };', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const component = new Function(...Object.keys(bindings), js)(...Object.values(bindings))
  component.canvas.value = target
  await component.loadImage()
  const event = (x: number, y: number, extra = {}) => ({ pointerId: 1, button: 0, buttons: 1, isPrimary: true, ctrlKey: false, shiftKey: false, clientX: x, clientY: y, preventDefault() {}, ...extra })
  return { component, event, operations, updates, props, watches, fetched }
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
