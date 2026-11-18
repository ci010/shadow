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

test('Web role preview is explicit, read-only and restricted to visible Knowledge roles and authorized readers', async () => {
  const role = (name: string, root = false): AgentTypeDefinition => ({
    name, description: name, prompt: name, defaultMode: 'session', source: 'builtin', root,
  })
  const general = role('general', true)
  const dispatcher = role('dispatcher', true)
  const bot = role('bot-role')
  const owner = { signal: new AbortController().signal, admin: true } as ExecutionContext
  const other = { ...owner, admin: false }
  const calls: unknown[] = []
  const handlers = createAgentsHandler({ all: () => [general, dispatcher, bot] }, undefined, {
    types: { knowledgeDefinitions: () => [general, dispatcher] },
    canRead: context => context.admin === true,
    sessions: { getContext: async args => {
      calls.push(args)
      return { source: 'preview', rolePreview: 'owner-web', systemPrompt: 'one\ntwo', sections: [], tools: [] }
    } },
  })
  const path = 'general/context/web'
  assert.deepEqual((await handlers.list(owner, { subpath: 'general' })).map(entry => entry.name),
    ['general', path, `${path}/system-prompt`])
  assert.deepEqual(await handlers.list(other, { subpath: path }), [])
  assert.throws(() => handlers.read(path, other), /Project owner/)
  for (const bad of ['dispatcher/context/web', 'bot-role/context/web', 'a2a:remote/context/web', 'general/context/discord']) {
    assert.throws(() => handlers.read(bad, owner), /Unknown or unavailable/)
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(JSON.parse(await handlers.read(path, owner)), {
    agentType: 'general', channel: 'web', source: 'preview', rolePreview: 'owner-web', systemPrompt: 'one\ntwo', sections: [],
  })
  assert.equal(await handlers.read(`${path}/system-prompt`, owner), 'one\ntwo')
  const request = { agentType: 'general', channel: 'web', rolePreview: 'owner-web' }
  assert.deepEqual(calls, [request, request])
})
