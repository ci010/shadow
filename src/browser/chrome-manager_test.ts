import assert from 'node:assert/strict'
import test from 'node:test'
import { isAbsolute, join, relative } from 'node:path'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { ChromeManager, ChromePortAllocator, detectChrome, type BrowserKind, type BrowserLaunchOptions, type ChromeRuntimeOperations } from './chrome-manager.ts'
import { createProjectScope } from '../projects/scope.ts'
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

test('two project browsers use distinct managed profiles and shared port leases without reusing host browsers', async () => {
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
      projectId: i ? 'b' : 'a', portAllocator: allocator, runtime,
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

test('project browser shutdown aborts pending launch and releases its lease without publishing a session', async () => {
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
    const manager = new ChromeManager(home, () => ({ basePort: 9222 }), { projectId: 'a', portAllocator: allocator, runtime })
    const caller = new AbortController()
    const pending = manager.allocate('same', undefined, undefined, undefined, caller.signal)
    const signal = await entered.promise
    const stopping = manager.releaseAll()
    assert.equal(signal.aborted, true)
    assert.equal(caller.signal.aborted, false)
    release.resolve()
    const result = await pending
    await stopping
    assert('error' in result && /stopped/.test(result.error))
    assert.deepEqual(stopped, [1234])
    const free = await allocator.reserve(9222, 9222)
    free.release()
  })
})

test('project browser construction fails closed without the host allocator', () => {
  const scope = createProjectScope('a')
  assert.throws(() => scope.run(() => new ChromeManager('unused', () => ({ basePort: 9222 }))), /host-owned port allocator/)
  assert.throws(() => scope.run(() => new ChromeManager('unused', () => ({ basePort: 9222 }), {
    projectId: 'b', portAllocator: new ChromePortAllocator(async () => true),
  })), /project mismatch/)
  scope.close()
})

function syntheticRuntime(overrides: Partial<ChromeRuntimeOperations> = {}) {
  const active = new Map<number, number>()
  const detections: Array<{ path?: string; browser?: BrowserKind }> = []
  const launches: Array<{ path: string; port: number; profile: string; pid: number; signal: AbortSignal }> = []
  const stopped: number[] = []
  let nextPid = 2000
  const runtime: ChromeRuntimeOperations = {
    async detectChrome(path, browser) {
      detections.push({ path, browser })
      return path ?? `${browser ?? 'default'}-executable`
    },
    isDebugPortActive: async (port) => active.has(port),
    isProcessAlive: (pid) => [...active.values()].includes(pid),
    async launchChrome(path, port, profile, signal) {
      const pid = ++nextPid
      active.set(port, pid)
      launches.push({ path, port, profile, pid, signal })
      return { pid }
    },
    terminateChrome(pid) {
      stopped.push(pid)
      for (const [port, owner] of active) if (owner === pid) active.delete(port)
    },
    ...overrides,
  }
  return { runtime, active, detections, launches, stopped }
}

