import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Task } from 'electron'
import { DesktopMicroApps, pngIconContainer, quoteWindowsArgument, type MicroAppWindowInput } from './micro-apps.js'
import { MICRO_APP_CHANNELS, microAppArgument, parseMicroAppArguments, parseMicroAppIdentity, parseMicroAppLaunch } from './micro-app-contract.js'
import { microAppWindowOptions } from './micro-app-window.js'
import { installMicroAppIpc } from './micro-app-ipc.js'

const id = '11111111-1111-4111-8111-111111111111'
const identity = { projectId: 'p', appId: id }
const revision = 'a'.repeat(64)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQiT74HwAEJwJAst2PdAAAAABJRU5ErkJggg==', 'base64')

async function fixture(t: TestContext, hasIcon = false, launch: { packaged?: boolean } = {}) {
  const directory = resolve(import.meta.dirname, '..', '..', '.test-artifacts', `native-app-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  const app: { id: string; revision: string; manifest: { name: string; icon?: string }; approval?: { revision: string }; status: string } = {
    id, revision, manifest: { name: 'Voice helper', ...(hasIcon ? { icon: 'icon.png' } : {}) }, approval: { revision }, status: 'stopped',
  }
  const calls: string[] = [], errors: string[] = [], tasks: Task[][] = [], windows: Array<{ input: MicroAppWindowInput; focused: number; closed: boolean }> = []
  let failCatalog = false, failWindow = false, failOpen = false
  let nextCatalog: (() => Promise<void>) | undefined, nextWindow: (() => Promise<void>) | undefined
  const releasePending: Array<() => void> = []
  const pause = (assign: (callback: () => Promise<void>) => void) => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    assign(() => { enter(); return released })
    releasePending.push(release)
    return { entered, release }
  }
  const manager = new DesktopMicroApps({
    userDataPath: directory, appPath: resolve(directory, 'app folder'), executablePath: resolve(directory, 'Shadow.exe'),
    packaged: false, defaultIconPath: resolve(directory, 'default.ico'), platform: 'win32',
    ...launch,
    fetch: async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.origin, 'http://127.0.0.1:43210')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-owner')
      calls.push(url.pathname)
      if (url.pathname === '/api/projects') return Response.json({ projects: [{ id: 'p' }] })
      if (url.pathname.endsWith('/api/microapps')) {
        const response = failCatalog ? Response.json({ error: 'offline' }, { status: 503 }) : Response.json({ apps: [app] })
        const wait = nextCatalog; nextCatalog = undefined
        await wait?.()
        return response
      }
      if (url.pathname.endsWith('/status')) return Response.json(app)
      if (url.pathname.endsWith('/icon')) return new Response(png, { headers: { 'Content-Type': 'image/png' } })
      if (url.pathname.endsWith('/open')) {
        app.status = 'running'
        if (failOpen) throw new Error('Launch response lost')
        return Response.json({ url: `http://127.0.0.1:43211/#shadow_ticket=${'t'.repeat(43)}` })
      }
      if (url.pathname.endsWith('/stop')) { app.status = 'stopped'; return Response.json({}) }
      throw new Error(`Unexpected request ${url.pathname}`)
    },
    createWindow: async input => {
      if (failWindow) throw new Error('Native load failed')
      const window = { input, focused: 0, closed: false }; windows.push(window)
      const wait = nextWindow; nextWindow = undefined
      await wait?.()
      return { focus: () => { window.focused++ }, close: () => { if (!window.closed) { window.closed = true; input.onClosed() } } }
    },
    decodeIcon: bytes => { assert.deepEqual(bytes, png); return { png, width: 1, height: 1 } },
    setUserTasks: value => { tasks.push(value); return true },
    onError: message => errors.push(message),
  })
  t.after(async () => {
    for (const release of releasePending) release()
    await manager.shutdown()
    await rm(directory, { recursive: true, force: true })
  })
  manager.setAuthorization({ apiBase: 'http://127.0.0.1:43210', launchToken: 'synthetic-owner' })
  await manager.refresh()
  return { manager, app, calls, errors, tasks, windows, directory,
    failCatalog: () => { failCatalog = true }, failWindow: () => { failWindow = true },
    failOpen: () => { failOpen = true },
    pauseCatalog: () => pause(callback => { nextCatalog = callback }),
    pauseWindow: () => pause(callback => { nextWindow = callback }) }
}

