import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FeishuWorkerTransport } from './feishu-transport.ts'

const compiled = process.env.SHADOW_TEST_COMPILED_CHANNELS === '1'
const Transport: typeof FeishuWorkerTransport = compiled
  ? (await import(pathToFileURL(join(process.cwd(), 'dist', 'src', 'channels', 'feishu-transport.js')).href)).FeishuWorkerTransport
  : FeishuWorkerTransport

for (const pending of [false, true]) {
  test(`${compiled ? 'Compiled' : 'Source'} Feishu worker uses the existing SDK and terminates ${pending ? 'pending endpoint requests' : 'connected sockets and timers'}`, { timeout: 15_000 }, async (t) => {
    const base = join(process.cwd(), '.test-data')
    mkdirSync(base, { recursive: true })
    const root = mkdtempSync(join(base, 'feishu-worker-'))
    const preloader = join(root, 'network-fixture.mjs')
    writeFileSync(preloader, `
      import { parentPort } from 'node:worker_threads'
      globalThis.fetch = async () => {
        parentPort.postMessage({ observed: 'fetch-started' })
        ${pending ? 'await new Promise(resolve => setTimeout(resolve, 3_600_000))' : ''}
        return Response.json({ code: 0, data: { URL: 'wss://synthetic.invalid', ClientConfig: { PingInterval: 1 } } })
      }
      globalThis.WebSocket = class extends EventTarget {
        static OPEN = 1
        readyState = 1
        constructor() {
          super()
          setTimeout(() => { this.dispatchEvent(new Event('open')); parentPort.postMessage({ observed: 'socket-opened' }) }, 0)
        }
        send() {}
        close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
      }
    `)
    const observed = Promise.withResolvers<void>()
    const states: string[] = []
    let worker: Worker | undefined
    const transport = new Transport({
      appId: 'synthetic-app', appSecret: 'synthetic-secret', encryptKey: '', verificationToken: '',
    }, () => {}, (state) => states.push(state), (url, options) => {
      if (compiled) {
        assert.ok(url.pathname.endsWith('/dist/src/channels/feishu-worker.js'))
        assert.equal(options.execArgv, undefined)
      }
      worker = new Worker(url, {
        ...options,
        execArgv: [...(options.execArgv ?? []), '--import', pathToFileURL(preloader).href],
      })
      worker.on('message', (message) => {
        if (message.observed === (pending ? 'fetch-started' : 'socket-opened')) observed.resolve()
      })
      worker.on('error', observed.reject)
      return worker
    })
    t.after(async () => {
      await transport.stop()
      rmSync(root, { recursive: true, force: true })
    })
    transport.start()
    await observed.promise
    if (!pending) assert.deepEqual(states, ['running'])
    assert.ok(!states.includes('connected'))
    await transport.stop()
    assert.equal(worker?.threadId, -1)
    assert.ok(!states.includes('error'))
  })
}
