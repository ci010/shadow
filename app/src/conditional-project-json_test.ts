import test from 'node:test'
import assert from 'node:assert/strict'
import { createConditionalProjectJson } from './projects.ts'

const signal = () => new AbortController().signal

test('conditional reader reuses validated JSON on 304 and replaces it on 200', async () => {
  const headers: Array<string | null> = []
  let calls = 0
  let parses = 0
  const reader = createConditionalProjectJson('http://fixture/projects/a', '/api/sessions/stages', value => {
    parses++
    return value
  }, async (_input, init) => {
    headers.push(new Headers(init?.headers).get('If-None-Match'))
    assert.equal(init?.cache, 'no-store')
    if (++calls === 2) return new Response(null, { status: 304 })
    return Response.json({ version: calls }, { headers: { ETag: `"${calls}"` } })
  })
  const first = await reader.load(signal())
  assert.equal(await reader.load(signal()), first)
  assert.deepEqual(await reader.load(signal()), { version: 3 })
  assert.deepEqual(headers, [null, '"1"', '"1"'])
  assert.equal(parses, 2, '304 never decodes or validates JSON again')
  reader.clear()
  await reader.load(signal())
  assert.equal(headers.at(-1), null)
})

test('old servers without ETag and separate Project readers cannot reuse a validator', async () => {
  const seen: Array<[string, string | null]> = []
  const request: typeof fetch = async (input, init) => {
    seen.push([String(input), new Headers(init?.headers).get('If-None-Match')])
    return Response.json({ ok: true })
  }
  const a = createConditionalProjectJson('http://fixture/projects/a', '/api/sessions/graph', x => x, request)
  const b = createConditionalProjectJson('http://fixture/projects/b', '/api/sessions/graph', x => x, request)
  await a.load(signal()); await a.load(signal()); await b.load(signal())
  assert.ok(seen.every(([, etag]) => etag === null))
  assert.match(seen[2][0], /projects\/b\//)
})

test('malformed, unauthorized and aborted reads never install a new validator', async () => {
  const seen: Array<string | null> = []
  let mode = 'invalid'
  const controller = new AbortController()
  const reader = createConditionalProjectJson('http://fixture', '/api/sessions/graph', value => {
    if (mode === 'invalid') throw new Error('invalid graph')
    if (mode === 'abort') controller.abort()
    return value
  }, async (_input, init) => {
    seen.push(new Headers(init?.headers).get('If-None-Match'))
    if (mode === 'unauthorized') return new Response(null, { status: 401 })
    if (mode === 'unexpected-304') return new Response(null, { status: 304 })
    return Response.json({}, { headers: { ETag: '"new"' } })
  })
  await assert.rejects(reader.load(signal()), /invalid graph/)
  mode = 'unauthorized'
  await assert.rejects(reader.load(signal()), /authorize/)
  mode = 'abort'
  await assert.rejects(reader.load(controller.signal), /abort/i)
  mode = 'unexpected-304'
  await assert.rejects(reader.load(signal()), /without a validated snapshot/)
  assert.deepEqual(seen, [null, null, null, null])
})

test('a delayed superseded read cannot replace the newer validator', async () => {
  let finish!: (response: Response) => void
  const seen: Array<string | null> = []
  let calls = 0
  const reader = createConditionalProjectJson('http://fixture', '/api/sessions/graph', x => x, async (_input, init) => {
    seen.push(new Headers(init?.headers).get('If-None-Match'))
    if (++calls === 1) return new Promise(resolve => { finish = resolve })
    return Response.json({ version: 2 }, { headers: { ETag: '"2"' } })
  })
  const older = reader.load(signal())
  await reader.load(signal())
  finish(Response.json({ version: 1 }, { headers: { ETag: '"1"' } }))
  await older
  await reader.load(signal())
  assert.deepEqual(seen, [null, null, '"2"'])
})
