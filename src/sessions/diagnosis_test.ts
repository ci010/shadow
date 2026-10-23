import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { withTempWorkspace } from '../testing/workspace.ts'
import { OtelStore } from '../otel/store.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { createSessionDiagnosis, diagnosisProjection, parseDiagnosisQuery, type DiagnosisSource } from './diagnosis.ts'
import { sessionDiagnosisPlugin } from './diagnosis-routes.ts'
import { FolderError } from '../folders/registry.ts'

const query = (text = '') => parseDiagnosisQuery(new URLSearchParams(text))
const caseRecords: Record<string, unknown>[] = [
  { previous_physical_id: null },
  { role: 'user', content: 'Install these MCP servers', timestamp: '2026-09-17T00:00:00Z' },
  { role: 'assistant', provider_state: { secret: 'opaque' }, reasoning_text: 'private reasoning', tool_calls: [
    { id: 'catalog-call', function: { name: 'read', arguments: '{"path":"v:tools"}' } },
    { id: 'config-call', function: { name: 'exec', arguments: '{"script":"inspect config","env":{"CUSTOM":"secret-env"}}' } },
  ] },
  { role: 'tool', tool_call_id: 'config-call', content: '{"authorization":"Bearer credential-value","error":"access denied"}' },
  { role: 'tool', tool_call_id: 'catalog-call', content: 'catalog tools' },
  { role: 'assistant', tool_calls: [{ id: 'import-call', function: { name: 'exec', arguments: '{"shell":"node","script":"await import_tool({source:\\"servers.json\\"})"}' } }] },
  { role: 'tool', tool_call_id: 'import-call', content: 'Error: missing MCP configuration' },
  { role: 'tool', tool_call_id: 'orphan', content: 'An unmatched result must remain visible' },
]

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`diagnosis preserves raw ${storage} evidence, pairing and pagination without conversation repair`, async () => {
    await withTempWorkspace(async root => {
      const store = storage === 'jsonl' ? new JsonlSessionStore(root) : new SqliteSessionStore(root)
      const otel = new OtelStore(join(root, 'otel.db'))
      try {
        await store.saveState('web:case', { sessionId: 'web:case', segmentIndex: 1, projectId: 'one', parentSessionId: 'parent' })
        await store.createSessionLog('web_case-1', caseRecords)
        otel.ingestTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{
          traceId: 'trace', spanId: 'tool-span', name: 'agent.tool', startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000',
          status: { code: 2 },
          attributes: [
            { key: 'sessionId', value: { stringValue: 'web:case' } },
            { key: 'physicalSessionId', value: { stringValue: 'web_case-1' } },
            { key: 'tool.call_id', value: { stringValue: 'import-call' } },
          ],
        }] }] }] })
        const source: DiagnosisSource = {
          projectId: 'one', getState: id => store.getState(id), readRecords: id => store.readSessionLog(id),
          querySpans: input => otel.querySessionSpans(input),
        }
        const full = await createSessionDiagnosis(source, 'web:case', query('view=full'))
        assert.equal(full.session.physicalId, 'web_case-1')
        assert.equal(full.session.parentSessionId, 'parent')
        assert.equal(full.session.previousPhysicalId, 'web_case-0')
        assert.equal(full.history.records.length, caseRecords.length)
        assert.equal(full.history.records.at(-1)?.callId, 'orphan')
        assert.deepEqual(full.overview.toolCounts, { read: 1, exec: 2 })
        assert.deepEqual(full.toolCalls[0].resultRecordIds, ['web_case-1:record:4'])
        assert.deepEqual(full.toolCalls[1].resultRecordIds, ['web_case-1:record:3'])
        assert.deepEqual(full.toolCalls[2].spanIds, ['trace:tool-span'])
        assert.deepEqual(full.overview.failedSpanIds, ['trace:tool-span'])
        assert.equal(full.historicalContext.status, 'unavailable')
        assert.equal(full.history.hasMore, false)
        const json = JSON.stringify(full)
        for (const secret of ['opaque', 'private reasoning', 'secret-env', 'credential-value']) assert.ok(!json.includes(secret), secret)
        assert.ok(json.includes('import_tool'))
        const page = await createSessionDiagnosis(source, 'web:case', query('recordLimit=3'))
        assert.equal(page.history.nextOffset, 3)
        assert.equal(page.toolCalls[0].resultStatus, 'not-in-page')
        const next = await createSessionDiagnosis(source, 'web:case', query('recordOffset=3&recordLimit=5'))
        assert.equal(next.history.hasMore, false)
        assert.equal(next.history.records[0].turn, 1)
        assert.deepEqual([...page.history.records, ...next.history.records].map(record => record.id), full.history.records.map(record => record.id))
        await assert.rejects(createSessionDiagnosis(source, 'web:case', query('physicalId=foreign-0')), /does not belong/)
        await assert.rejects(createSessionDiagnosis({ ...source, projectId: 'two' }, 'web:case', query()), /not found/)
        const controller = new AbortController()
        controller.abort()
        await assert.rejects(createSessionDiagnosis(source, 'web:case', query(), controller.signal), { name: 'AbortError' })
      } finally {
        otel.close()
        if (store instanceof SqliteSessionStore) store.close()
      }
    })
  })
}

