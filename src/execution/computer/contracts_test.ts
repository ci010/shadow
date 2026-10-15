import assert from 'node:assert/strict'
import test from 'node:test'
import { ComputerActionSchema } from './contracts.ts'

test('foreground schemas normalize bounded actions and allow printable Unicode scalars', () => {
  assert.deepEqual(ComputerActionSchema.parse({ kind: 'click', x: 10, y: 20 }),
    { kind: 'click', x: 10, y: 20, button: 'left', count: 1, modifiers: [] })
  assert.deepEqual(ComputerActionSchema.parse({ kind: 'drag', x: 0, y: 0, toX: 50, toY: 50 }),
    { kind: 'drag', x: 0, y: 0, toX: 50, toY: 50, durationMs: 300, modifiers: [] })
  assert.ok(ComputerActionSchema.safeParse({ kind: 'type_text', elementId: '1', text: 'Synthetic \u4e2d\ud83d\ude00' }).success)
  assert.ok(ComputerActionSchema.safeParse({ kind: 'press_key', elementId: '1', key: 'A', modifiers: ['CTRL'] }).success)
})

test('unsafe shortcuts, raw key states, control text and unbounded pointer actions fail validation', () => {
  const invalid = [
    ...['TAB', 'ESCAPE', 'SPACE', 'F6'].map(key => ({ kind: 'press_key', elementId: '1', key, modifiers: ['ALT'] })),
    ...[['CTRL'], ['CTRL', 'SHIFT']].map(modifiers => ({ kind: 'press_key', elementId: '1', key: 'ESCAPE', modifiers })),
    { kind: 'press_key', elementId: '1', key: 'DELETE', modifiers: ['CTRL', 'ALT'] },
    { kind: 'press_key', elementId: '1', key: 'WIN' },
    { kind: 'press_key', elementId: '1', key: 'PRINT_SCREEN' },
    { kind: 'press_key', elementId: '1', key: 'A', modifiers: ['CTRL', 'CTRL'] },
    { kind: 'key_down', key: 'SHIFT' },
    ...['', '\n', '\t', '\0', '\u0085', '\u2028', '\u2029', '\ud800', '\udc00', 'x'.repeat(1001)]
      .map(text => ({ kind: 'type_text', elementId: '1', text })),
    { kind: 'click', x: -1, y: 0 }, { kind: 'click', x: 1600, y: 0 },
    { kind: 'click', x: 0, y: 0, count: 3 },
    { kind: 'drag', x: 0, y: 0, toX: 0, toY: 0 },
    { kind: 'drag', x: 0, y: 0, toX: 10, toY: 10, durationMs: 801 },
    { kind: 'wheel', x: 0, y: 0, steps: 0 }, { kind: 'wheel', x: 0, y: 0, steps: 11 },
    { kind: 'move', x: 0, y: 0, screenCoordinates: true },
  ]
  for (const action of invalid) assert.equal(ComputerActionSchema.safeParse(action).success, false, JSON.stringify(action))
})