test('project sessions pin independent browser choices without changing the project default or copying profiles', async () => {
  await withTempWorkspace(async (home) => {
    const fixture = syntheticRuntime()
    const config = Object.freeze({ basePort: 9222, executablePath: 'project-default-executable' })
    const manager = new ChromeManager(home, () => config, {
      projectId: 'a', portAllocator: new ChromePortAllocator(async () => true), runtime: fixture.runtime,
    })
    try {
      const defaultAllocation = await manager.allocate('default')
      assert('port' in defaultAllocation)
      const choices: BrowserLaunchOptions[] = [
        { browser: 'chrome' }, { browser: 'edge' }, { browser: 'brave' }, { executablePath: 'custom-executable' },
      ]
      const results = await Promise.all(choices.map((choice, i) => manager.allocate(`session-${i}`, undefined, undefined, choice)))
      assert(results.every((result) => 'port' in result))
      assert.equal(new Set(fixture.launches.map((launch) => launch.port)).size, 5)
      assert.equal(new Set(fixture.launches.map((launch) => launch.profile)).size, 5)
      assert.deepEqual(fixture.detections, [
        { path: config.executablePath, browser: undefined },
        { path: undefined, browser: 'chrome' },
        { path: undefined, browser: 'edge' },
        { path: undefined, browser: 'brave' },
        { path: 'custom-executable', browser: undefined },
      ])
      const expectedPaths = ['chrome-executable', 'edge-executable', 'brave-executable', 'custom-executable']
      for (const [i, result] of results.entries()) {
        assert('port' in result)
        assert.equal(fixture.launches.find((launch) => launch.port === result.port)?.path, expectedPaths[i])
      }
      for (const launch of fixture.launches) {
        const path = relative(join(home, '.browser'), launch.profile)
        assert(path && !path.startsWith('..') && !isAbsolute(path))
        assert.deepEqual(await readdir(launch.profile), [])
      }
      assert.deepEqual(await manager.allocate('default', undefined, undefined, { browser: 'default' }), defaultAllocation)
      assert('port' in await manager.allocate('another-default'))
      assert.equal(fixture.launches.at(-1)?.path, config.executablePath)
      assert.equal(fixture.detections.length, 5, 'named and explicit choices do not overwrite the default executable cache')
      for (const [i, choice] of choices.entries()) {
        assert.deepEqual(await manager.allocate(`session-${i}`, undefined, undefined, choice), results[i])
        const conflict = await manager.allocate(`session-${i}`)
        assert('error' in conflict && /different browser launch options/.test(conflict.error))
      }
      assert.equal(config.executablePath, 'project-default-executable')
      await manager.release('session-0')
      assert('port' in await manager.allocate('session-0', undefined, undefined, { browser: 'brave' }))
    } finally {
      await manager.releaseAll()
    }
    assert.equal(fixture.active.size, 0)
  })
})

test('strict browser choices never fall back and invalid or legacy options do not launch', async () => {
  await withTempWorkspace(async (home) => {
    const attempts: Array<{ path?: string; browser?: BrowserKind }> = []
    const fixture = syntheticRuntime({
      async detectChrome(path, browser) {
        attempts.push({ path, browser })
        return null
      },
    })
    const manager = new ChromeManager(home, () => ({ basePort: 9222, executablePath: 'configured-browser' }), {
      projectId: 'a', portAllocator: new ChromePortAllocator(async () => true), runtime: fixture.runtime,
    })
    const legacy = new ChromeManager(home, () => ({ basePort: 9222 }), { runtime: fixture.runtime })
    try {
      for (const choice of [
        { browser: 'firefox' },
        { executablePath: '' },
        { executablePath: '   ' },
        { browser: 'edge', executablePath: 'custom' },
      ]) {
        assert('error' in await manager.allocate('invalid', undefined, undefined, choice as BrowserLaunchOptions))
      }
      for (const choice of [{ browser: 'default' }, { browser: 'edge' }, { executablePath: 'custom' }] as BrowserLaunchOptions[]) {
        const result = await legacy.allocate('legacy', undefined, undefined, choice)
        assert('error' in result && /project-managed isolated profile/.test(result.error))
      }
      assert.equal(attempts.length, 0)
      const pathResult = await manager.allocate('missing-path', undefined, undefined, { executablePath: 'missing-executable' })
      assert('error' in pathResult && /Selected browser executable not found/.test(pathResult.error))
      for (const browser of ['chrome', 'edge', 'brave'] as const) {
        const result = await manager.allocate(browser, undefined, undefined, { browser })
        assert('error' in result && result.error.includes(`Selected browser "${browser}" executable not found`))
      }
      assert.deepEqual(attempts, [
        { path: 'missing-executable', browser: undefined },
        { path: undefined, browser: 'chrome' },
        { path: undefined, browser: 'edge' },
        { path: undefined, browser: 'brave' },
      ])
      assert.equal(fixture.launches.length, 0)
    } finally {
      await Promise.all([manager.releaseAll(), legacy.releaseAll()])
    }
  })
})