test('launch arguments and IPC contain stable identities, never arbitrary URLs or credentials', async () => {
  assert.deepEqual(parseMicroAppArguments(['electron', 'app path', microAppArgument(identity)]), identity)
  assert.equal(parseMicroAppArguments(['--unrelated']), undefined)
  for (const input of [null, { ...identity, url: 'http://evil' }, { ...identity, projectId: '../p' }, { ...identity, appId: 'file:///x' }]) {
    assert.throws(() => parseMicroAppIdentity(input))
  }
  for (const argv of [['--shadow-micro-app'], [microAppArgument(identity), microAppArgument(identity)], ['--shadow-micro-app=p:bad']]) {
    assert.throws(() => parseMicroAppArguments(argv))
  }
  assert.throws(() => parseMicroAppLaunch({ url: 'http://localhost:43211/' }))
  assert.throws(() => parseMicroAppLaunch({ url: `http://127.0.0.1:43211/path#shadow_ticket=${'a'.repeat(43)}` }))
  assert.equal(quoteWindowsArgument('C:\\app folder\\'), '"C:\\app folder\\\\"')
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"')
  const handlers = new Map<string, (event: { sender: unknown; senderFrame?: unknown }, ...args: unknown[]) => unknown>()
  const owner = { webContents: { mainFrame: {} }, isDestroyed: () => false }
  let opened = 0
  const dispose = installMicroAppIpc({ handle: (name, handler) => { handlers.set(name, handler) }, removeHandler: name => { handlers.delete(name) } },
    () => owner, { open: async value => { assert.deepEqual(value, identity); opened++ }, refresh: async () => {} })
  const handler = handlers.get(MICRO_APP_CHANNELS.open)!
  assert.throws(() => handler({ sender: {}, senderFrame: owner.webContents.mainFrame }, identity), /main frame/)
  assert.throws(() => handler({ sender: owner.webContents, senderFrame: {} }, identity), /main frame/)
  await handler({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame }, identity)
  assert.equal(opened, 1); dispose(); assert.equal(handlers.size, 0)
})

test('native app options are independent, sandboxed and have no preload or parent', () => {
  const options = microAppWindowOptions({ name: 'Tool', iconPath: 'icon.png', url: 'http://127.0.0.1:1/',
    partition: 'isolated-test', signal: new AbortController().signal, onClosed: () => {} })
  assert.equal(options.frame, true); assert.equal(options.parent, undefined)
  assert.equal(options.webPreferences?.preload, undefined)
  assert.equal(options.webPreferences?.sandbox, true)
  assert.equal(options.webPreferences?.contextIsolation, true)
  assert.equal(options.webPreferences?.nodeIntegration, false)
  assert.equal(options.webPreferences?.backgroundThrottling, false)
  assert.equal(options.webPreferences?.partition, 'isolated-test')
})

test('concurrent/repeated opens focus one window; closing stops before reopening', async t => {
  const f = await fixture(t)
  await Promise.all([f.manager.open(identity), f.manager.open(identity)])
  assert.equal(f.windows.length, 1)
  assert.equal(f.calls.filter(path => path.endsWith('/open')).length, 1)
  await f.manager.open(identity)
  assert.equal(f.windows[0]!.focused, 1)
  f.windows[0]!.input.onClosed()
  await f.manager.open(identity)
  assert.equal(f.windows.length, 2)
  assert.equal(f.calls.filter(path => path.endsWith('/stop')).length, 1)
  assert.notEqual(f.windows[0]!.input.partition, f.windows[1]!.input.partition)
  assert.ok(!JSON.stringify(f.windows.map(w => w.input)).includes('synthetic-owner'))
})

