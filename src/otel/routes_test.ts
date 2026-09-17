import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerGatewayRoutes } from '../gateway/server.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { otelPlugin } from './routes.ts'
import { OtelStore, type OtlpSpan } from './store.ts'
import type { SessionTraceResponse } from './session-trace.ts'

const start = '1789040000123456789'
const end = '1789040000456789012'
const startMs = 1789040000123.456789
const endMs = 1789040000456.789012

function attributes(sessionId: string, physicalSessionId?: string) {
  return [
    { key: 'sessionId', value: { stringValue: sessionId } },
    ...(physicalSessionId === undefined ? [] : [
      { key: 'physicalSessionId', value: { stringValue: physicalSessionId } },
    ]),
  ]
}

function span(spanId: string, options: Partial<OtlpSpan> = {}): OtlpSpan {
  return {
    traceId: 'shared-trace', spanId, name: 'agent.tool',
    startTimeUnixNano: start, endTimeUnixNano: end, ...options,
  }
}

function ingest(store: OtelStore, ...spans: OtlpSpan[]): void {
  store.ingestTraces({ resourceSpans: [{ scopeSpans: [{ spans }] }] })
}

function appFor(store: OtelStore): Hono {
  const app = new Hono()
  otelPlugin(store)(app)
  return app
}

async function query(app: Hono, params = 'sessionId=parent'): Promise<SessionTraceResponse> {
  const response = await app.request(`/v1/query/session-spans?${params}`)
  assert.equal(response.status, 200)
  return await response.json() as SessionTraceResponse
}

test('retired telemetry streams return finite errors without starting store polling', async (t) => {
  const store = new OtelStore(':memory:')
  t.after(() => store.close())
  for (const method of ['getLatestSpanId', 'getLatestLogId', 'querySpans', 'queryLogs'] as const) {
    t.mock.method(store, method, () => assert.fail('Retired streams must not query the store'))
  }
  const app = appFor(store)
  for (const kind of ['spans', 'logs']) {
    const response = await app.request(`/v1/stream/${kind}`)
    assert.equal(response.status, 410)
    assert.deepEqual(await response.json(), {
      error: 'stream_retired', message: `Subscribe to ${kind} topics through /api/live.`,
    })
  }
})

test('session trace route follows ownership, not shared traces or span IDs', async () => {
  const store = new OtelStore(':memory:')
  try {
    ingest(store,
      span('parent', { attributes: attributes('parent', 'parent-1') }),
      span('loop', { parentSpanId: 'parent' }),
      span('tool', { parentSpanId: 'loop' }),
      span('child', { parentSpanId: 'tool', attributes: attributes('child', 'child-1') }),
      span('child-loop', { parentSpanId: 'child' }),
      span('child-tool', { parentSpanId: 'child-loop' }),
      span('foreign', { attributes: attributes('foreign', 'foreign-1') }),
      span('foreign-tool', { parentSpanId: 'foreign' }),
      span('orphan', { parentSpanId: 'missing' }),
      span('unowned'),
      span('loop', { traceId: 'other-trace', attributes: attributes('foreign') }),
      span('cross-trace', { traceId: 'other-trace', parentSpanId: 'parent' }),
    )
    const app = appFor(store)
    const parent = await query(app)
    assert.deepEqual(parent.entries.map((entry) => entry.spanId), ['tool', 'loop', 'parent'])
    assert.equal(parent.sessionId, 'parent')
    assert.equal(parent.hasMore, false)
    assert.equal(parent.nextBeforeId, 1)
    assert(!('physicalSessionId' in parent))
    assert.deepEqual((await query(app, 'sessionId=child')).entries.map((entry) => entry.spanId),
      ['child-tool', 'child-loop', 'child'])
    assert.deepEqual(await query(app, 'sessionId=unknown'),
      { sessionId: 'unknown', entries: [], hasMore: false })

    const global = await app.request('/v1/query/spans?traceId=shared-trace&limit=100')
    const body = await global.json() as { total: number; entries: Array<Record<string, unknown>> }
    assert.equal(body.total, 12)
    assert.equal(body.entries.length, 10)
    assert.equal(body.entries[0].span_id, 'unowned')
    assert(!('live' in body.entries[0]))
  } finally {
    store.close()
  }
})