test('native executable detection is strict for explicit missing paths, directories and conflicting selections', async () => {
  await withTempWorkspace(async (home) => {
    const executable = join(home, 'synthetic-browser')
    await writeFile(executable, 'not an actual browser')
    await mkdir(join(home, 'directory'))
    assert.equal(await detectChrome(executable), executable)
    assert.equal(await detectChrome(executable, 'default'), executable)
    assert.equal(await detectChrome(join(home, 'missing')), null)
    assert.equal(await detectChrome(join(home, 'directory')), null)
    assert.equal(await detectChrome(''), null)
    assert.equal(await detectChrome(executable, 'edge'), null)
    assert.equal(await detectChrome(undefined, 'invalid' as BrowserKind), null)
  })
})

test('default options preserve configured-executable fallback and executable caching', async () => {
  await withTempWorkspace(async (home) => {
    const attempts: Array<string | undefined> = []
    const fixture = syntheticRuntime({
      async detectChrome(path) {
        attempts.push(path)
        return path === 'missing' ? null : path ?? 'auto-detected'
      },
    })
    const config = { basePort: 9222, executablePath: 'missing' }
    const manager = new ChromeManager(home, () => config, {
      projectId: 'a', portAllocator: new ChromePortAllocator(async () => true), runtime: fixture.runtime,
    })
    try {
      assert('port' in await manager.allocate('a'))
      assert('port' in await manager.allocate('b', undefined, undefined, {}))
      assert.deepEqual(attempts, ['missing', undefined])
      assert.deepEqual(fixture.launches.map((launch) => launch.path), ['auto-detected', 'auto-detected'])
      config.executablePath = 'new-project-default'
      assert('port' in await manager.allocate('c'))
      assert.equal(fixture.launches.at(-1)?.path, config.executablePath)
      manager.invalidateCache()
      assert('port' in await manager.allocate('d'))
      assert.deepEqual(attempts, ['missing', undefined, 'new-project-default', 'new-project-default'])
    } finally {
      await manager.releaseAll()
    }
  })
})

test('pending allocations pin a snapshot of launch options and reject conflicts before detection', async () => {
  await withTempWorkspace(async (home) => {
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const detections: Array<BrowserKind | undefined> = []
    const fixture = syntheticRuntime({
      async detectChrome(_path, browser) {
        detections.push(browser)
        entered.resolve()
        await resume.promise
        return 'edge-executable'
      },
    })
    const manager = new ChromeManager(home, () => ({ basePort: 9222 }), {
      projectId: 'a', portAllocator: new ChromePortAllocator(async () => true), runtime: fixture.runtime,
    })
    const choices: BrowserLaunchOptions = { browser: 'edge' }
    const pending = manager.allocate('session', undefined, undefined, choices)
    try {
      await entered.promise
      choices.browser = 'brave'
      const same = manager.allocate('session', undefined, undefined, { browser: 'edge' })
      for (const choice of [undefined, choices, { executablePath: 'custom' }]) {
        const conflict = await manager.allocate('session', undefined, undefined, choice)
        assert('error' in conflict && /different browser launch options/.test(conflict.error))
      }
      assert.deepEqual(detections, ['edge'])
      resume.resolve()
      const result = await pending
      assert('port' in result)
      assert.deepEqual(await same, result)
      assert.equal(fixture.launches.length, 1)
      assert('error' in await manager.allocate('session', undefined, undefined, choices))
    } finally {
      resume.resolve()
      await manager.releaseAll()
    }
  })
})

