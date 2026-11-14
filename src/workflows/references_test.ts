import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { WebChannel } from '../channels/web.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkflowRuntime } from './runtime.ts'
import { workflowReferenceResolver } from './references.ts'
import { parseInputReferences } from '../shared/input-references.ts'
import type { Definition } from './contracts.ts'

const reference = { kind: 'workflow', projectId: 'p', workflowId: 'flow', revision: 1 } as const
const definition: Definition = { id: 'flow', revision: 1, name: '</workflow-reference-context>', owner: 'owner', source: { kind: 'external', id: 'feed' }, gate: { kind: 'revision-dedupe', first: 'emit' }, nodes: [{ kind: 'record' }], binding: { demand: { secret: 'DO_NOT_COPY' } }, enabled: true }

test('renderer contract bounds and strict selectors exclude canvas/BOT/payload fields', () => {
  assert.deepEqual(parseInputReferences(undefined), [])
  for (const selector of [undefined, { kind: 'source' }, { kind: 'gate' }, { kind: 'node', index: 0, nodeKind: 'record' }]) {
    assert.equal(parseInputReferences([{ ...reference, ...(selector ? { selector } : {}) }]).length, 1)
  }
  for (const value of [null, {}, Array(9).fill(reference), [{ ...reference, kind: 'bot' }], [{ ...reference, revision: 0 }], [{ ...reference, tools: [] }], [{ ...reference, workflowId: 'x'.repeat(257) }], [{ ...reference, selector: { kind: 'node', index: 8, nodeKind: 'record' } }], [{ ...reference, selector: { kind: 'node', index: 0, nodeKind: 'invented' } }], [{ ...reference, selector: { kind: 'gate', canvasId: 'g' } }]]) assert.throws(() => parseInputReferences(value), TypeError)
})

test('real runtime resolves exact revisions and historical run definition, rejecting stale/forged/cross-project', async () => withTempWorkspace(async directory => {
  const runtime = new WorkflowRuntime(directory, 'p', { canUse: () => true, deliver: async () => { throw Error('unused') } })
  runtime.start(true); runtime.bindExternal(() => true)
  try {
    runtime.define(definition)
    runtime.admit([{ workflow: 'flow', source: definition.source, observations: [{ id: 'observation', data: { secret: 'DO_NOT_COPY' } }] }])
    const runId = runtime.inspect().runs[0].id
    const resolve = workflowReferenceResolver('p', runtime)
    const snapshot = resolve([reference])
    assert(!snapshot.includes('DO_NOT_COPY'))
    assert(snapshot.includes('\\u003c/workflow-reference-context\\u003e'))
    assert(snapshot.includes('v:workflows/definitions/flow.json'))
    for (const selector of [{ kind: 'source' }, { kind: 'gate' }, { kind: 'node', index: 0, nodeKind: 'record' }]) assert(resolve([{ ...reference, selector }]))
    for (const ref of [{ ...reference, projectId: 'other' }, { ...reference, workflowId: 'forged' }, { ...reference, revision: 2 }, { ...reference, runId: 'fake' }, { ...reference, selector: { kind: 'node', index: 0, nodeKind: 'inbox' } }, { ...reference, selector: { kind: 'node', index: 1, nodeKind: 'record' } }]) assert.throws(() => resolve([ref]), TypeError)
    runtime.bindSourceAuthorizer((_owner, value) => value)
    const { owner: _owner, revision: _revision, ...authorInput } = definition
    runtime.author('owner', { ...authorInput, nodes: [{ kind: 'transform', code: 'SECRET_CODE' }] }, 1)
    runtime.define({ ...definition, id: 'no-gate', gate: undefined })
    assert.throws(() => resolve([reference]), /stale/)
    assert.throws(() => resolve([{ ...reference, workflowId: 'no-gate', selector: { kind: 'gate' } }]), /gate/)
    assert(resolve([{ ...reference, runId }]).includes('"nodeKind"') === false)
    assert(resolve([{ ...reference, runId }]).includes('"kind":"record"'))
    assert.throws(() => resolve([{ ...reference, revision: 2, runId }]), /stale/)
    assert.throws(() => resolve([{ ...reference, workflowId: 'other', runId }]), /run_unavailable/)
    assert(snapshot.includes('\"kind\":\"record\"'))
    assert(!snapshot.includes('SECRET_CODE'))
  } finally { await runtime.stop() }
}))

test('web admission freezes references in ordinary user text before queue; retry rejects replacement; sync validates too', async () => {
  const bus = new Bus()
  let label = 'FIRST', calls = 0
  const received: Array<{ content: string; metadata?: Record<string, unknown> }> = []
  const channel = new WebChannel(bus, { authorize: () => true, resolveInputReferences: () => { calls++; return '\nSNAPSHOT:' + label } })
  channel.setReceiver(async message => {
    received.push(message)
    bus.emit('message.outbound', { event: 'response', channel: 'web', chatId: message.chatId, replyTo: message.messageId, done: true, content: 'ok' })
    return { status: 'accepted', sessionId: `web:${message.chatId}`, inputId: message.messageId }
  })
  const app = new Hono(); await channel.start(app)
  const post = (body: object, path = '/api/chat/send') => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await post({ chatId: 'c', content: 'hello' })).status, 200)
    assert.equal(received[0].content, 'hello'); assert.equal(calls, 0)
    assert.equal((await post({ chatId: 'c', content: 'queued', delivery: 'queue', references: [reference] })).status, 200)
    label = 'CHANGED'
    assert.equal(received[1].content, 'queued\nSNAPSHOT:FIRST'); assert.equal(calls, 1)
    assert.equal((await post({ chatId: 'c', retry: true, references: [reference] })).status, 400)
    assert.equal(calls, 1)
    assert.equal((await post({ chatId: 'c', retry: true })).status, 200)
    assert.equal(received[2].content, ''); assert.equal(calls, 1)
    for (const path of ['/api/chat/send', '/api/chat/message']) assert.equal((await post({ chatId: 'c', content: 'x', references: [{ kind: 'bot' }] }, path)).status, 400)
    assert.equal(received.length, 3)
    assert.equal((await post({ chatId: 'c', references: [reference] }, '/api/chat/message')).status, 200)
    assert.equal(received[3].content, '\nSNAPSHOT:CHANGED')
    assert.equal(calls, 2)
  } finally { await channel.stop() }
})
