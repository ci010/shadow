import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { ImportTool, type LoadableEntry, type McpLoadable } from './load-tool.ts'
import { SessionTools, Tools } from './registry.ts'
import { McpConnection } from '../mcp/client.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from './context.ts'
import { InvokeTool } from './invoke-tool.ts'
import { CHROME_MCP_PACKAGE, chromeToolAllowed, validateChromeCall } from '../browser/chrome-contract.ts'

const config = { name: 'chrome-devtools', transport: 'stdio' as const, command: 'npx', args: [CHROME_MCP_PACKAGE] }

test('all config argument sources reject launch and implicit routing before MCP connect', async t => withTempWorkspace(async home => {
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => { throw new Error('must not connect') })
  const flags = ['--slim', '--slim=true', '--no-page-id-routing', '--pageIdRouting=false', '--page-id-routing=false',
    '--browserUrl=http://127.0.0.1:9222', '-u', '--wsEndpoint=ws://localhost:9222', '--auto-connect',
    '--user-data-dir=profile', '--executablePath=browser', '--remote-debugging-port=9222', '--channel=stable', '--future-flag']
  for (const source of ['base', 'persistent']) for (const flag of flags) {
    const entry: McpLoadable = { config: { ...config, args: [...config.args] } }
    if (source === 'base') entry.config.args!.push(flag)
    else { entry.configPath = join(home, 'synthetic.json'); await writeFile(entry.configPath, JSON.stringify({ args: [flag] })) }
    const importer = new ImportTool(new Map<string, LoadableEntry>([['chrome-devtools', entry]]), home, 'p')
    const base = new Tools(home); base.register(new InvokeTool(importer))
    const tools = new SessionTools(base, home)
    const ctx = { tools, projectId: 'p', signal: new AbortController().signal } as ExecutionContext
    const result = await tools.execute('invoke_tool', { name: 'browser_setup', args: { action: 'attach', endpoint: 'http://localhost:9555' } }, ctx)
    assert.match(String(result), /only reviewed/)
    await tools.resetDynamicAndWait()
  }
  assert.equal(connect.mock.callCount(), 0)
}))

test('unsupported version, command, and malformed persistent config fail closed', async t => withTempWorkspace(async home => {
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => { throw new Error('must not connect') })
  for (const change of [{ args: ['chrome-devtools-mcp@latest'] }, { args: ['chrome-devtools-mcp@1.9.0'] }, { command: 'other' }]) {
    const importer = new ImportTool(new Map<string, LoadableEntry>([['chrome-devtools', { config: { ...config, ...change } }]]), home, 'p')
    const base = new Tools(home); base.register(new InvokeTool(importer))
    const tools = new SessionTools(base, home)
    const ctx = { tools, projectId: 'p', signal: new AbortController().signal } as ExecutionContext
    assert.match(String(await tools.execute('invoke_tool', { name: 'browser_setup', args: { action: 'autoConnect', channel: 'stable' } }, ctx)), /reviewed npx/)
    await tools.resetDynamicAndWait()
  }
  assert.equal(connect.mock.callCount(), 0)
}))

test('adapter defense rejects selected-page tools and missing/malformed page IDs, generic MCP unaffected', () => {
  const page = { name: 'click', description: '', inputSchema: { type: 'object', properties: { pageId: { type: 'number' } }, required: ['pageId'] } }
  assert.equal(chromeToolAllowed(config, { ...page, name: 'select_page' }), false)
  assert.throws(() => validateChromeCall(config, { ...page, name: 'select_page' }, { pageId: 1 }), /disabled/)
  for (const pageId of [undefined, null, '1', -1, 0.5, Infinity, NaN]) assert.throws(() => validateChromeCall(config, page, { pageId }), /pageId/)
  validateChromeCall(config, page, { pageId: 1 })
  assert.throws(() => chromeToolAllowed(config, { ...page, inputSchema: { type: 'object', properties: {} } }), /required pageId/)
  validateChromeCall({ ...config, name: 'generic' }, { ...page, name: 'select_page' }, {})
})