test('physical filters are exact, inherit known segments, and stop conflicting boundaries', async () => {
  const store = new OtelStore(':memory:')
  try {
    ingest(store,
      span('first', { attributes: attributes('parent', 'parent-1') }),
      span('first-tool', { parentSpanId: 'first' }),
      span('second', { parentSpanId: 'first', attributes: attributes('parent', 'parent-2') }),
      span('second-tool', { parentSpanId: 'second' }),
      span('unknown-segment', { attributes: attributes('parent') }),
      span('unknown-tool', { parentSpanId: 'unknown-segment' }),
      span('child', { parentSpanId: 'first', attributes: attributes('child') }),
      span('child-tool', { parentSpanId: 'child' }),
      span('conflicting', {
        parentSpanId: 'first',
        attributes: [{ key: 'physicalSessionId', value: { stringValue: 'parent-2' } }],
      }),
      span('conflicting-tool', { parentSpanId: 'conflicting' }),
    )
    const app = appFor(store)
    const first = await query(app, 'sessionId=parent&physicalSessionId=parent-1')
    assert.equal(first.physicalSessionId, 'parent-1')
    assert.deepEqual(first.entries.map((entry) => entry.spanId), ['first-tool', 'first'])
    assert.deepEqual((await query(app, 'sessionId=parent&physicalSessionId=parent-2'))
      .entries.map((entry) => entry.spanId), ['second-tool', 'second'])
    assert.equal((await query(app)).entries.length, 6)
    assert.equal((await query(app, 'sessionId=child&physicalSessionId=parent-1')).entries.length, 0)
    assert.equal((await query(app, 'sessionId=parent&physicalSessionId=parent')).entries.length, 0)
  } finally {
    store.close()
  }
})

test('late ancestors associate existing children without crossing a later child session root', async () => {
  const store = new OtelStore(':memory:')
  try {
    const app = appFor(store)
    ingest(store, span('tool', { parentSpanId: 'loop' }),
      span('child-tool', { parentSpanId: 'child' }))
    assert.equal((await query(app)).entries.length, 0)
    ingest(store, span('loop', { parentSpanId: 'parent' }))
    assert.equal((await query(app)).entries.length, 0)
    ingest(store,
      span('child', { parentSpanId: 'loop', attributes: attributes('child', 'child-1') }),
      span('parent', { attributes: attributes('parent', 'parent-1') }))
    assert.deepEqual((await query(app)).entries.map((entry) => entry.spanId), ['parent', 'loop', 'tool'])
    assert.deepEqual((await query(app, 'sessionId=child')).entries.map((entry) => entry.spanId),
      ['child', 'child-tool'])
  } finally {
    store.close()
  }
})

test('session spans normalize real millisecond times, status, attributes and events', async () => {
  const store = new OtelStore(':memory:')
  try {
    ingest(store, span('timed', {
      attributes: [
        ...attributes('parent'),
        { key: 'iteration', value: { intValue: '2' } },
        { key: 'cached', value: { boolValue: false } },
        { key: 'rate', value: { doubleValue: 0.5 } },
        { key: 'array', value: { arrayValue: { values: [{ stringValue: 'one' }, { intValue: '2' }] } } },
      ],
      status: { code: 2, message: 'fixture failure' },
      events: [
        { name: 'checkpoint', timeUnixNano: start, attributes: [{ key: 'phase', value: { stringValue: 'work' } }] },
        { name: 'missing-time' },
        { name: 'invalid-time', timeUnixNano: 'invalid' },
      ],
    }))
    assert.deepEqual((await query(appFor(store))).entries, [{
      id: 1, traceId: 'shared-trace', spanId: 'timed', name: 'agent.tool',
      startTime: startMs, endTime: endMs, live: false,
      statusCode: 2, statusMessage: 'fixture failure',
      attributes: { sessionId: 'parent', iteration: '2', cached: 'false', rate: '0.5', array: '["one","2"]' },
      events: [{ name: 'checkpoint', time: startMs, attributes: { phase: 'work' } }],
    }])
    ingest(store,
      span('missing-end', { attributes: attributes('parent'), endTimeUnixNano: undefined }),
      span('missing-start', { attributes: attributes('parent'), startTimeUnixNano: undefined }),
      span('invalid-start', { attributes: attributes('parent'), startTimeUnixNano: 'invalid' }),
    )
    const result = await query(appFor(store))
    assert.deepEqual(result.entries.map((entry) => entry.spanId), ['missing-end', 'timed'])
    assert(!('endTime' in result.entries[0]))
    assert.equal(result.entries[0].startTime, startMs)
  } finally {
    store.close()
  }
})

