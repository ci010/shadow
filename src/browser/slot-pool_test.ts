import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rentBrowserSlot } from './slot-pool.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ChromeManager, ChromePortAllocator, type ChromeRuntimeOperations } from './chrome-manager.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { ChromeToolSchema } from '../config/schema.ts'

test('schema defaults and bounds total slots', () => {
  assert.equal(ChromeToolSchema.parse({}).slotCount, 3)
  for (const slotCount of [0, 17, 1.5, '3']) assert.equal(ChromeToolSchema.safeParse({ slotCount }).success, false)
})

test('persistent pool rotates, preserves data, limits all executable identities together', async () => {
  await withTempWorkspace(async home => {
    const first = await rentBrowserSlot(home, 3, 'chrome')
    await mkdir(first.directory)
    await writeFile(join(first.directory, 'data'), 'retained')
    first.state.initialized = true
    await first.release()
    const second = await rentBrowserSlot(home, 3, 'edge')
    const third = await rentBrowserSlot(home, 3, 'brave')
    const again = await rentBrowserSlot(home, 3, 'chrome')
    assert.equal(again.directory, first.directory)
    assert.equal(await readFile(join(again.directory, 'data'), 'utf8'), 'retained')
    await assert.rejects(rentBrowserSlot(home, 3, 'chrome'), /capacity exhausted/)
    await second.release(); await third.release(); await again.release()
    await assert.rejects(rentBrowserSlot(home, 3, 'other'), /another executable/)
    await assert.rejects(rentBrowserSlot(home, 4, 'chrome'), /restore tools.chrome.slotCount=3/)
  })
})

test('independent renters cannot double-rent; stale leases and browser lock remnants fail closed', async () => {
  await withTempWorkspace(async home => {
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => rentBrowserSlot(home, 3, 'browser')))
    const slots = outcomes.filter(o => o.status === 'fulfilled').map(o => o.value)
    assert.equal(slots.length, 3)
    assert.equal(new Set(slots.map(s => s.directory)).size, 3)
    // New caller models a restarted manager: even a dead/unknown owner cannot be stolen.
    await assert.rejects(rentBrowserSlot(home, 3, 'browser'), /recovery-quarantined/)
    await slots[0]!.release()
    await mkdir(slots[0]!.directory)
    await writeFile(join(slots[0]!.directory, 'SingletonLock'), 'synthetic')
    await assert.rejects(rentBrowserSlot(home, 3, 'browser'), /browser-locked/)
  })
})

function fixture() {
  let next = 100
  const alive = new Set<number>()
  const profiles: string[] = []
  let stopFails = false
  let launchFails = false
  const runtime: ChromeRuntimeOperations = {
    getUserDataDir: () => null,
    detectChrome: async () => 'synthetic-browser',
    isDebugPortActive: async () => true,
    isProcessAlive: pid => alive.has(pid),
    async launchChrome(_exe, _port, profile) {
      profiles.push(profile)
      if (launchFails) return { error: 'unknown launch outcome' }
      const pid = next++; alive.add(pid); return { pid }
    },
    terminateChrome(pid) { if (stopFails) throw new Error('synthetic stop failure'); alive.delete(pid) },
  }
  // Ports are probed before launch, then used for existing-instance verification.
  runtime.isDebugPortActive = async port => alive.has(port - 9222 + 100)
  return { runtime, profiles, failStop: () => { stopFails = true }, allowStop: () => { stopFails = false }, failLaunch: () => { launchFails = true } }
}

test('manager instances share Project cap, successful release preserves slot, failed stop keeps it leased', async () => {
  await withTempWorkspace(async home => {
    const f = fixture()
    const allocator = new ChromePortAllocator(async () => true)
    const create = () => new ChromeManager(home, () => ({ basePort: 9222, slotCount: 1 }), { projectId: 'p', portAllocator: allocator, runtime: f.runtime })
    const a = create(), b = create()
    assert('port' in await a.allocate('instance-a'))
    assert('error' in await b.allocate('instance-b'))
    await writeFile(join(f.profiles[0]!, 'persistent'), 'session-data')
    f.failStop()
    await assert.rejects(a.release('instance-a'), /stop failure/)
    assert('error' in await b.allocate('instance-b'))
    f.allowStop()
    await a.release('instance-a')
    assert('port' in await b.allocate('instance-b'))
    assert.equal(f.profiles[0], f.profiles[1])
    assert.equal(await readFile(join(f.profiles[1]!, 'persistent'), 'utf8'), 'session-data')
    await a.releaseAll(); await b.releaseAll()
  })
})

test('unknown startup failure durably quarantines slot across manager restart without deleting data', async () => {
  await withTempWorkspace(async home => {
    const f = fixture(); f.failLaunch()
    const create = () => new ChromeManager(home, () => ({ basePort: 9222, slotCount: 1 }), { projectId: 'p', portAllocator: new ChromePortAllocator(async () => true), runtime: f.runtime })
    const a = create()
    const failed = await a.allocate('failed')
    assert('error' in failed && /unknown launch/.test(failed.error))
    await a.releaseAll()
    const b = create()
    const retry = await b.allocate('retry')
    assert('error' in retry && /capacity exhausted/.test(retry.error))
    const metadata = JSON.parse(await readFile(projectStoragePath(home, '.browser', 'slots', 'slot-1', 'slot.json'), 'utf8'))
    assert.equal(metadata.initialized, true)
    assert.equal(metadata.ownerPid, process.pid)
    await b.releaseAll()
  })
})

test('separate host processes cannot rent the same persistent slot', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { pathToFileURL } = await import('node:url')
  const { resolve } = await import('node:path')
  await withTempWorkspace(async home => {
    const source = pathToFileURL(resolve('src/browser/slot-pool.ts')).href
    const script = `import { rentBrowserSlot } from ${JSON.stringify(source)}; try { await rentBrowserSlot(${JSON.stringify(home)}, 1, 'synthetic'); console.log('rented') } catch { console.log('blocked') }`
    const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script])
    const outputs = await Promise.all([run(), run()])
    assert.deepEqual(outputs.map(o => o.stdout.trim()).sort(), ['blocked', 'rented'])
    // Both processes have exited; their durable claim is still not automatically stolen.
    await assert.rejects(rentBrowserSlot(home, 1, 'synthetic'), /recovery-quarantined/)
  })
})

test('successful stop request without confirmed PID exit does not return slot', async () => {
  await withTempWorkspace(async home => {
    const f = fixture()
    let alive = true
    f.runtime.isProcessAlive = () => alive
    f.runtime.terminateChrome = () => {}
    const allocator = new ChromePortAllocator(async () => true)
    const create = () => new ChromeManager(home, () => ({ basePort: 9222, slotCount: 1 }), { projectId: 'p', portAllocator: allocator, runtime: f.runtime })
    const a = create()
    assert('port' in await a.allocate('a'))
    await assert.rejects(a.release('a'), /has not exited; slot remains leased/)
    const b = create()
    const result = await b.allocate('b')
    assert('error' in result && /capacity exhausted/.test(result.error))
    alive = false
    await a.releaseAll(); await b.releaseAll()
  })
})
