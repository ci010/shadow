import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IoEventQueue } from './io/channel.ts'
import { IO_MAX_CHUNK_BYTES, IO_MAX_BUFFER_BYTES } from '../../src/io/contracts.ts'
import { encodeBytes } from './io/transport.ts'

const credentials = { clientId: 'client', clientToken: 'token', leaseToken: 'lease' }
const base = 'http://localhost:3000/projects/default/'
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

test('relay queue serializes ACKs; responses do not execute or deliver view effects', async () => {
  const events: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const queue = new IoEventQueue(base, 'run', credentials, async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(Object.keys(body).sort(), ['clientId', 'clientToken', 'event', 'leaseToken'])
    events.push(body.event.id)
    if (events.length === 1) await gate
    return Response.json({ accepted: true, effects: [{ method: 'ui.render', args: [] }] })
  })
  const first = queue.send({ type: 'ui', id: 'first', value: true })
  const second = queue.send({ type: 'ui', id: 'second', value: true })
  await turn(); assert.deepEqual(events, ['first']); assert.ok(queue.queuedBytes > 0)
  release(); await Promise.all([first, second])
  assert.deepEqual(events, ['first', 'second']); assert.equal(queue.queuedBytes, 0)
})

test('relay queue bounds raw payload and total encoded reservations and drops pending work on close', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let sent = 0
  const queue = new IoEventQueue(base, 'run', credentials, async () => { sent++; await gate; return Response.json({ accepted: true }) })
  await assert.rejects(queue.send({ type: 'data', sourceId: 'file', mime: 'application/octet-stream', base64: encodeBytes(new Uint8Array(IO_MAX_CHUNK_BYTES + 1)) }), /1 MiB/)
  const input = { type: 'data' as const, sourceId: 'file', mime: 'application/octet-stream', base64: encodeBytes(new Uint8Array(IO_MAX_CHUNK_BYTES)) }
  const pending = Array.from({ length: 2 }, () => queue.send(input))
  assert.ok(queue.queuedBytes <= IO_MAX_BUFFER_BYTES / 2)
  await assert.rejects(queue.send(input), /queue is full/)
  queue.close(); release()
  await Promise.allSettled(pending)
  assert.ok(sent <= 1); assert.equal(queue.queuedBytes, 0)
})

test('failed or missing ACK fails remaining queue; no silent retry', async () => {
  let sent = 0
  const queue = new IoEventQueue(base, 'run', credentials, async () => { sent++; return Response.json({}) })
  await assert.rejects(queue.send({ type: 'ui', value: 'first' }), /acknowledge/)
  await assert.rejects(queue.send({ type: 'ui', value: 'second' }), /acknowledge/)
  assert.equal(sent, 1)
})

test('native browser fetch receives the global Window receiver, not the queue instance', async () => {
  const queue = new IoEventQueue(base, 'run', credentials, async function (this: unknown) {
    assert.equal(this, globalThis)
    return Response.json({ accepted: true })
  })
  await queue.send({ type: 'start' })
})