test('persisted pagination has stable IDs without duplicates, skipped rows or live cursor pollution', async () => {
  const store = new OtelStore(':memory:')
  try {
    for (let i = 0; i < 9; i++) {
      ingest(store, span(`span-${i}`, { attributes: attributes('parent', 'parent-1') }))
      ingest(store, span(`foreign-${i}`, { attributes: attributes('foreign') }))
    }
    // OTLP exporter retries still appear globally, but retain their first
    // session-page identity and cursor rather than reappearing on another page.
    ingest(store, span('span-4', { attributes: attributes('parent', 'parent-1') }))
    store.registerLiveSpan('shared-trace', 'running', () =>
      span('running', { attributes: attributes('parent', 'parent-1'), endTimeUnixNano: undefined }))
    const app = appFor(store)
    const ids: number[] = []
    const names: string[] = []
    let beforeId: number | undefined
    do {
      const page = await query(app,
        `sessionId=parent&physicalSessionId=parent-1&limit=2${beforeId ? `&beforeId=${beforeId}` : ''}`)
      const completed = page.entries.filter((entry) => !entry.live)
      assert(completed.length <= 2)
      assert.equal(page.entries.filter((entry) => entry.live).length, beforeId ? 0 : 1)
      for (const entry of completed) {
        assert(entry.id !== null && entry.id > 0)
        ids.push(entry.id)
        names.push(entry.spanId)
      }
      assert.equal(page.nextBeforeId, completed.at(-1)?.id)
      if (!page.hasMore) break
      assert(page.nextBeforeId !== undefined)
      assert(beforeId === undefined || page.nextBeforeId < beforeId)
      beforeId = page.nextBeforeId
      // A newly completed span after the initial page does not shift old pages.
      if (ids.length === 2) ingest(store, span('fresh', { attributes: attributes('parent') }))
    } while (ids.length < 20)
    assert.deepEqual(ids, [17, 15, 13, 11, 9, 7, 5, 3, 1])
    assert.equal(new Set(names).size, 9)
    assert.equal((await query(app)).entries[0].spanId, 'fresh')
    assert.deepEqual(await query(app, 'sessionId=parent&beforeId=1'),
      { sessionId: 'parent', entries: [], hasMore: false })
  } finally {
    store.close()
  }
})

test('session trace limit defaults to 200 and accepts a maximum of 500', async () => {
  const store = new OtelStore(':memory:')
  try {
    ingest(store, ...Array.from({ length: 501 }, (_, i) =>
      span(`span-${i}`, { attributes: attributes('parent') })))
    const app = appFor(store)
    const first = await query(app)
    assert.equal(first.entries.length, 200)
    assert.equal(first.hasMore, true)
    assert.equal(first.nextBeforeId, 302)
    const maximum = await query(app, 'sessionId=parent&limit=500')
    assert.equal(maximum.entries.length, 500)
    assert.equal(maximum.hasMore, true)
    assert.equal(maximum.nextBeforeId, 2)
  } finally {
    store.close()
  }
})

test('session trace route rejects malformed query values with 400', async () => {
  const store = new OtelStore(':memory:')
  try {
    const app = appFor(store)
    const invalid = [
      '', 'sessionId=', 'sessionId=%20%20', 'sessionId=parent&sessionId=foreign',
      'sessionId=parent&physicalSessionId=', 'sessionId=parent&physicalSessionId=%20',
      'sessionId=parent&physicalSessionId=a&physicalSessionId=b',
      ...['beforeId', 'limit'].flatMap((key) =>
        ['', '0', '-1', '1.5', 'NaN', 'Infinity', '1e2', '0x10', '+1', '%201', '9007199254740992']
          .map((value) => `sessionId=parent&${key}=${value}`)),
      'sessionId=parent&limit=501', 'sessionId=parent&limit=1&limit=2',
      'sessionId=parent&beforeId=1&beforeId=2',
    ]
    for (const params of invalid) {
      const response = await app.request(`/v1/query/session-spans?${params}`)
      assert.equal(response.status, 400, params)
      const body = await response.json() as { error: string }
      assert.equal(typeof body.error, 'string')
      assert(body.error.length > 0)
    }
    // Do not trim identifiers into a different session's ownership.
    assert.equal((await query(app, 'sessionId=%20parent%20')).entries.length, 0)
    assert.equal((await query(app, 'sessionId=parent&beforeId=9007199254740991')).hasMore, false)
  } finally {
    store.close()
  }
})

test('session trace storage errors are explicit 500 responses, not empty success', async (t) => {
  const store = new OtelStore(':memory:')
  const app = appFor(store)
  store.close()
  const errors = t.mock.method(console, 'error', () => {})
  const response = await app.request('/v1/query/session-spans?sessionId=parent')
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'Failed to query session spans' })
  assert.equal(errors.mock.callCount(), 1)
})

