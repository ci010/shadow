import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ComputerActionSchema as contract } from './contracts.ts'
import { ComputerActionSchema as worker } from './agent-desktop-actions.js'

test('plain-Node action schema is an exact erased mirror of the host authorization contract', async () => {
  const source = await readFile(new URL('./contracts.ts', import.meta.url), 'utf8')
  const canonical = source.slice(source.indexOf('export const computerActions ='), source.indexOf('export type ComputerAction =')).replaceAll(' as const', '').trim()
  const mirror = await readFile(new URL('./agent-desktop-actions.js', import.meta.url), 'utf8')
  assert.equal(mirror.slice(mirror.indexOf('export const computerActions =')).trim(), canonical)
})

test('all existing action forms/defaults and unsafe rejections agree across the process boundary', () => {
  const actions: unknown[] = [
    { kind: 'invoke', elementId: '1' }, { kind: 'set_value', elementId: '1', value: 'Synthetic' },
    { kind: 'toggle', elementId: '1' }, { kind: 'select', elementId: '1' }, { kind: 'scroll', elementId: '1', direction: 'down' },
    { kind: 'click', x: 0, y: 1 }, { kind: 'move', x: 0, y: 1 },
    { kind: 'drag', x: 0, y: 1, toX: 2, toY: 3 }, { kind: 'wheel', x: 0, y: 1, steps: 1 },
    { kind: 'press_key', elementId: '1', key: 'ENTER' }, { kind: 'type_text', elementId: '1', text: 'Synthetic 😀' },
    { kind: 'press_key', elementId: '1', key: 'TAB', modifiers: ['ALT'] },
    { kind: 'press_key', elementId: '1', key: 'ESCAPE', modifiers: ['CTRL', 'SHIFT'] },
    { kind: 'click', x: 1600, y: 0 }, { kind: 'wheel', x: 0, y: 0, steps: 0 },
    { kind: 'drag', x: 1, y: 1, toX: 1, toY: 1 },
    { kind: 'type_text', elementId: '1', text: '\u0000' },
    { kind: 'click', x: 0, y: 1, modifiers: ['CTRL', 'CTRL'] },
    { kind: 'mouse_down', button: 'left' },
  ]
  for (const action of actions) {
    const host = contract.safeParse(action), child = worker.safeParse(action)
    assert.equal(child.success, host.success, JSON.stringify(action))
    if (host.success && child.success) assert.deepEqual(child.data, host.data)
  }
})