test('only approved apps become persistent task entries; custom PNG becomes a Windows ICO', async t => {
  const f = await fixture(t, true)
  const task = f.tasks.at(-1)![0]!
  assert.match(task.arguments!, /--shadow-micro-app=p:/)
  assert.match(task.arguments!, /--user-data-dir=/)
  assert.ok(!JSON.stringify(task).includes('synthetic-owner'))
  assert.ok(!JSON.stringify(task).includes('shadow_ticket'))
  const ico = await readFile(task.iconPath!)
  assert.deepEqual(ico, pngIconContainer(png, 1, 1))
  await f.manager.open(identity)
  assert.match(f.windows[0]!.input.iconPath, /\.png$/)
  delete f.app.approval; f.app.status = 'awaiting_approval'
  await f.manager.refresh()
  assert.equal(f.windows[0]!.closed, true)
  assert.deepEqual(f.tasks.at(-1), [])
  await assert.rejects(f.manager.open(identity), /approve/)
})

test('transient catalog failures do not remove valid tasks; shutdown retains cold-start tasks', async t => {
  const f = await fixture(t)
  const published = f.tasks.length
  f.failCatalog(); await f.manager.refresh()
  assert.equal(f.tasks.length, published)
  assert.ok(f.errors.some(message => message.includes('503')))
  await f.manager.shutdown()
  assert.equal(f.tasks.length, published)
})

test('packaged task launches preserve the profile and use the executable directory, not app.asar', async t => {
  const f = await fixture(t, false, { packaged: true })
  const task = f.tasks.at(-1)![0]!
  assert.equal(task.workingDirectory, f.directory)
  assert.ok(!task.arguments!.includes('app folder'))
  assert.ok(!task.arguments!.includes('--service-connection'))
  assert.ok(task.arguments!.includes(quoteWindowsArgument(`--user-data-dir=${f.directory}`)))
})

test('failed native loading releases the started runtime and disconnect closes stale windows', async t => {
  const f = await fixture(t)
  await f.manager.open(identity)
  f.manager.setAuthorization(null)
  assert.equal(f.windows[0]!.input.signal.aborted, true)
  assert.equal(f.windows[0]!.closed, true)
  await assert.rejects(f.manager.open(identity), /local Shadow Main/)
  f.manager.setAuthorization({ apiBase: 'http://127.0.0.1:43210', launchToken: 'synthetic-owner' })
  await f.manager.refresh()
  f.failWindow()
  await assert.rejects(f.manager.open(identity), /Native load failed/)
  assert.equal(f.app.status, 'stopped')
})

test('a catalog snapshot taken before opening cannot close the new window', async t => {
  const f = await fixture(t)
  const pause = f.pauseCatalog()
  const refreshing = f.manager.refresh()
  await pause.entered
  await f.manager.open(identity)
  pause.release()
  await refreshing
  assert.equal(f.windows[0]!.closed, false)
  assert.equal(f.app.status, 'running')
  f.app.status = 'stopped'
  await f.manager.refresh()
  assert.equal(f.windows[0]!.closed, true)
  assert.equal(f.tasks.at(-1)!.length, 1)
})

test('disconnect during window loading closes it without sending stop to a different Main', async t => {
  const f = await fixture(t)
  const pause = f.pauseWindow()
  const opening = f.manager.open(identity)
  await pause.entered
  f.manager.setAuthorization(null)
  pause.release()
  await assert.rejects(opening, /interrupted/)
  assert.equal(f.windows[0]!.closed, true)
  assert.equal(f.manager.hasOpenWindows, false)
  assert.equal(f.calls.filter(path => path.endsWith('/stop')).length, 0)
})

test('a lost launch response still stops the runtime that might have started', async t => {
  const f = await fixture(t)
  f.failOpen()
  await assert.rejects(f.manager.open(identity), /Launch response lost/)
  assert.equal(f.app.status, 'stopped')
  assert.equal(f.windows.length, 0)
  assert.equal(f.calls.filter(path => path.endsWith('/stop')).length, 1)
})

test('revoking an app while its native page loads cancels the pending window and stops once', async t => {
  const f = await fixture(t)
  const pause = f.pauseWindow()
  const opening = f.manager.open(identity)
  await pause.entered
  delete f.app.approval
  await f.manager.refresh()
  assert.equal(f.windows[0]!.input.signal.aborted, true)
  pause.release()
  await assert.rejects(opening, /interrupted/)
  assert.equal(f.windows[0]!.closed, true)
  assert.equal(f.app.status, 'stopped')
  assert.equal(f.calls.filter(path => path.endsWith('/stop')).length, 1)
})