test('session trace route retains the shared gateway launch-credential protection', async () => {
  const store = new OtelStore(':memory:')
  try {
    const app = new Hono()
    registerGatewayRoutes(app, [otelPlugin(store)], {
      launchCredential: 'synthetic-trace-test-credential',
      allowedOrigins: [],
    })
    const url = '/v1/query/session-spans?sessionId=parent&physicalSessionId=parent-1'
    assert.equal((await app.request(url)).status, 401)
    assert.equal((await app.request(url, {
      headers: { Authorization: 'Bearer wrong-synthetic-credential' },
    })).status, 401)
    const authorized = await app.request(url, {
      headers: { Authorization: 'Bearer synthetic-trace-test-credential' },
    })
    assert.equal(authorized.status, 200)
    assert.deepEqual(await authorized.json(), {
      sessionId: 'parent', physicalSessionId: 'parent-1', entries: [], hasMore: false,
    })
  } finally {
    store.close()
  }
})

test('old SQLite telemetry is backfilled once without changing rows or inventing missing times', async () => {
  await withTempWorkspace(async (workspace) => {
    const path = join(workspace, 'legacy-otel.db')
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE otel_spans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL, parent_span_id TEXT, name TEXT NOT NULL,
        kind INTEGER, start_time INTEGER NOT NULL, end_time INTEGER,
        status_code INTEGER, status_message TEXT, attributes TEXT,
        events TEXT, resource TEXT, scope TEXT
      );
    `)
    const insert = old.prepare(`
      INSERT INTO otel_spans (trace_id, span_id, parent_span_id, name,
        start_time, end_time, attributes, events) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    old.exec('BEGIN')
    insert.run('legacy', 'tool', 'root', 'tool', 1234, null, null,
      JSON.stringify([{ name: 'no-time' }, { name: 'real', timeUnixNano: '1234567890' }]))
    insert.run('legacy', 'root', null, 'session.processMessage', 1200, 2000,
      JSON.stringify(attributes('parent', 'parent-1')), null)
    insert.run('legacy', 'unknown', null, 'unknown', 1300, null, '{invalid-json', '{invalid-json')
    insert.run('legacy', 'foreign', 'root', 'foreign', 1300, 1700,
      JSON.stringify(attributes('foreign')), null)
    insert.run('legacy', 'foreign-tool', 'foreign', 'foreign-tool', 1400, 1600, null, null)
    insert.run('legacy', 'unreadable-boundary', 'root', 'unreadable-boundary',
      1400, 1600, '{invalid-json', null)
    insert.run('legacy', 'unreadable-child', 'unreadable-boundary', 'unreadable-child',
      1400, 1600, null, null)
    for (let i = 0; i < 501; i++) {
      insert.run(`other-${i}`, 'root', null, 'other', 1, null,
        JSON.stringify(attributes('foreign')), null)
    }
    old.exec('COMMIT')
    const before = old.prepare('SELECT * FROM otel_spans ORDER BY id').all()
    old.close()

    for (let open = 0; open < 2; open++) {
      const store = new OtelStore(path)
      try {
        const result = await query(appFor(store), 'sessionId=parent&physicalSessionId=parent-1')
        assert.deepEqual(result.entries.map((entry) => entry.spanId), ['root', 'tool'])
        assert.equal(result.entries[1].startTime, 1234)
        assert(!('endTime' in result.entries[1]))
        assert(!('statusCode' in result.entries[1]))
        assert.deepEqual(result.entries[1].events,
          [{ name: 'real', time: 1234.56789, attributes: {} }])
        assert.deepEqual(store.querySpans({ ascending: true, limit: 1000 }), before)
      } finally {
        store.close()
      }
    }
  })
})

test('malformed cyclic ancestry terminates and unassociated spans remain omitted', async () => {
  const store = new OtelStore(':memory:')
  try {
    ingest(store,
      span('root', { parentSpanId: 'loop', attributes: attributes('parent') }),
      span('loop', { parentSpanId: 'root' }),
      span('unknown-a', { parentSpanId: 'unknown-b' }),
      span('unknown-b', { parentSpanId: 'unknown-a' }),
      span('', { attributes: attributes('parent') }),
      span('invalid-parent', { parentSpanId: '' }),
    )
    assert.deepEqual((await query(appFor(store))).entries.map((entry) => entry.spanId), ['loop', 'root'])
  } finally {
    store.close()
  }
})

