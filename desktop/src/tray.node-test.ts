import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Menu, MenuItemConstructorOptions } from 'electron'
import { installTrayMenu } from './tray.js'

function fixture() {
  const calls: string[] = []
  const window = Object.assign(new EventEmitter(), {
    minimized: false,
    destroyed: false,
    webContents: {
      destroyed: false,
      isDestroyed() { return this.destroyed },
      openDevTools(options: { mode: 'detach' }) { calls.push(`devtools:${options.mode}`) },
    },
    isDestroyed() { return this.destroyed },
    isMinimized() { return this.minimized },
    restore() { this.minimized = false; calls.push('restore') },
    show() { calls.push('show') },
    focus() { calls.push('focus') },
  })
  let template: MenuItemConstructorOptions[] = []
  const nativeMenu = {} as Menu
  const tray = Object.assign(new EventEmitter(), {
    destroyed: false,
    setToolTip(text: string) { assert.equal(text, 'Shadow') },
    setContextMenu(menu: Menu) { assert.equal(menu, nativeMenu) },
    isDestroyed() { return this.destroyed },
    destroy() { this.destroyed = true; calls.push('destroy-tray') },
  })
  const dispose = installTrayMenu(tray, {
    buildFromTemplate(items) { template = items; return nativeMenu },
  }, window, () => { calls.push('quit') })
  const click = (index: number) => {
    const item = template[index]!
    assert.ok(item.click)
    item.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent)
  }
  return { calls, window, tray, template, click, dispose }
}

test('tray menu offers show, DevTools and quit without a development-only gate', () => {
  const { template, click, calls } = fixture()
  assert.deepEqual(template.map(item => item.label ?? item.type), [
    '显示 Shadow', '打开开发者工具', 'separator', '退出',
  ])
  click(0)
  click(1)
  click(3)
  assert.deepEqual(calls, ['show', 'focus', 'show', 'focus', 'devtools:detach', 'quit'])
})

test('tray click and DevTools restore a minimized window before focusing it', () => {
  const { tray, window, calls, click } = fixture()
  window.minimized = true
  tray.emit('click')
  assert.deepEqual(calls, ['restore', 'show', 'focus'])
  calls.length = 0
  window.minimized = true
  click(1)
  assert.deepEqual(calls, ['restore', 'show', 'focus', 'devtools:detach'])
})

test('destroyed windows and web contents are not accessed by tray callbacks', () => {
  for (const target of ['window', 'contents'] as const) {
    const { window, tray, click, calls } = fixture()
    if (target === 'window') window.destroyed = true
    else window.webContents.destroyed = true
    tray.emit('click')
    click(0)
    click(1)
    assert.deepEqual(calls, [])
  }
})

test('window close and explicit disposal destroy the tray once and remove listeners', () => {
  for (const action of ['close', 'dispose', 'destroyed-tray'] as const) {
    const { window, tray, click, calls, dispose } = fixture()
    if (action === 'close') window.emit('closed')
    if (action === 'destroyed-tray') tray.destroy()
    dispose()
    dispose()
    tray.emit('click')
    click(0)
    click(1)
    click(3)
    assert.deepEqual(calls, ['destroy-tray'])
    assert.equal(tray.listenerCount('click'), 0)
    assert.equal(window.listenerCount('closed'), 0)
  }
})
