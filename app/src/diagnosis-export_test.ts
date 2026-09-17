import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchDiagnosisExport } from './diagnosis-export.ts'

const snapshot = {
  schemaVersion: 1, kind: 'shadow-session-diagnosis',
  session: { sessionId: 'web:case', physicalId: 'web_case-0' },
  history: { records: [], hasMore: false },
  trace: { hasMore: false },
  privacy: { truncatedPaths: [], reviewRequiredBeforeSharing: true },
}
test('agent export requests the selected project/segment and reports partial evidence', async () => {
  const controller = new AbortController()
  const result = await fetchDiagnosisExport('http://localhost/projects/one', 'web:case', 'web_case-0', controller.signal, async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, '/projects/one/api/sessions/web%3Acase/diagnosis')
    assert.equal(url.searchParams.get('physicalId'), 'web_case-0')
    assert.equal(url.searchParams.get('view'), 'full')
    assert.equal(init?.signal, controller.signal)
    return Response.json({ ...snapshot, trace: { hasMore: true } })
  })
  assert.equal(result.partial, true)
  assert.equal(result.filename, 'diagnosis-web_case-0.json')
  assert.equal(JSON.parse(result.json).schemaVersion, 1)
})

test('agent export rejects stale, invalid and unauthorized responses rather than downloading them', async () => {
  for (const response of [
    new Response('unauthorized', { status: 401 }),
    new Response('<html>SPA fallback</html>', { headers: { 'Content-Type': 'text/html' } }),
    Response.json({ ...snapshot, session: { sessionId: 'foreign', physicalId: 'foreign-0' } }),
    Response.json({ ...snapshot, session: { sessionId: 'web:case', physicalId: 'web_case-1' } }),
    Response.json({}),
  ]) {
    await assert.rejects(fetchDiagnosisExport('http://localhost', 'web:case', 'web_case-0', new AbortController().signal, async () => response))
  }
  const controller = new AbortController()
  await assert.rejects(fetchDiagnosisExport('http://localhost', 'web:case', null, controller.signal, async () => {
    controller.abort()
    return Response.json(snapshot)
  }), { name: 'AbortError' })
})