test('caller cancellation before launch releases a reserved port without launching or pinning a session', async () => {
  await withTempWorkspace(async (home) => {
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let pause = true
    const allocator = new ChromePortAllocator(async () => {
      if (pause) {
        entered.resolve()
        await resume.promise
      }
      return true
    })
    const fixture = syntheticRuntime()
    const manager = new ChromeManager(home, () => ({ basePort: 9222 }), { projectId: 'a', portAllocator: allocator, runtime: fixture.runtime })
    const controller = new AbortController()
    const pending = manager.allocate('session', 9222, undefined, { browser: 'edge' }, controller.signal)
    try {
      await entered.promise
      controller.abort(new Error('caller cancelled'))
      pause = false
      resume.resolve()
      const result = await pending
      assert('error' in result && /caller cancelled/.test(result.error))
      assert.equal(fixture.launches.length, 0)
      assert('port' in await manager.allocate('session', 9222, undefined, { browser: 'brave' }))
      const aborted = AbortSignal.abort()
      assert('error' in await manager.allocate('already-cancelled', undefined, undefined, {}, aborted))
      assert.equal(fixture.launches.length, 1)
    } finally {
      resume.resolve()
      await manager.releaseAll()
    }
  })
})

test('caller cancellation during startup or immediately after launch terminates owned processes and frees leases', async () => {
  for (const timing of ['during-startup', 'after-launch'] as const) {
    await withTempWorkspace(async (home) => {
      const entered = Promise.withResolvers<AbortSignal>()
      const resume = Promise.withResolvers<void>()
      const controller = new AbortController()
      const allocator = new ChromePortAllocator(async () => true)
      const stopped: number[] = []
      let cancel = true
      const fixture = syntheticRuntime({
        async launchChrome(_path, _port, _profile, signal) {
          entered.resolve(signal)
          if (cancel) {
            if (timing === 'during-startup') await resume.promise
            else controller.abort()
          }
          return { pid: 3000 }
        },
        terminateChrome: (pid) => { stopped.push(pid) },
      })
      const manager = new ChromeManager(home, () => ({ basePort: 9222 }), { projectId: 'a', portAllocator: allocator, runtime: fixture.runtime })
      const pending = manager.allocate('session', 9222, undefined, { browser: 'edge' }, controller.signal)
      try {
        const launchSignal = await entered.promise
        if (timing === 'during-startup') controller.abort()
        assert.equal(launchSignal.aborted, true)
        resume.resolve()
        const result = await pending
        assert('error' in result && /cancelled/.test(result.error))
        assert.deepEqual(stopped, [3000])
        await manager.release('session')
        assert.deepEqual(stopped, [3000], 'cancelled allocation leaves no published session')
        const lease = await allocator.reserve(9222, 9222)
        lease.release()
        cancel = false
        assert('port' in await manager.allocate('session', 9222, undefined, { browser: 'chrome' }))
      } finally {
        resume.resolve()
        await manager.releaseAll()
      }
      assert.deepEqual(stopped, [3000, 3000])
    })
  }
})

test('cancellation of a matching pending caller is propagated and failed startup releases its lease', async () => {
  await withTempWorkspace(async (home) => {
    const entered = Promise.withResolvers<AbortSignal>()
    const allocator = new ChromePortAllocator(async () => true)
    const fixture = syntheticRuntime({
      async launchChrome(_path, _port, _profile, signal) {
        entered.resolve(signal)
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { error: 'startup cancelled' }
      },
    })
    const manager = new ChromeManager(home, () => ({ basePort: 9222 }), { projectId: 'a', portAllocator: allocator, runtime: fixture.runtime })
    const controller = new AbortController()
    const pending = manager.allocate('session')
    try {
      const launchSignal = await entered.promise
      const duplicate = manager.allocate('session', undefined, undefined, {}, controller.signal)
      await Promise.resolve()
      controller.abort()
      assert.equal(launchSignal.aborted, true)
      const results = await Promise.all([pending, duplicate])
      assert.deepEqual(results, [{ error: 'startup cancelled' }, { error: 'startup cancelled' }])
      assert.deepEqual(fixture.stopped, [])
      const lease = await allocator.reserve(9222, 9222)
      lease.release()
    } finally {
      await manager.releaseAll()
    }
  })
})
