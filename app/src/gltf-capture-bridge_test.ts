import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GLTF_CAPTURE_HEADER } from '../../src/gltf-capture-contract.ts'
import { gltfCaptureChatHeaders, registerGltfCaptureViewer, type GltfCaptureCallback } from './gltf-capture-bridge.ts'

const apiBase = 'https://shadow.invalid/relay/projects/p'
const scope = { projectId: 'p', sessionId: 'web:main', assetId: 'model', version: 'v1' }
const image = { mimeType: 'image/png' as const, data: 'image-bytes', camera: {
  position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number],
}, objectIds: ['cube'] }

const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await tick()
  assert(check(), 'Expected browser bridge operation did not arrive')
}

test('tab-scoped chat headers and Viewer hot update abort a stale capture without posting its image', async t => {
  const requests: { operation: string; body: unknown }[] = []
  const polls: ((response: Response) => void)[] = []
  let serial = 0
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
    const input = String(request)
    assert(input.startsWith(`${apiBase}/api/gltf-capture/`))
    const operation = input.split('/').at(-1)!
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    requests.push({ operation, body })
    if (operation === 'register') return Response.json({ binding: `binding-${++serial}` })
    const headers = new Headers(init?.headers)
    assert(headers.get(GLTF_CAPTURE_HEADER)?.startsWith('binding-'))
    if (operation === 'poll') return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      polls.push(resolve)
    })
    return new Response(null, { status: 204 })
  })
  let firstSignal: AbortSignal | undefined
  let resolveFirst: (value: typeof image) => void = () => { throw new Error('First callback not invoked') }
  const capture: GltfCaptureCallback = (view, signal, requestedScope) => {
    if (view.mode === 'current') {
      assert.equal(requestedScope.version, 'v1')
      firstSignal = signal
      return new Promise(resolve => { resolveFirst = resolve })
    }
    assert.deepEqual(view, { mode: 'top' })
    assert.equal(requestedScope.version, 'v2')
    return Promise.resolve(image)
  }
  const stop = await registerGltfCaptureViewer({ ...scope, apiBase }, capture)
  t.after(stop)
  assert.deepEqual(requests[0], { operation: 'register', body: scope })
  assert.deepEqual(gltfCaptureChatHeaders(`${apiBase}/`, 'p', 'web:main'), { [GLTF_CAPTURE_HEADER]: 'binding-1' })
  assert.deepEqual(gltfCaptureChatHeaders(apiBase, 'another', 'web:main'), {})
  assert.deepEqual(gltfCaptureChatHeaders(apiBase, 'p', 'web:other'), {})
  assert.deepEqual(gltfCaptureChatHeaders('https://other.invalid/', 'p', 'web:main'), {})
  polls.shift()!(Response.json({ id: 'foreign-job', scope: { ...scope, assetId: 'foreign' }, view: { mode: 'current' }, budgetMs: 2000 }))
  await until(() => polls.length === 1)
  assert.equal(firstSignal, undefined)
  polls.shift()!(Response.json({ id: 'old-job', scope, view: { mode: 'current' }, budgetMs: 2000 }))
  await until(() => firstSignal !== undefined)
  const updated = stop.updateVersion('v2')
  assert(firstSignal!.aborted)
  resolveFirst(image)
  await updated
  assert(requests.some(r => r.operation === 'version' && JSON.stringify(r.body) === JSON.stringify({ previousVersion: 'v1', version: 'v2' })))
  assert(!requests.some(r => r.operation === 'result'))
  await until(() => polls.length === 1)
  polls.shift()!(Response.json({ id: 'new-job', scope: { ...scope, version: 'v2' }, view: { mode: 'top' }, budgetMs: 2000 }))
  await until(() => requests.some(r => r.operation === 'result'))
  assert.deepEqual(requests.find(r => r.operation === 'result')?.body, { id: 'new-job', result: image })
  const duplicate = await registerGltfCaptureViewer({ ...scope, apiBase }, capture)
  t.after(duplicate)
  assert.deepEqual(gltfCaptureChatHeaders(apiBase, 'p', 'web:main'), {})
  duplicate()
  assert.deepEqual(gltfCaptureChatHeaders(apiBase, 'p', 'web:main'), { [GLTF_CAPTURE_HEADER]: 'binding-1' })
  stop()
  assert.deepEqual(gltfCaptureChatHeaders(apiBase, 'p', 'web:main'), {})
  assert.equal(requests.filter(r => r.operation === 'unregister').length, 2)
})