test('invalid or ambiguous direct session annotations cannot inherit another session owner', async () => {
  const store = new OtelStore(':memory:')
  try {
    ingest(store, span('root', { attributes: attributes('parent', 'parent-1') }))
    const invalidAttributes = [
      [{ key: 'sessionId', value: { intValue: '1' } }],
      [{ key: 'sessionId', value: {} }],
      attributes(''),
      attributes(' '),
      [...attributes('parent'), ...attributes('foreign')],
    ]
    invalidAttributes.forEach((attrs, i) => {
      ingest(store,
        span(`invalid-${i}`, { parentSpanId: 'root', attributes: attrs }),
        span(`invalid-child-${i}`, { parentSpanId: `invalid-${i}` }))
    })
    const app = appFor(store)
    assert.deepEqual((await query(app)).entries.map((entry) => entry.spanId), ['root'])
    assert.equal((await query(app, 'sessionId=1')).entries.length, 0)
    assert.equal((await query(app, 'sessionId=foreign')).entries.length, 0)
  } finally {
    store.close()
  }
})

test('diagnosis reads cannot create entries or advance pagination, but execution descendants remain', async () => {
  const store = new OtelStore(':memory:')
  try {
    ingest(store,
      span('execution', {
        name: 'session.processMessage', attributes: attributes('parent', 'parent-1'),
      }),
      span('work', { parentSpanId: 'execution' }),
    )
    const app = appFor(store)
    const queries = [
      'sessionId=parent&limit=1',
      'sessionId=parent&physicalSessionId=parent-1&limit=1',
    ]
    const before = await Promise.all(queries.map((params) => query(app, params)))
    for (let i = 0; i < 5; i++) {
      ingest(store,
        span(`poll-${i}`, {
          name: 'session.getHistory',
          attributes: attributes('parent', i % 2 ? 'parent-1' : undefined),
        }),
        span(`poll-child-${i}`, { name: 'sqlite.read', parentSpanId: `poll-${i}` }),
        span(`admin-${i}`, { name: 'session.getState', attributes: attributes('parent', 'parent-1') }),
      )
      assert.deepEqual(await Promise.all(queries.map((params) => query(app, params))), before)
    }
    ingest(store,
      span('nested-read', {
        name: 'session.getHistory', parentSpanId: 'execution', attributes: attributes('parent'),
      }),
      span('nested-read-child', { name: 'sqlite.read', parentSpanId: 'nested-read' }),
      span('foreign-read', {
        name: 'session.getHistory', parentSpanId: 'execution', attributes: attributes('foreign'),
      }),
      span('foreign-read-child', { name: 'sqlite.read', parentSpanId: 'foreign-read' }),
    )
    const result = await query(app, 'sessionId=parent&physicalSessionId=parent-1')
    assert.deepEqual(result.entries.map((entry) => entry.spanId),
      ['nested-read-child', 'nested-read', 'work', 'execution'])
    assert.equal(result.nextBeforeId, 1)
    assert.equal(result.hasMore, false)
    assert.equal(store.countSpans(), 21)
  } finally {
    store.close()
  }
})

test('existing session trace indexes gain execution-name filtering without rewriting telemetry', async () => {
  await withTempWorkspace(async (workspace) => {
    const path = join(workspace, 'trace-index-upgrade.db')
    const initial = new OtelStore(path)
    ingest(initial,
      span('execution', { name: 'session.processMessage', attributes: attributes('parent', 'parent-1') }),
      span('read', { name: 'session.getHistory', attributes: attributes('parent', 'parent-1') }),
    )
    initial.close()
    const previous = new DatabaseSync(path)
    const raw = previous.prepare('SELECT * FROM otel_spans ORDER BY id').all()
    previous.exec(`
      DROP INDEX idx_session_spans_execution_owner;
      ALTER TABLE otel_session_span_index DROP COLUMN name;
      CREATE INDEX idx_session_spans_owner
        ON otel_session_span_index(session_id, physical_session_id);
    `)
    previous.close()
    for (let open = 0; open < 2; open++) {
      const upgraded = new OtelStore(path)
      try {
        const result = await query(appFor(upgraded), 'sessionId=parent&physicalSessionId=parent-1')
        assert.deepEqual(result.entries.map((entry) => entry.spanId), ['execution'])
        assert.deepEqual(upgraded.querySpans({ ascending: true }), raw)
      } finally {
        upgraded.close()
      }
    }
    const database = new DatabaseSync(path)
    try {
      assert.deepEqual(database.prepare('PRAGMA index_info(idx_session_spans_execution_owner)')
        .all().map((column) => column.name), ['session_id', 'name', 'physical_session_id'])
    } finally {
      database.close()
    }
  })
})
