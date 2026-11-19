import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Menu, MenuItemConstructorOptions } from 'electron'
import { installTrayMenu } from './tray.js'

function fixture(development = false) {
  const calls: string[] = []
  let windowOpen = true
  const actions = {
    show() {
      if (!windowOpen) { windowOpen = true; calls.push('create-window') }
      calls.push('show')
    },
    release() { if (windowOpen) { windowOpen = false; calls.push('destroy-window') } },
    openDevTools() { calls.push('devtools') },
  }
  let template: MenuItemConstructorOptions[] = []
  const nativeMenu = {} as Menu
  const tray = Object.assign(new EventEmitter(), {
    destroyed: false,
    setToolTip(text: string) { assert.equal(text, development ? 'Shadow (DEV)' : 'Shadow') },
    setContextMenu(menu: Menu) { assert.equal(menu, nativeMenu) },
    isDestroyed() { return this.destroyed },
    destroy() { this.destroyed = true; calls.push('destroy-tray') },
  })
  const dispose = installTrayMenu(tray, {
    buildFromTemplate(items) { template = items; return nativeMenu },
  }, actions, () => { calls.push('quit') }, development ? () => { calls.push('restart') } : undefined,
  development, () => { calls.push('restart-backend') })
  const click = (index: number) => {
    const item = template[index]!
    assert.ok(item.click)
    item.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent)
  }
  return { calls, tray, template, click, dispose }
}

test('lightweight mode can release and reopen the window repeatedly without quitting', () => {
  const { template, tray, click, calls } = fixture()
  assert.deepEqual(template.map(item => item.label ?? item.type), [
    '显示 Shadow', '轻量模式（关闭主窗口）', '打开开发者工具', 'separator', '退出',
  ])
  click(1); click(1)
  assert.equal(tray.isDestroyed(), false)
  click(0)
  click(1)
  tray.emit('double-click')
  tray.emit('click')
  click(1)
  click(4)
  assert.deepEqual(calls, ['destroy-window', 'create-window', 'show',
    'destroy-window', 'create-window', 'show', 'show', 'destroy-window', 'quit'])
})

test('DevTools opens the workbench first; disposal disables all tray actions', () => {
  const { tray, click, calls, dispose } = fixture()
  click(1); click(2)
  assert.deepEqual(calls, ['destroy-window', 'create-window', 'show', 'devtools'])
  calls.length = 0
  dispose(); dispose()
  tray.emit('click'); tray.emit('double-click')
  click(0); click(1); click(2); click(4)
  assert.deepEqual(calls, ['destroy-tray'])
  assert.equal(tray.listenerCount('click'), 0)
  assert.equal(tray.listenerCount('double-click'), 0)
})

test('development restart calls main callback and is inert after disposal', () => {
  const { template, click, calls, dispose } = fixture(true)
  assert.equal(template[3]?.label, '重启后端（开发）')
  assert.equal(template[4]?.label, '重启 Shadow（开发）')
  click(3); click(4)
  assert.deepEqual(calls, ['restart-backend', 'restart'])
  dispose(); click(3); click(4)
  assert.deepEqual(calls, ['restart-backend', 'restart', 'destroy-tray'])
})
