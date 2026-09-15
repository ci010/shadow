import assert from 'node:assert/strict'
import { test } from 'node:test'
import { McpSchema } from '../config/schema.ts'
import { parseMcpServerConfig } from './config.ts'

test('MCP config normalizes external and internal transports and legacy stdio', () => {
  assert.deepEqual(parseMcpServerConfig('local', { command: 'node', args: ['fixture.js'] }), {
    name: 'local', transport: 'stdio', command: 'node', args: ['fixture.js'],
  })
  for (const transport of ['sse', 'streamable-http'] as const) {
    const options = {
      url: 'https://example.invalid/mcp',
      headers: { Authorization: 'synthetic-token' },
      description: 'Fixture tools',
    }
    const expected = { name: 'remote', transport, ...options }
    assert.deepEqual(parseMcpServerConfig('remote', { type: transport, ...options }), expected)
    assert.deepEqual(parseMcpServerConfig('remote', expected), expected)
    assert.deepEqual(parseMcpServerConfig('remote', { type: transport, ...expected }), expected)
    assert.deepEqual(McpSchema.parse({ remote: { type: transport, ...options } }), { servers: [expected] })
  }
  assert.deepEqual(McpSchema.parse(undefined), { servers: [] })
})

test('MCP config rejects malformed entries and ambiguous identifiers', () => {
  for (const input of [
    undefined, null, [], 'node', {}, { command: '' }, { command: '  ' },
    { type: 'invalid', command: 'node' },
    { type: 'stdio', transport: 'sse', command: 'node', url: 'https://example.invalid' },
    { type: 'sse' }, { transport: 'streamable-http', url: 'file:///fixture' },
    { type: 'sse', url: 'not a URL' },
    { command: 'node', args: [1] }, { command: 'node', env: { TOKEN: 1 } },
    { type: 'sse', url: 'https://example.invalid', headers: { Authorization: 1 } },
    { command: 'node', name: 'another' },
  ]) {
    assert.throws(() => parseMcpServerConfig('fixture', input))
    assert.equal(McpSchema.safeParse({ fixture: input }).success, false)
  }
  for (const name of ['', ' ', ' a', 'a b', 'a__b', 'a\nb']) {
    assert.throws(() => parseMcpServerConfig(name, { command: 'node' }))
  }
})

test('MCP config strips unknown fields and reports record-key validation paths', () => {
  assert.deepEqual(parseMcpServerConfig('fixture', { command: 'node', privateToken: 'secret' }), {
    name: 'fixture', transport: 'stdio', command: 'node',
  })
  const result = McpSchema.safeParse({ fixture: { type: 'sse' } })
  assert.equal(result.success, false)
  if (!result.success) assert.deepEqual(result.error.issues[0].path, ['fixture', 'url'])
})
