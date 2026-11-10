import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentsHandler } from './agents.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { AgentTypeDefinition } from '../agent/types/types.ts'

test('agent VFS hides internal roles from read and discovery but keeps general', async () => {
  const role = (name: string, root = false): AgentTypeDefinition => ({
    name, description: name, prompt: name, defaultMode: 'session', source: 'builtin', root,
  })
  const handlers = createAgentsHandler({ all: () => [role('general', true), role('sub'), role('dispatcher', true)] })
  const context = { signal: new AbortController().signal } as ExecutionContext
  const all = await handlers.read('', context)
  assert.match(all, /general/)
  assert.match(all, /sub/)
  assert.doesNotMatch(all, /dispatcher/)
  assert.deepEqual((await handlers.list(context, { content: false })).map(entry => entry.name), ['general', 'sub'])
  assert.deepEqual(await handlers.list(context, { subpath: 'dispatcher' }), [])
  assert.throws(() => handlers.read('dispatcher', context), /Unknown or unavailable/)
})
