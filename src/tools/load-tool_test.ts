import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { ImportTool, type LoadableEntry, type McpLoadable } from './load-tool.ts'
import { SessionTools, Tools } from './registry.ts'
import { McpConnection } from '../mcp/client.ts'
import { ChromeManager, ChromePortAllocator, type ChromeRuntimeOperations } from '../browser/chrome-manager.ts'
import { createOrganizationScope } from '../organizations/scope.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from './context.ts'

function entry(chromeManager?: ChromeManager): McpLoadable {
  return {
    config: { name: 'chrome-devtools', transport: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@latest'] },
    chromeManager,
  }
}

function catalog(browser: McpLoadable): Map<string, LoadableEntry> {
  return new Map([
    ['chrome-devtools', browser],
    ['chrome-devtools-full', { config: browser.config, sharedConn: browser, configPath: browser.configPath }],
  ])
}

test('scoped built-in Chrome rejects all unowned connection/launch forms from every argument source before allocating or connecting', async (t) => {
  await withTempWorkspace(async (home) => {
    const manager = new ChromeManager(home, () => ({ basePort: 9222 }), {
      organizationId: 'a', portAllocator: new ChromePortAllocator(async () => true),
    })
    const allocate = t.mock.method(manager, 'allocate', async () => { throw new Error('must not allocate') })
    const connect = t.mock.method(McpConnection.prototype, 'connect', async () => { throw new Error('must not connect') })
    const flags = [
      ['--browserUrl=http://127.0.0.1:9222'], ['--browserUrl', 'http://127.0.0.1:9222'],
      ['--browser-url=http://127.0.0.1:9222'], ['-u', 'http://127.0.0.1:9222'],
      ['--wsEndpoint=ws://127.0.0.1:9222/devtools/browser/other'], ['--ws-endpoint', 'ws://other'],
      ['-w', 'ws://other'], ['--autoConnect'], ['--auto-connect=true'],
      ['--user-data-dir=host-profile'], ['--userDataDir', 'host-profile'],
      ['--executablePath=host-browser'], ['--channel=stable'], ['--chromeArg=--user-data-dir=host'],
      ['--', '--browserUrl=http://other'], ['--remote-debugging-port=0'],
      ['--remote-debugging-port=9222junk'], ['--remote-debugging-port=9222', '--remote-debugging-port=9223'],
      ['--future-endpoint=other'],
    ]
    for (const source of ['caller', 'persistent', 'base']) {
      for (const args of flags) {
        const browser = entry(manager)
        if (source === 'base') browser.config.args!.push(...args)
        if (source === 'persistent') {
          browser.configPath = join(home, 'synthetic-chrome.json')
          await writeFile(browser.configPath, JSON.stringify({ args }))
        }
        const importer = new ImportTool(catalog(browser), home, manager)
        const tools = new SessionTools(new Tools(home), home)
        for (const name of ['chrome-devtools', 'chrome-devtools-full']) {
          assert.match(await importer.importSource({
            source: `v:tools/${name}`, args: source === 'caller' ? args : [],
          }, tools), /^Error loading organization Chrome:/)
        }
      }
    }
    assert.equal(allocate.mock.callCount(), 0)
    assert.equal(connect.mock.callCount(), 0)
    const browser = entry(manager)
    browser.configPath = join(home, 'malformed-chrome.json')
    const importer = new ImportTool(catalog(browser), home, manager)
    for (const malformed of ['{', '{}', '{"args":[null]}', 'null']) {
      await writeFile(browser.configPath, malformed)
      assert.match(await importer.importSource({ source: 'v:tools/chrome-devtools-full' },
        new SessionTools(new Tools(home), home)), /^Error loading organization Chrome config:/)
    }
    assert.equal(allocate.mock.callCount(), 0)
    assert.equal(connect.mock.callCount(), 0)
    await manager.releaseAll()
  })
})

test('built-in Chrome requires an exact organization manager even through shared aliases and cached auto-imports', async (t) => {
  const scope = createOrganizationScope('a')
  const otherScope = createOrganizationScope('b')
  const manager = new ChromeManager('unused', () => ({ basePort: 9222 }), {
    organizationId: 'b', portAllocator: new ChromePortAllocator(async () => true),
  })
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => { throw new Error('must not connect') })
  try {
    for (const browser of [entry(), entry(manager)]) {
      const importer = scope.run(() => new ImportTool(catalog(browser), 'unused'))
      const tools = new SessionTools(new Tools('unused'), 'unused')
      assert.match(await importer.importSource({ source: 'v:tools/chrome-devtools-full' }, tools), /requires its own runtime-managed browser/)
      assert.match((await importer.importForInvocation('chrome-devtools__take_snapshot', tools))!, /requires its own runtime-managed browser/)
    }
    const importer = otherScope.run(() => new ImportTool(catalog(entry(manager)), 'unused', manager))
    const tools = new SessionTools(new Tools('unused'), 'unused')
    assert.match(await scope.run(() => importer.importSource({ source: 'v:tools/chrome-devtools' }, tools)), /requires its own runtime-managed browser/)
    assert.match(await importer.execute({ source: 'v:tools/chrome-devtools' },
      { organizationId: 'a', tools } as ExecutionContext), /Chrome organization binding mismatch/)
    const replacement = createOrganizationScope('b')
    try {
      assert.match(await replacement.run(() => importer.importSource({ source: 'v:tools/chrome-devtools' }, tools)),
        /requires its own runtime-managed browser/)
    } finally {
      replacement.close()
    }
    otherScope.close()
    assert.match(await importer.importSource({ source: 'v:tools/chrome-devtools' }, tools), /requires its own runtime-managed browser/)
    assert.equal(connect.mock.callCount(), 0)
  } finally {
    scope.close()
    otherScope.close()
    await manager.releaseAll()
  }
})

