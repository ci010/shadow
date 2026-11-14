import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../../src/bus/bus.ts'
import { WebChannel } from '../../src/channels/web.ts'
import { withTempWorkspace } from '../../src/testing/workspace.ts'
import { WorkflowRuntime } from '../../src/workflows/runtime.ts'
import { workflowReferenceResolver } from '../../src/workflows/references.ts'
import type { Definition } from '../../src/workflows/contracts.ts'
import { captureInputReferences, workflowInputReference } from './workflow-input-references.ts'

test('renderer historical selector reaches real web admission and retains the actual runtime snapshot in user history', async () => withTempWorkspace(async directory => {
  const runtime = new WorkflowRuntime(directory, 'p', { canUse: () => true, deliver: async () => { throw Error('unused') } })
  const definition: Definition = { id: 'flow', revision: 1, name: 'Historic name', owner: 'owner', enabled: true, binding: { demand: {} }, source: { kind: 'external', id: 'signal' }, gate: { kind: 'revision-dedupe', first: 'emit' }, nodes: [{ kind: 'record' }] }
  runtime.start(true); runtime.bindExternal(() => true)
  const bus = new Bus()
  const channel = new WebChannel(bus, { authorize: () => true, resolveInputReferences: workflowReferenceResolver('p', runtime) })
  const history: string[] = []
  channel.setReceiver(async message => {
    history.push(message.content)
    bus.emit('message.outbound', { event: 'response', channel: 'web', chatId: message.chatId, replyTo: message.messageId, done: true, content: 'ok' })
    return { status: 'accepted', sessionId: `web:${message.chatId}`, inputId: message.messageId }
  })
  const app = new Hono(); await channel.start(app)
  try {
    runtime.define(definition)
    runtime.admit([{ workflow: 'flow', source: definition.source, observations: [{ id: 'obs', data: {} }] }])
    const run = runtime.inspect().runs[0]!
    const item = workflowInputReference('p', definition, 'node-0', run)!
    runtime.bindSourceAuthorizer((_owner, value) => value)
    const { owner: _owner, revision: _revision, ...authorInput } = definition
    runtime.author('owner', { ...authorInput, name: 'Current changed name', nodes: [{ kind: 'transform', code: 'NEW_CODE' }] }, 1)
    const post = (body: object) => app.request('/api/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const references = captureInputReferences([item])
    const response = await post({ chatId: 'chat-ordinary', content: 'Inspect this node', delivery: 'queue', references })
    assert.equal(response.status, 200)
    assert.match(history[0]!, /Inspect this node/)
    assert.match(history[0]!, /Historic name/)
    assert.match(history[0]!, /"nodeKind":"record"/)
    assert.equal(history[0]!.includes('NEW_CODE'), false)
    assert.equal(history[0]!.includes('Current changed name'), false)
    const frozen = history[0]
    item.reference.revision = 2
    assert.equal(history[0], frozen)
    assert.equal((await post({ chatId: 'chat-ordinary', retry: true, references })).status, 400)
    assert.equal(history.length, 1, 'replacing frozen retry context is never admitted')
    assert.equal((await post({ chatId: 'chat-ordinary', content: 'Ordinary without refs' })).status, 200)
    assert.equal(history[1], 'Ordinary without refs')
  } finally { await channel.stop(); await runtime.stop() }
}))
