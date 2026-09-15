import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import type { ExecutionContext } from '../agent/agent.ts'
import { groupTools } from '../utils/tools-group.ts'
import { Tools, SessionTools } from './registry.ts'
import { SearchTool } from './search.ts'
import type { Tool } from './tool.ts'

test('unified search keeps web dispatch, file/web query validation and source errors', async t => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const home = await mkdtemp(resolve('.tmp', 'search-dispatch-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const calls: Record<string, unknown>[] = []
  const web: Tool = {
    name: 'web', description: '', parameters: { type: 'object', properties: {} },
    execute: async args => { calls.push(args); return 'x'.repeat(13_000) },
  }
  const base = new Tools(home)
  base.register(new SearchTool(home, web))
  const tools = new SessionTools(base, home)
  const context = { tools, signal: new AbortController().signal } as ExecutionContext
  const result = await tools.execute('search', { space: 'web:example.com', query: 'docs' }, context)
  assert.deepEqual(calls, [{ query: 'docs site:example.com' }])
  assert.match(result, /\[truncated:/)
  for (const space of ['grep:*.ts', 'glob:src', 'web:']) {
    assert.match(await tools.execute('search', { space }, context), /query must be a string/)
  }
  assert.match(await tools.execute('search', { space: 'tools:' }, context), /discovery is not configured/)
  assert.match(await tools.execute('search', { space: 'unknown:', query: '' }, context), /Unknown search space/)
})

test('only file and web search remain parallel reads; tool discovery keeps import ordering', () => {
  const base = new Tools('.')
  base.register(new SearchTool('.'))
  const calls = ['grep:*.ts', 'glob:src', 'web:', 'tools:', 'tools:mail', 'web:example.com']
    .map((space, i) => ({ id: String(i), name: 'search', arguments: { space, query: '' } }))
  const groups = groupTools(calls, base)
  assert.deepEqual(groups.map(group => ({ readonly: group.readonly, ids: group.calls.map(call => call.id) })), [
    { readonly: true, ids: ['0', '1', '2'] },
    { readonly: false, ids: ['3', '4'] },
    { readonly: true, ids: ['5'] },
  ])
  assert.equal(base.isReadonly('search'), false)
})