test('managed imports allocate distinct browsers per org and session, reuse aliases, and release only the resetting session', async (t) => {
  await withTempWorkspace(async (home) => {
    const live = new Map<number, number>()
    const launches: Array<{ port: number; profile: string }> = []
    const terminated: number[] = []
    let nextPid = 100
    const runtime: ChromeRuntimeOperations = {
      detectChrome: async () => 'synthetic-browser',
      isDebugPortActive: async (port) => live.has(port),
      isProcessAlive: (pid) => [...live.values()].includes(pid),
      async launchChrome(_path, port, profile) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
        launches.push({ port, profile })
        const pid = ++nextPid
        live.set(port, pid)
        return { pid }
      },
      terminateChrome(pid) {
        assert(!terminated.includes(pid), 'an owned process must be terminated only once')
        terminated.push(pid)
        for (const [port, owner] of live) if (owner === pid) live.delete(port)
      },
    }
    const allocator = new ChromePortAllocator(async (port) => !live.has(port))
    const managers = ['a', 'b'].map((organizationId) => new ChromeManager(join(home, organizationId),
      () => ({ basePort: 9222 }), { organizationId, portAllocator: allocator, runtime }))
    const connect = t.mock.method(McpConnection.prototype, 'connect', async function (this: McpConnection) {
      assert.equal(this.config.args?.filter((arg) => arg.startsWith('--browserUrl=')).length, 1)
      assert(!this.config.args?.some((arg) => arg.startsWith('--remote-debugging-port')))
    })
    t.mock.method(McpConnection.prototype, 'listTools', async () => [
      { name: 'take_snapshot', description: '', inputSchema: { type: 'object' } },
    ])
    t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
    const importers = managers.map((manager) => new ImportTool(catalog(entry(manager)), home, manager))
    const sessions = [0, 1, 2].map(() => new SessionTools(new Tools(home), home))
    try {
      const results = await Promise.all([
        importers[0].importSource({ source: 'v:tools/chrome-devtools' }, sessions[0]),
        importers[1].importSource({ source: 'v:tools/chrome-devtools' }, sessions[1]),
        importers[0].importSource({ source: 'v:tools/chrome-devtools' }, sessions[2]),
      ])
      for (const result of results) assert.match(result, /^Loaded 1 tool/)
      assert.equal(new Set(launches.map((launch) => launch.port)).size, 3)
      assert.equal(new Set(launches.map((launch) => launch.profile)).size, 3)
      assert.match(await importers[0].importSource({ source: 'v:tools/chrome-devtools-full' }, sessions[0]), /^Loaded 1 tool/)
      assert.equal(launches.length, 3)
      assert.equal(connect.mock.callCount(), 3)
      assert.match(await importers[0].importSource({
        source: 'v:tools/chrome-devtools-full', args: ['--autoConnect'],
      }, sessions[0]), /^Error loading organization Chrome:/)
      assert.equal(connect.mock.callCount(), 3)
      assert.equal(launches.length, 3)
      sessions[0].resetDynamic()
      await t.waitFor(() => assert.equal(live.size, 2))
      assert.match(await importers[1].importSource({ source: 'v:tools/chrome-devtools-full' }, sessions[1]), /^Loaded 1 tool/)
      assert.equal(launches.length, 3)
      assert.match(await importers[0].importSource({
        source: 'v:tools/chrome-devtools', args: ['--remote-debugging-port', '9400', '--no-usage-statistics'],
      }, sessions[0]), /^Loaded 1 tool/)
      assert.equal(launches.at(-1)?.port, 9400)
    } finally {
      for (const session of sessions) session.resetDynamic()
      await Promise.all(managers.map((manager) => manager.releaseAll()))
      assert.equal(terminated.length, launches.length)
    }
  })
})

test('legacy non-org explicit browser connections are preserved without managed allocation', async (t) => {
  const manager = new ChromeManager('unused', () => ({ basePort: 9222 }))
  const allocate = t.mock.method(manager, 'allocate', async () => { throw new Error('must not allocate') })
  const connect = t.mock.method(McpConnection.prototype, 'connect', async function (this: McpConnection) {
    assert(this.config.args?.includes('--browserUrl=http://127.0.0.1:9333'))
  })
  t.mock.method(McpConnection.prototype, 'listTools', async () => [])
  t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
  const tools = new SessionTools(new Tools('unused'), 'unused')
  try {
    assert.match(await new ImportTool(catalog(entry(manager)), 'unused', manager).importSource({
      source: 'v:tools/chrome-devtools', args: ['--browserUrl=http://127.0.0.1:9333'],
    }, tools), /^Loaded 0 tool/)
    assert.equal(allocate.mock.callCount(), 0)
    assert.equal(connect.mock.callCount(), 1)
  } finally {
    tools.resetDynamic()
    await manager.releaseAll()
  }
})
