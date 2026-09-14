import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { compileScript, compileStyle, compileTemplate, parse } from 'vue/compiler-sfc'
import { AnnotationPointer, annotationPoint, annotationSizeError, drawAnnotationStroke, isAnnotationUndo, markedImageName, MAX_ANNOTATION_BYTES } from './image-annotation.ts'

test('marker coordinates preserve landscape and portrait aspect ratios at CSS scale', () => {
  assert.deepEqual(annotationPoint(210, 120, { left: 10, top: 20, width: 400, height: 200 }, 1600, 800), { x: 800, y: 400 })
  assert.deepEqual(annotationPoint(60, 220, { left: 10, top: 20, width: 100, height: 400 }, 600, 2400), { x: 300, y: 1200 })
  assert.deepEqual(annotationPoint(-20, 500, { left: 0, top: 0, width: 100, height: 200 }, 200, 400), { x: -40, y: 1000 })
  assert.equal(annotationPoint(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 200, 400), null)
})

test('marked image names are PNG without carrying a source path', () => {
  assert.equal(markedImageName('photo.jpeg'), 'photo-marked.png')
  assert.equal(markedImageName('chart.v2.webp'), 'chart.v2-marked.png')
  assert.equal(markedImageName('drawing'), 'drawing-marked.png')
  assert.equal(markedImageName('C:\\images\\猫.gif'), '猫-marked.png')
  assert.equal(markedImageName('folder/image.svg'), 'image-marked.png')
  assert.equal(markedImageName(''), 'image-marked.png')
})

test('image safety limits allow exact bounds and reject oversized bytes or bitmaps', () => {
  assert.equal(annotationSizeError(MAX_ANNOTATION_BYTES, 5000, 4000), null)
  assert.equal(annotationSizeError(10, 8192, 1), null)
  assert.match(annotationSizeError(MAX_ANNOTATION_BYTES + 1)!, /20 MiB/)
  assert.match(annotationSizeError(10, 5001, 4000)!, /20 megapixel/)
  assert.match(annotationSizeError(10, 8193, 1)!, /8192/)
  assert.match(annotationSizeError(10, 1, 8193)!, /8192/)
  assert.match(annotationSizeError(10, 0, 100)!, /dimensions/)
  assert.match(annotationSizeError(10, NaN, 100)!, /dimensions/)
})

test('marker pointer ownership rejects Ctrl-drag, secondary input and concurrent pointers', () => {
  const state = new AnnotationPointer()
  const event = { pointerId: 7, button: 0, isPrimary: true, ctrlKey: false }
  assert.equal(state.start(event, false), false)
  assert.equal(state.start({ ...event, ctrlKey: true }, true), false)
  assert.equal(state.start({ ...event, button: 2 }, true), false)
  assert.equal(state.start({ ...event, isPrimary: false }, true), false)
  assert.equal(state.active, false)
  assert.equal(state.start(event, true), true)
  assert.equal(state.owns(7), true)
  assert.equal(state.owns(8), false)
  assert.equal(state.start({ ...event, pointerId: 8 }, true), false)
  assert.equal(state.release(), 7)
  assert.equal(state.active, false)
  assert.equal(state.release(), null)
  assert.equal(state.start({ ...event, pointerId: 8 }, true), true)
})

test('stroke replay preserves each stroke color, width, dot and segment geometry after undo', () => {
  const operations: unknown[] = []
  const context: Parameters<typeof drawAnnotationStroke>[0] = {
    fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: 'butt', lineJoin: 'miter',
    beginPath() {},
    arc(...args: Parameters<CanvasRenderingContext2D['arc']>) { operations.push(['dot', ...args]) },
    fill() { operations.push(['fill', this.fillStyle]) },
    moveTo(x: number, y: number) { operations.push(['move', x, y]) },
    lineTo(x: number, y: number) { operations.push(['line', x, y]) },
    stroke() { operations.push(['stroke', this.strokeStyle, this.lineWidth, this.lineCap, this.lineJoin]) },
  }
  const strokes = [
    { color: '#ef4444', width: 4, points: [{ x: 2, y: 3 }, { x: 20, y: 30 }] },
    { color: '#3b82f6', width: 8, points: [{ x: 6, y: 9 }] },
  ]
  strokes.pop()
  for (const stroke of strokes) drawAnnotationStroke(context, stroke)
  assert.deepEqual(operations, [
    ['dot', 2, 3, 2, 0, Math.PI * 2], ['fill', '#ef4444'],
    ['move', 2, 3], ['line', 20, 30], ['stroke', '#ef4444', 4, 'round', 'round'],
  ])
  operations.length = 0
  drawAnnotationStroke(context, { color: '#fff', width: 4, points: [] })
  assert.deepEqual(operations, [])
})

test('annotation undo only recognizes plain Ctrl+Z keydown outside IME and auto-repeat', () => {
  const event = { type: 'keydown', key: 'z', ctrlKey: true, shiftKey: false, metaKey: false, altKey: false,
    isComposing: false, keyCode: 90, repeat: false, defaultPrevented: false }
  assert.equal(isAnnotationUndo(event), true)
  assert.equal(isAnnotationUndo({ ...event, key: 'Z' }), true)
  for (const patch of [{ type: 'keyup' }, { key: 'y' }, { ctrlKey: false }, { shiftKey: true },
    { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }]) {
    assert.equal(isAnnotationUndo({ ...event, ...patch }), false)
  }
})

test('image annotation Vue script, template and scoped styles compile', async () => {
  const filename = 'ImageAnnotationPreview.vue'
  const source = await readFile(new URL('./components/files/ImageAnnotationPreview.vue', import.meta.url), 'utf8')
  assert.match(source, /Marked preview · Finish a stroke to update the attached copy\./)
  assert.doesNotMatch(source, /Marked image added to next message/)
  const { descriptor, errors } = parse(source, { filename })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'annotation-test' })
  const template = compileTemplate({
    source: descriptor.template!.content, filename, id: 'annotation-test',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.deepEqual(template.errors, [])
  for (const style of descriptor.styles) {
    assert.deepEqual(compileStyle({ source: style.content, filename, id: 'annotation-test', scoped: true }).errors, [])
  }
})
