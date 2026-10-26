import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { McpConnection } from '../mcp/client.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { CHROME_MCP_PACKAGE, chromeToolAllowed } from './chrome-contract.ts'

// Offline compatibility check against the shipped dependency; no browser operation,
// profile discovery, package download, or CDP connection occurs.
const packageDir = dirname(createRequire(import.meta.url).resolve('chrome-devtools-mcp/package.json'))

test('installed pinned Chrome package advertises compatible full and category-restricted schemas without a browser', {
  timeout: 90_000,
}, async t => withTempWorkspace(async home => {
  const manifest = JSON.parse(await readFile(join(packageDir!, 'package.json'), 'utf8'))
  assert.equal(`${manifest.name}@${manifest.version}`, CHROME_MCP_PACKAGE)
  const categories = ['emulation', 'performance', 'network']
  for (let mask = 0; mask < 8; mask++) {
    await t.test(`disabled capability mask ${mask}`, async () => {
      const flags = categories.filter((_category, bit) => mask & (1 << bit)).map(category => `--no-category-${category}`)
      const config = {
        name: 'chrome-devtools', transport: 'stdio' as const, command: process.execPath,
        args: [join(packageDir!, manifest.bin['chrome-devtools-mcp']),
          '--browser-url=http://127.0.0.1:1', '--page-id-routing',
          '--no-usage-statistics', '--no-performance-crux', ...flags],
      }
      const connection = new McpConnection(config, home)
      const signal = AbortSignal.timeout(10_000)
      try {
        await connection.connect(signal)
        // Deliberately never callTool: initialize/tools/list do not acquire CDP.
        const tools = await connection.listTools(signal)
        assert.equal(tools.length, [30, 28, 27, 25, 28, 26, 25, 23][mask], 'reviewed complete tool inventory')
        const visible = tools.filter(tool => chromeToolAllowed(config, tool))
        assert.equal(visible.length, tools.length - 1)
        assert.ok(tools.some(tool => tool.name === 'select_page'))
        assert.ok(!visible.some(tool => tool.name === 'select_page'))
        for (const name of ['click', 'fill', 'take_snapshot']) {
          const tool = visible.find(tool => tool.name === name)
          assert.ok(tool, name)
          const schema = tool.inputSchema as { required: string[]; properties: Record<string, { type: string }> }
          assert.ok(schema.required.includes('pageId'), name)
          assert.equal(schema.properties.pageId.type, 'number', name)
        }
        t.diagnostic(`mask=${mask}; upstream=${tools.length}; exposed=${visible.length}; tools=${visible.map(tool => tool.name).join(',')}`)
      } finally {
        await connection.disconnect()
      }
    })
  }
}))

test('installed autoConnect with userDataDir fails closed and disconnects without launch', {
}, async t => withTempWorkspace(async home => {
  const manifest = JSON.parse(await readFile(join(packageDir!, 'package.json'), 'utf8'))
  assert.equal(`${manifest.name}@${manifest.version}`, CHROME_MCP_PACKAGE)
  const { BrowserManager } = await import(pathToFileURL(join(packageDir!, 'build/src/BrowserManager.js')).href)
  const { puppeteer } = await import(pathToFileURL(join(packageDir!, 'build/src/third_party/index.js')).href)
  const launch = t.mock.method(puppeteer, 'launch', async () => { assert.fail('autoConnect must never launch') })
  const connect = t.mock.method(puppeteer, 'connect', async () => { throw new Error('synthetic unavailable target') })
  const manager = new BrowserManager({ autoConnect: true, channel: 'stable', userDataDir: home })
  try {
    // Only synthetic test data is read; no default profile lookup or real CDP.
    await assert.rejects(manager.ensureBrowser(), /Could not connect to Chrome in/)
    assert.equal(connect.mock.callCount(), 0)
    await writeFile(join(home, 'DevToolsActivePort'), '9222\n/devtools/browser/synthetic\n', 'utf8')
    await assert.rejects(manager.ensureBrowser(), /Could not connect to Chrome/)
    assert.equal(connect.mock.calls[0].arguments[0].browserWSEndpoint, 'ws://127.0.0.1:9222/devtools/browser/synthetic')
    let disconnected = 0
    connect.mock.mockImplementation(async () => ({
      connected: true,
      disconnect: async () => { disconnected++ },
      close: async () => { assert.fail('connected browser must not be closed') },
    }))
    await manager.ensureBrowser()
    await manager.close()
    assert.equal(disconnected, 1)
    assert.equal(launch.mock.callCount(), 0)
  } finally {
    await manager.close()
  }
}))