test('diagnosis projections redact nested and encoded secrets with explicit truncation', () => {
  const p = diagnosisProjection(120, 1000)
  const result = JSON.stringify(p.project({
    args: JSON.stringify({ env: { UNUSUAL_NAME: 'environment-value' }, api_key: 'key-value', headers: { custom: 'header-value' } }),
    text: 'Authorization: Bearer abcdef123; password="password-value"; https://user:pass@localhost/',
    provider_state: 'provider-value',
    clientSecret: 'camel-case-secret',
    usage: { promptTokens: 32 },
    image: { type: 'image_url', image_url: { url: 'data:image/png;base64,private-image' } },
    long: 'x'.repeat(121),
    large: Array.from({ length: 101 }, () => 'ok'),
  }))
  for (const secret of ['environment-value', 'key-value', 'header-value', 'abcdef123', 'password-value', 'user:pass', 'provider-value', 'camel-case-secret', 'private-image']) assert.ok(!result.includes(secret), secret)
  assert.ok(result.includes('"promptTokens":32'))
  assert.ok(p.redactedPaths.length >= 4)
  assert.ok(p.truncatedPaths.includes('$.long'))
  assert.ok(p.truncatedPaths.includes('$.large'))
  const bounded = diagnosisProjection(100, 10)
  assert.match(JSON.stringify(bounded.project({ first: 'a'.repeat(20), second: 'b'.repeat(20) })), /TRUNCATED/)
})

test('diagnosis rejects invalid and duplicate request parameters', () => {
  for (const input of ['view=raw', 'recordOffset=-1', 'recordLimit=501', 'recordLimit=1.1', 'recordLimit=0', 'textLimit=16001',
    'view=full&view=summary', 'physicalId=', 'spanBeforeId=0', 'recordOffset=1e3', 'unknown=1']) {
    assert.throws(() => query(input), Error, input)
  }
})

test('diagnosis does not invent pairings, turn boundaries, prompts or successful execution', async () => {
  const source: DiagnosisSource = {
    getState: sessionId => ({ sessionId, segmentIndex: 0 }),
    async *readRecords() {
      yield { role: 'user', content: [{ type: 'text', text: '<event name="scheduled" />' }] }
      yield { role: 'user', content: 'Install an MCP' }
      const call = { id: 'duplicate', function: { name: 'exec', arguments: '{}' } }
      yield { role: 'assistant', tool_calls: [call] }
      yield { role: 'assistant', tool_calls: [call] }
      yield { role: 'tool', tool_call_id: 'duplicate', content: { ok: true, stdout: 'Error: mcp_error' } }
    },
    captures: () => [],
  }
  const result = await createSessionDiagnosis(source, 'case', query())
  assert.equal(result.history.records[0].turn, 0)
  assert.equal(result.history.records[1].turn, 1)
  assert.ok(result.toolCalls.every(call => call.resultStatus === 'ambiguous-call-id'))
  assert.ok(result.toolCalls.every(call => call.resultRecordIds.length === 0))
  assert.equal(result.historicalContext.status, 'capture-enabled')
  assert.deepEqual(result.historicalContext.captures, [])
  assert.ok(JSON.stringify(result.history.records.at(-1)).includes('mcp_error'))
})

test('diagnosis routes enforce authorization and session/folder scope before reading records', async () => {
  let reads = 0
  const source: DiagnosisSource = {
    projectId: 'one',
    getState: id => id === 'owned' ? { sessionId: id, segmentIndex: 0, projectId: 'one' } : null,
    async *readRecords() { reads++; yield { role: 'user', content: 'evidence' } },
  }
  const app = new Hono()
  sessionDiagnosisPlugin(source, {
    authorize: request => request.headers.get('Authorization') === 'Bearer test-only',
    assertAccess: id => assert.equal(id, 'owned'),
  })(app)
  const auth = { headers: { Authorization: 'Bearer test-only' } }
  assert.equal((await app.request('/api/sessions/owned/diagnosis')).status, 401)
  assert.equal((await app.request('/api/sessions/foreign/diagnosis', auth)).status, 404)
  assert.equal((await app.request('/api/sessions/owned/diagnosis?physicalId=foreign-0', auth)).status, 404)
  assert.equal((await app.request('/api/sessions/owned/diagnosis?recordLimit=0', auth)).status, 400)
  assert.equal(reads, 0)
  const response = await app.request('/api/sessions/owned/diagnosis', auth)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const body = await response.json()
  assert.equal(body.schemaVersion, 1)
  assert.equal(body.trace.available, false)
  assert.equal(reads, 1)
  const denied = new Hono()
  sessionDiagnosisPlugin(source, {
    authorize: () => true,
    assertAccess: () => { throw new FolderError('folder_unavailable', 'Folder revoked', 409) },
  })(denied)
  assert.equal((await denied.request('/api/sessions/owned/diagnosis')).status, 409)
  assert.equal(reads, 1)
})

test('offline SQLite readers do not migrate or permit writes', async () => {
  await withTempWorkspace(async root => {
    const writer = new SqliteSessionStore(root)
    await writer.saveState('case', { sessionId: 'case', segmentIndex: 0 })
    await writer.createSessionLog('case-0', [{ role: 'user', content: 'retained' }])
    writer.close()
    const otelPath = join(root, 'otel.db')
    new OtelStore(otelPath).close()
    const reader = new SqliteSessionStore(root, { readOnly: true })
    const otel = new OtelStore(otelPath, { readOnly: true })
    try {
      assert.equal((await reader.getState('case'))?.sessionId, 'case')
      assert.equal(otel.querySessionSpans({ sessionId: 'case' }).entries.length, 0)
      await assert.rejects(reader.saveState('case', { sessionId: 'case', segmentIndex: 1 }), /readonly/i)
      assert.throws(() => otel.ingestTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: 'trace', spanId: 'span', name: 'agent.tool', startTimeUnixNano: '1000000',
      }] }] }] }), /readonly/i)
    } finally {
      reader.close()
      otel.close()
    }
  })
})
