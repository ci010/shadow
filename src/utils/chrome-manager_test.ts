import assert from 'node:assert/strict'
import test from 'node:test'
import { isAbsolute, join, relative } from 'node:path'
import { ChromeManager, ChromePortAllocator, type ChromeRuntimeOperations } from './chrome-manager.ts'
import { createOrganizationScope } from '../otel/scope.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

test('host browser allocator reserves before async probes and stale lease release cannot free a replacement', async () => {
  const allocator = new ChromePortAllocator(async (port) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
    return port !== 9222
  })
  const [a, b] = await Promise.all([allocator.reserve(9222), allocator.reserve(9222)])
  try {
    assert.notEqual(a.port, b.port)
    assert(a.port > 9222 && b.port > 9222)
    await assert.rejects(allocator.reserve(9222, a.port), /No unreserved/)
    a.release()
    const replacement = await allocator.reserve(9222, a.port)
    a.release()
    await assert.rejects(allocator.reserve(9222, a.port), /No unreserved/)
    replacement.release()
    await assert.rejects(allocator.reserve(0), /Invalid Chrome debug port/)
  } finally {
    a.release()
    b.release()
  }
})

test('two organization browsers use distinct managed profiles and shared port leases without reusing host browsers', async () => {
  await withTempWorkspace(async (root) => {
    const active = new Map<number, number>()
    const launches: Array<{ port: number; profile: string; pid: number }> = []
    const stopped: number[] = []
    let pid = 1000
    const runtime: ChromeRuntimeOperations = {
      detectChrome: async () => 'synthetic-browser',
      isDebugPortActive: async (port) => active.has(port),
      isProcessAlive: (pid) => [...active.values()].includes(pid),
      async launchChrome(_exe, port, profile) {
        await new Promise<void>((resolve) => setTimeout(resolve, 3))
        const processId = ++pid
        launches.push({ port, profile, pid: processId })
        active.set(port, processId)
        return { pid: processId }
      },
      terminateChrome(pid) {
        stopped.push(pid)
        for (const [port, owner] of active) if (owner === pid) active.delete(port)
      },
    }
    const allocator = new ChromePortAllocator(async (port) => !active.has(port))
    const homes = [join(root, 'a'), join(root, 'b')]
    const managers = homes.map((home, i) => new ChromeManager(home, () => ({ basePort: 9222 }), {
      organizationId: i ? 'b' : 'a', portAllocator: allocator, runtime,
    }))
    try {
      const [a, b, duplicate] = await Promise.all([
        managers[0].allocate('same-session'), managers[1].allocate('same-session'), managers[0].allocate('same-session'),
      ])
      assert('port' in a && 'port' in b && 'port' in duplicate)
      assert.notEqual(a.port, b.port)
      assert.equal(duplicate.port, a.port)
      assert.equal(launches.length, 2)
      for (const [i, allocation] of [a, b].entries()) {
        const launch = launches.find((entry) => entry.port === allocation.port)!
        const path = relative(join(homes[i], '.browser'), launch.profile)
        assert(path && !path.startsWith('..') && !isAbsolute(path))
      }
      assert('error' in await managers[1].allocate('different-session', a.port))
      assert('error' in await managers[0].allocate('external-profile', undefined, join(root, 'host-profile')))
      active.set(9400, 9999)
      assert('error' in await managers[0].allocate('external-browser', 9400))
      assert(!stopped.includes(9999))
      await managers[0].releaseAll()
      assert.deepEqual(stopped, [launches.find((entry) => entry.port === a.port)!.pid])
      const remaining = await managers[1].allocate('same-session')
      assert('port' in remaining && remaining.port === b.port)
      assert('error' in await managers[0].allocate('late'))
      assert.equal(launches.length, 2)
    } finally {
      await Promise.all(managers.map((manager) => manager.releaseAll()))
    }
  })
})

test('organization browser shutdown aborts pending launch and releases its lease without publishing a session', async () => {
  await withTempWorkspace(async (home) => {
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    const stopped: number[] = []
    const allocator = new ChromePortAllocator(async () => true)
    const runtime: ChromeRuntimeOperations = {
      detectChrome: async () => 'synthetic-browser', isDebugPortActive: async () => false,
      isProcessAlive: () => true,
      async launchChrome(_exe, _port, _profile, signal) {
        entered.resolve(signal)
        await release.promise
        return { pid: 1234 }
      },
      terminateChrome: (pid) => { stopped.push(pid) },
    }
    const manager = new ChromeManager(home, () => ({ basePort: 9222 }), { organizationId: 'a', portAllocator: allocator, runtime })
    const pending = manager.allocate('same')
    const signal = await entered.promise
    const stopping = manager.releaseAll()
    assert.equal(signal.aborted, true)
    release.resolve()
    const result = await pending
    await stopping
    assert('error' in result && /stopped/.test(result.error))
    assert.deepEqual(stopped, [1234])
    const free = await allocator.reserve(9222, 9222)
    free.release()
  })
})

test('organization browser construction fails closed without the host allocator', () => {
  const scope = createOrganizationScope('a')
  assert.throws(() => scope.run(() => new ChromeManager('unused', () => ({ basePort: 9222 }))), /host-owned port allocator/)
  assert.throws(() => scope.run(() => new ChromeManager('unused', () => ({ basePort: 9222 }), {
    organizationId: 'b', portAllocator: new ChromePortAllocator(async () => true),
  })), /organization mismatch/)
  scope.close()
})
