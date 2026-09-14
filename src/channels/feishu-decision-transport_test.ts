import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FeishuWorkerTransport } from './feishu-transport.ts'

// A small independent protobuf fixture exercises the real SDK frame decoder and ACK encoder.
const networkFixture = `
  import { parentPort } from 'node:worker_threads'
  const varint = n => { const bytes = []; do { bytes.push((n & 127) | (n > 127 ? 128 : 0)); n >>>= 7 } while(n); return bytes }
  const bytes = (tag, content) => { const data = Buffer.from(content); return [tag, ...varint(data.length), ...data] }
  const header = (key, value) => bytes(42, [...bytes(10, key), ...bytes(18, value)])
  const frame = (kind, id, event) => Uint8Array.from([
    8, 1, 16, 2, 24, 3, 32, 1, ...header('type', kind), ...header('message_id', id),
    ...bytes(66, JSON.stringify({ schema: '2.0', header: { event_type: 'card.action.trigger' }, event })),
  ]).buffer
  const decode = data => {
    let offset = 0; let payload
    const read = () => { let result = 0, shift = 0, byte; do { byte = data[offset++]; result |= (byte & 127) << shift; shift += 7 } while(byte & 128); return result }
    while (offset < data.length) {
      const tag = read()
      if ((tag & 7) === 0) read()
      else {
        const size = read(); const content = data.slice(offset, offset + size); offset += size
        if (tag === 66) payload = JSON.parse(Buffer.from(content).toString())
      }
    }
    return payload
  }
  globalThis.fetch = async () => Response.json({ code: 0, data: { URL: 'wss://synthetic.invalid', ClientConfig: { PingInterval: 100 } } })
  let socket
  globalThis.WebSocket = class extends EventTarget {
    static OPEN = 1
    readyState = 1
    constructor() { super(); socket = this; setTimeout(() => this.dispatchEvent(new Event('open')), 0) }
    send(data) { const ack = decode(data); if (ack) parentPort.postMessage({ ack }) }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  parentPort.on('message', message => {
    if (message.deliver) socket.dispatchEvent(new MessageEvent('message', { data: frame(message.kind ?? 'card', message.id, message.deliver) }))
  })
`

for (const outcome of ['success', 'error', 'pending'] as const) {
  test(`Feishu worker returns structured ${outcome} card ACKs with a short deadline and terminates cleanly`, { timeout: 10_000 }, async t => {
    const base = join(process.cwd(), '.test-data')
    mkdirSync(base, { recursive: true })
    const root = mkdtempSync(join(base, 'feishu-card-worker-'))
    const preloader = join(root, 'network-fixture.mjs')
    writeFileSync(preloader, networkFixture)
    let worker!: Worker
    let calls = 0
    const ready = Promise.withResolvers<void>()
    const acknowledgements: Array<{ code: number; data?: string }> = []
    let notify = Promise.withResolvers<void>()
    const transport = new FeishuWorkerTransport(
      { appId: 'fixture-app', appSecret: 'fixture-secret', encryptKey: '', verificationToken: '' },
      () => assert.fail('Card callbacks must not enter the message/model ingress'),
      state => { if (state === 'running') ready.resolve() },
      (url, options) => {
        worker = new Worker(url, { ...options, execArgv: [...options.execArgv!, '--import', pathToFileURL(preloader).href] })
        worker.on('message', message => {
          if (message.ack) { acknowledgements.push(message.ack); notify.resolve() }
        })
        worker.on('error', ready.reject)
        return worker
      },
      async event => {
        assert.deepEqual(event, { action: { value: { option: 2 } } })
        calls++
        if (outcome === 'pending') return new Promise(() => {})
        if (outcome === 'error') throw new Error('fixture-secret-must-not-cross-worker-boundary')
        return { toast: { type: 'success', content: 'Decision accepted.' } }
      },
    )
    t.after(async () => { await transport.stop(); rmSync(root, { recursive: true, force: true }) })
    transport.start()
    await ready.promise
    const start = performance.now()
    worker.postMessage({ id: 'fixture-event', deliver: { action: { value: { option: 2 } } } })
    await notify.promise
    assert.ok(performance.now() - start < 2_800)
    assert.equal(acknowledgements[0].code, 200)
    const response = JSON.parse(Buffer.from(acknowledgements[0].data!, 'base64').toString())
    assert.equal(response.toast.type, outcome === 'pending' ? 'info' : outcome)
    assert.doesNotMatch(JSON.stringify(response), /fixture-secret/)
    notify = Promise.withResolvers<void>()
    worker.postMessage({ id: 'fixture-event', kind: 'event', deliver: { action: { value: { option: 2 } } } })
    await notify.promise
    assert.equal(calls, 1)
    assert.deepEqual(acknowledgements[1], acknowledgements[0])
    await transport.stop()
    assert.equal(worker.threadId, -1)
  })
}
