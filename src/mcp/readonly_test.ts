import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { McpServerConfig } from '../config/schema.ts'
import { McpConnection, type McpToolInfo } from './client.ts'
import { McpToolAdapter } from './adapter.ts'
import { mcpReadOnlyPolicy } from './readonly.ts'

const config: McpServerConfig = { name: 'fixture', transport: 'stdio', command: 'never-run' }
const tool: McpToolInfo = { name: 'get_record', description: 'Read a record', inputSchema: { type: 'object' } }

test('MCP readonly classification defaults to unknown and only trusts explicit server policy', () => {
  for (const trustReadOnlyHints of [undefined, false, true]) {
    for (const readOnlyHint of [undefined, false, true]) {
      const info = { ...tool, ...(readOnlyHint === undefined ? {} : { readOnlyHint }) }
      const server = { ...config, trustReadOnlyHints }
      const expected = trustReadOnlyHints === true ? readOnlyHint : undefined
      assert.equal(mcpReadOnlyPolicy(server, info).readOnly, expected)
      assert.equal(new McpToolAdapter(new McpConnection(server), info).readonly, expected)
    }
  }
  assert.equal(mcpReadOnlyPolicy(config, tool).source, 'unknown', 'A get_ name is not evidence of read-only behavior')
  assert.equal(mcpReadOnlyPolicy(config, { ...tool, readOnlyHint: true }).source, 'untrusted-hint')
})

test('reviewed overrides take precedence in both directions and stale reviews never fall back to hints', () => {
  for (const readOnly of [false, true]) {
    const info = { ...tool, readOnlyHint: !readOnly, serverVersion: { name: 'fixture', version: '1' } }
    const fingerprint = mcpReadOnlyPolicy(config, info).fingerprint
    const server = { ...config, trustReadOnlyHints: true, readOnlyOverrides: { [tool.name]: { readOnly, fingerprint } } }
    assert.deepEqual(mcpReadOnlyPolicy(server, info), { readOnly, fingerprint, source: 'reviewed-override' })
    for (const changed of [
      { ...info, description: 'Changed behavior' },
      { ...info, inputSchema: { type: 'object', properties: { write: { type: 'boolean' } } } },
      { ...info, readOnlyHint: !info.readOnlyHint },
      { ...info, serverVersion: { name: 'fixture', version: '2' } },
    ]) {
      assert.equal(mcpReadOnlyPolicy(server, changed).readOnly, undefined)
      assert.equal(mcpReadOnlyPolicy(server, changed).source, 'stale-review')
    }
    assert.equal(mcpReadOnlyPolicy({ ...server, name: 'other' }, info).source, 'stale-review')
  }
})

test('review fingerprints are stable metadata identities, not public hashes of secrets', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } }
  const info = { ...tool, inputSchema: schema }
  const first = mcpReadOnlyPolicy(config, info).fingerprint
  assert.equal(mcpReadOnlyPolicy(config, { ...info, inputSchema: {
    properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object',
  } }).fingerprint, first)
  assert.equal(mcpReadOnlyPolicy({ ...config, env: { TOKEN: 'synthetic-private-value' } }, info).fingerprint, first)
})
