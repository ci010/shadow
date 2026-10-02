import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Tools } from '../tools/registry.ts'
import { groupTools } from './tools-group.ts'

test('only consecutive confirmed reads share an execution group; mutations and unknown tools are ordered barriers', () => {
  const tools = new Tools('unused')
  for (const name of ['read', 'write']) tools.register({
    name, description: '', readonly: name === 'read',
    parameters: { type: 'object', properties: {} }, async execute() { return '' },
  })
  const names = ['read', 'read', 'write', 'write', 'unknown', 'read', 'read', 'write']
  const calls = names.map((name, index) => ({ id: String(index), name, arguments: {} }))
  assert.deepEqual(groupTools(calls, tools).map(group => ({
    readonly: group.readonly, ids: group.calls.map(call => call.id),
  })), [
    { readonly: true, ids: ['0', '1'] },
    { readonly: false, ids: ['2'] },
    { readonly: false, ids: ['3'] },
    { readonly: false, ids: ['4'] },
    { readonly: true, ids: ['5', '6'] },
    { readonly: false, ids: ['7'] },
  ])
  assert.deepEqual(groupTools([], tools), [])
})
