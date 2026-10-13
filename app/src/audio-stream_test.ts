import assert from 'node:assert/strict'
import test from 'node:test'
import { openAudioStream } from './audio-stream.ts'
const tick = () => new Promise(resolve => setImmediate(resolve))

test('stream waits ready before PCM, contiguous bounded chunks, snapshot preview and corrected final', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  const calls: { url: string; method: string; size: number }[] = []
  let events: ReadableStreamDefaultController<Uint8Array>
  const event = (type: string, text: string | undefined, revision: number) => events.enqueue(new TextEncoder().encode(`event: transcript\ndata: ${JSON.stringify({ type, text, revision })}\n\n`))
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', size: (init?.body as Uint8Array)?.byteLength ?? 0 })
    if (String(url).endsWith('/streams')) return Response.json({ id: 'fixture-id', mode: 'buffered-window', format: 's16le', sampleRate: 16000, channels: 1, windowSeconds: 3 })
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { events = controller } }), { headers: { 'Content-Type': 'text/event-stream' } })
    if (String(url).endsWith('/finish')) { event('final', 'corrected final.', 3); return Response.json({ accepted: true }) }
    if (init?.method === 'PUT') return Response.json({ sequence: Number(new URL(String(url)).searchParams.get('sequence')) + 1, receivedBytes: calls.filter(call => call.method === 'PUT').reduce((n, call) => n + call.size, 0) })
    return Response.json({ ok: true })
  }
  const preview: string[] = []
  let opened = false
  const opening = openAudioStream('http://localhost/projects/p/', 'web:fixture', new AbortController().signal, text => preview.push(text)).then(value => { opened = true; return value })
  await tick(); assert.equal(opened, false)
  event('ready', undefined, 0)
  const stream = await opening; assert.ok(stream)
  stream.push(new Float32Array(64000).fill(.01), 16000)
  event('partial', 'provisional', 2); event('partial', 'stale', 1); await tick()
  assert.deepEqual(preview, ['provisional'])
  assert.equal(await stream.finish(), 'corrected final.')
  const uploads = calls.filter(call => call.method === 'PUT')
  assert.ok(uploads.length >= 2); assert.ok(uploads.every(call => call.size <= 65536 && call.size % 2 === 0))
  assert.deepEqual(uploads.map(call => new URL(call.url).searchParams.get('sequence')), uploads.map((_, i) => String(i)))
  assert.equal(calls[1]!.method, 'GET'); assert.match(calls[1]!.url, /events$/)
})

test('legacy fallback only absent stream support, not authorization/model failures', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  for (const status of [404, 501]) {
    globalThis.fetch = async () => new Response('{}', { status })
    assert.equal(await openAudioStream('http://localhost/', 'web:s', new AbortController().signal, () => {}), undefined)
  }
  for (const status of [401, 409, 503]) {
    globalThis.fetch = async () => new Response('{}', { status })
    await assert.rejects(openAudioStream('http://localhost/', 'web:s', new AbortController().signal, () => {}), /Unable to start/)
  }
})

test('cancel disconnects subscription and sends DELETE; never finalizes provisional text', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  let deleted = 0
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'DELETE') { deleted++; return Response.json({ ok: true }) }
    if (String(url).endsWith('/streams')) return Response.json({ id: 'fixture', mode: 'buffered-window', format: 's16le', sampleRate: 16000, channels: 1, windowSeconds: 3 })
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: transcript\ndata: {"type":"ready","revision":0}\n\n')) } }))
    return Response.json({ ok: true })
  }
  const abort = new AbortController()
  const stream = await openAudioStream('http://localhost/', 'web:s', abort.signal, () => {})
  abort.abort(); await tick(); assert.equal(deleted, 1)
  await assert.rejects(stream!.finish(), /cancelled/)
})
