import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { withTempWorkspace } from '../testing/workspace.ts'
import { activeSpan } from '../utils/otel.ts'
import { initializeNodeTelemetry } from './runtime.ts'
import { OtelStore } from './store.ts'

test('Node telemetry persists asynchronous spans and correlated console logs', async () => {
  const store = new OtelStore(':memory:')
  const original = console.info
  const telemetry = initializeNodeTelemetry(store)
  try {
    await activeSpan('node-runtime-test', async () => {
      await Promise.resolve()
      console.info('runtime %s', 'log')
    })
    const [span] = store.querySpans()
    const [log] = store.queryLogs()
    assert.ok(span && typeof span === 'object' && 'span_id' in span && 'trace_id' in span)
    assert.ok(log && typeof log === 'object' && 'span_id' in log && 'trace_id' in log && 'body' in log)
    assert.equal(log.span_id, span.span_id)
    assert.equal(log.trace_id, span.trace_id)
    assert.equal(log.body, JSON.stringify({ stringValue: 'runtime log' }))
  } finally {
    const stopping = telemetry.shutdown()
    assert.equal(telemetry.shutdown(), stopping)
    await stopping
    store.close()
  }
  assert.equal(console.info, original)
})

test('Node telemetry can restart after its last runtime shuts down', async () => {
  for (let iteration = 0; iteration < 2; iteration++) {
    const store = new OtelStore(':memory:')
    const telemetry = initializeNodeTelemetry(store)
    try {
      activeSpan(`restart-${iteration}`, () => {})
      assert.equal(store.querySpans().length, 1)
    } finally {
      await telemetry.shutdown()
      store.close()
    }
  }
})

interface StoredSpan {
  name: string
  trace_id: string
  span_id: string
  parent_span_id: string | null
  kind: number
  status_code: number
  start_time: number
  end_time: number
  attributes: string
  events: string
  resource: string
}

interface StoredLog {
  trace_id: string
  span_id: string
  severity: number
  severity_text: string
  body: string
}

test('Node telemetry preserves parent context, events, and failures in its database', async () => {
  await withTempWorkspace(async (workspace) => {
    const database = join(workspace, 'telemetry.db')
    const store = new OtelStore(database)
    const telemetry = initializeNodeTelemetry(store, {
      serviceName: 'telemetry-persistence-test',
    })
    const syncFailure = new Error('synchronous failure')
    const asyncFailure = new Error('asynchronous failure')
    try {
      await activeSpan('parent', async (parent) => {
        parent.setAttribute('session.id', 'session-1')
        await setImmediate()
        assert.equal(trace.getActiveSpan(), parent)

        assert.equal(activeSpan('child', (child) => {
          child.addEvent('checkpoint', { phase: 'work' })
          console.warn('child %s', 'warning')
          return 42
        }, { kind: SpanKind.CLIENT }), 42)
        assert.equal(trace.getActiveSpan(), parent)

        assert.throws(
          () => activeSpan('sync-failure', () => { throw syncFailure }),
          (error) => error === syncFailure,
        )
        await assert.rejects(
          activeSpan('async-failure', async () => {
            await setImmediate()
            throw asyncFailure
          }),
          (error) => error === asyncFailure,
        )
        assert.equal(trace.getActiveSpan(), parent)
      })
      assert.equal(trace.getActiveSpan(), undefined)
    } finally {
      await telemetry.shutdown()
      store.close()
    }

    const reopened = new OtelStore(database)
    try {
      const spans = reopened.querySpans() as StoredSpan[]
      assert.equal(spans.length, 4)
      const parent = spans.find((span) => span.name === 'parent')
      const child = spans.find((span) => span.name === 'child')
      assert(parent)
      assert(child)
      assert.match(parent.trace_id, /^[0-9a-f]{32}$/)
      assert.notEqual(parent.trace_id, '0'.repeat(32))
      assert.equal(parent.parent_span_id, null)
      assert.equal(parent.kind, SpanKind.INTERNAL + 1)
      assert.equal(child.kind, SpanKind.CLIENT + 1)
      assert.equal(new Set(spans.map((span) => span.span_id)).size, 4)
      assert.deepEqual(JSON.parse(parent.attributes), [{
        key: 'session.id',
        value: { stringValue: 'session-1' },
      }])
      const resource = JSON.parse(parent.resource) as {
        attributes: Array<{ key: string; value: { stringValue?: string } }>
      }
      assert(resource.attributes.some((attribute) =>
        attribute.key === 'service.name' &&
        attribute.value.stringValue === 'telemetry-persistence-test'
      ))

      for (const span of spans) {
        assert.match(span.span_id, /^[0-9a-f]{16}$/)
        assert(span.start_time > 0)
        assert(span.end_time >= span.start_time)
        if (span !== parent) {
          assert.equal(span.trace_id, parent.trace_id)
          assert.equal(span.parent_span_id, parent.span_id)
        }
      }
      const [checkpoint] = JSON.parse(child.events)
      assert.equal(checkpoint.name, 'checkpoint')
      assert.deepEqual(checkpoint.attributes, [{
        key: 'phase',
        value: { stringValue: 'work' },
      }])

      for (const [name, failure] of [
        ['sync-failure', syncFailure],
        ['async-failure', asyncFailure],
      ] as const) {
        const span = spans.find((entry) => entry.name === name)
        assert(span)
        assert.equal(span.status_code, SpanStatusCode.ERROR)
        const events = JSON.parse(span.events) as Array<{
          name: string
          attributes: Array<{ key: string; value: { stringValue: string } }>
        }>
        assert.equal(events.length, 1)
        assert.equal(events[0].name, 'exception')
        const attributes = new Map(events[0].attributes.map((entry) =>
          [entry.key, entry.value.stringValue]
        ))
        assert.equal(attributes.get('exception.type'), 'Error')
        assert.equal(attributes.get('exception.message'), failure.message)
        assert(attributes.get('exception.stacktrace')?.includes(failure.message))
      }

      const logs = reopened.queryLogs() as StoredLog[]
      assert.equal(logs.length, 1)
      assert.equal(logs[0].trace_id, child.trace_id)
      assert.equal(logs[0].span_id, child.span_id)
      assert.equal(logs[0].severity, 13)
      assert.equal(logs[0].severity_text, 'WARN')
      assert.deepEqual(JSON.parse(logs[0].body), { stringValue: 'child warning' })
    } finally {
      reopened.close()
    }
  })
})

test('Node telemetry shares handles without duplicates and restores globals after final shutdown', async () => {
  const firstStore = new OtelStore(':memory:')
  const secondStore = new OtelStore(':memory:')
  const levels = ['debug', 'log', 'info', 'warn', 'error'] as const
  const originalConsole = levels.map((level) => console[level])
  const first = initializeNodeTelemetry(firstStore)
  const duplicate = initializeNodeTelemetry(firstStore)
  const second = initializeNodeTelemetry(secondStore)
  try {
    activeSpan('both-stores', () => console.info('shared telemetry'))
    assert.equal(firstStore.querySpans().length, 1)
    assert.equal(secondStore.querySpans().length, 1)
    assert.equal(firstStore.queryLogs().length, 1)
    assert.equal(secondStore.queryLogs().length, 1)

    await first.shutdown()
    activeSpan('duplicate-retains-store', () => {})
    assert.equal(firstStore.querySpans().length, 2)
    assert.equal(secondStore.querySpans().length, 2)

    await duplicate.shutdown()
    activeSpan('remaining-store', () => console.warn('remaining telemetry'))
    assert.equal(firstStore.querySpans().length, 2)
    assert.equal(firstStore.queryLogs().length, 1)
    assert.equal(secondStore.querySpans().length, 3)
    assert.equal(secondStore.queryLogs().length, 2)

    const stopping = second.shutdown()
    assert.equal(second.shutdown(), stopping)
    await stopping
    levels.forEach((level, index) =>
      assert.equal(console[level], originalConsole[index])
    )
    assert.equal(trace.getActiveSpan(), undefined)
    const disabledSpan = trace.getTracer('after-shutdown').startSpan('disabled')
    assert.equal(disabledSpan.isRecording(), false)
    disabledSpan.end()
    console.info('after telemetry shutdown')
    assert.equal(secondStore.querySpans().length, 3)
    assert.equal(secondStore.queryLogs().length, 2)
  } finally {
    await first.shutdown()
    await duplicate.shutdown()
    await second.shutdown()
    firstStore.close()
    secondStore.close()
  }
})

test('running snapshots track late attributes, events, child boundaries and completed identities', async () => {
  const store = new OtelStore(':memory:')
  const telemetry = initializeNodeTelemetry(store)
  try {
    await activeSpan('session.processMessage', async (parent) => {
      assert.equal(store.querySessionSpans({ sessionId: 'parent' }).entries.length, 0)
      parent.setAttributes({ sessionId: 'parent', physicalSessionId: 'parent-1' })
      parent.addEvent('checkpoint', { phase: 'running' }, [1789040000, 123456789])
      parent.setStatus({ code: SpanStatusCode.ERROR, message: 'fixture failure' })
      await setImmediate()
      const snapshot = store.querySessionSpans({ sessionId: 'parent' })
      assert.equal(snapshot.entries.length, 1)
      const running = snapshot.entries[0]
      assert.equal(running.id, null)
      assert.equal(running.live, true)
      assert.equal(running.startTime, 1789040000000)
      assert.equal(running.statusCode, SpanStatusCode.ERROR)
      assert.equal(running.statusMessage, 'fixture failure')
      assert(!('endTime' in running))
      assert(!('nextBeforeId' in snapshot))
      assert.deepEqual(running.events, [{
        name: 'checkpoint', time: 1789040000123.456789, attributes: { phase: 'running' },
      }])
      assert.equal(store.querySpans().length, 0)

      activeSpan('legacy-child', () => {})
      const during = store.querySessionSpans({ sessionId: 'parent', physicalSessionId: 'parent-1', limit: 1 })
      assert.deepEqual(during.entries.map((entry) => entry.name), ['legacy-child', 'session.processMessage'])
      assert.equal(during.entries[0].parentSpanId, running.spanId)
      assert.equal(during.entries[0].live, false)
      assert.equal(during.entries[1].spanId, running.spanId)
      assert.equal(during.nextBeforeId, 1)
      assert.equal(store.querySessionSpans({ sessionId: 'parent', beforeId: 2 }).entries.length, 1)
      assert.equal(store.querySessionSpans({ sessionId: 'parent', physicalSessionId: 'parent-2' }).entries.length, 0)

      await activeSpan('session.processMessage', async (child) => {
        child.setAttributes({ sessionId: 'child', physicalSessionId: 'child-1' })
        activeSpan('child-tool', () => {})
        assert.deepEqual(store.querySessionSpans({ sessionId: 'parent' }).entries
          .map((entry) => entry.name), ['legacy-child', 'session.processMessage'])
        assert.deepEqual(store.querySessionSpans({ sessionId: 'child' }).entries
          .map((entry) => entry.name), ['child-tool', 'session.processMessage'])
      })
      assert.deepEqual(store.querySessionSpans({ sessionId: 'parent' }).entries
        .map((entry) => entry.name), ['legacy-child', 'session.processMessage'])
    }, { startTime: [1789040000, 0] })
    const completed = store.querySessionSpans({ sessionId: 'parent' }).entries
    assert.deepEqual(completed.map((entry) => entry.name), ['session.processMessage', 'legacy-child'])
    assert(completed.every((entry) => entry.id !== null && entry.id > 0 && !entry.live))
    assert.equal(completed[0].startTime, 1789040000000)
    assert.equal(completed[0].spanId, completed[1].parentSpanId)
    assert.equal(new Set(completed.map((entry) => `${entry.traceId}:${entry.spanId}`)).size, 2)
    assert.equal(typeof completed[0].endTime, 'number')
  } finally {
    await telemetry.shutdown()
    store.close()
  }
})

test('live spans clean up per-store only after its last telemetry handle shuts down', async () => {
  const firstStore = new OtelStore(':memory:')
  const secondStore = new OtelStore(':memory:')
  const first = initializeNodeTelemetry(firstStore)
  const duplicate = initializeNodeTelemetry(firstStore)
  const second = initializeNodeTelemetry(secondStore)
  try {
    const running = trace.getTracer('test').startSpan('agent.chat', { attributes: { sessionId: 'parent' } })
    assert.equal(firstStore.querySessionSpans({ sessionId: 'parent' }).entries.length, 1)
    assert.equal(secondStore.querySessionSpans({ sessionId: 'parent' }).entries.length, 1)
    await first.shutdown()
    assert.equal(firstStore.querySessionSpans({ sessionId: 'parent' }).entries.length, 1)
    await duplicate.shutdown()
    assert.equal(firstStore.querySessionSpans({ sessionId: 'parent' }).entries.length, 0)
    assert.equal(secondStore.querySessionSpans({ sessionId: 'parent' }).entries.length, 1)
    await second.shutdown()
    assert.equal(secondStore.querySessionSpans({ sessionId: 'parent' }).entries.length, 0)
    running.end()
    assert.equal(firstStore.countSpans(), 0)
    assert.equal(secondStore.countSpans(), 0)
  } finally {
    await first.shutdown()
    await duplicate.shutdown()
    await second.shutdown()
    firstStore.close()
    secondStore.close()
  }
})

test('failed completed-span persistence still removes the live entry', async (t) => {
  const store = new OtelStore(':memory:')
  const telemetry = initializeNodeTelemetry(store)
  try {
    t.mock.method(store, 'ingestTraces', () => { throw new Error('fixture write failure') })
    const errorOutput = t.mock.method(process.stderr, 'write', () => true)
    const running = trace.getTracer('test').startSpan('agent.tool', { attributes: { sessionId: 'parent' } })
    assert.equal(store.querySessionSpans({ sessionId: 'parent' }).entries.length, 1)
    running.end()
    assert.equal(store.querySessionSpans({ sessionId: 'parent' }).entries.length, 0)
    assert.equal(errorOutput.mock.callCount(), 1)
  } finally {
    await telemetry.shutdown()
    store.close()
  }
})

test('ownership crosses mixed active/completed parent links without returning duplicate live identities', async () => {
  const store = new OtelStore(':memory:')
  const telemetry = initializeNodeTelemetry(store)
  try {
    await activeSpan('session.processMessage', async (parent) => {
      parent.setAttributes({ sessionId: 'parent', physicalSessionId: 'parent-1' })
      await activeSpan('unannotated-loop', async () => {
        activeSpan('unannotated-tool', () => {})
        const page = store.querySessionSpans({ sessionId: 'parent', physicalSessionId: 'parent-1' })
        assert.equal(page.entries.length, 3)
        assert.equal(page.entries.filter((entry) => entry.live).length, 2)
        const tool = page.entries.find((entry) => entry.name === 'unannotated-tool')
        assert(tool && !tool.live)
        store.registerLiveSpan(tool.traceId, tool.spanId, () => ({
          traceId: tool.traceId, spanId: tool.spanId,
          name: tool.name, startTimeUnixNano: '1789040000000000000',
          attributes: [{ key: 'sessionId', value: { stringValue: 'parent' } }],
        }))
        const refreshed = store.querySessionSpans({ sessionId: 'parent' })
        assert.equal(refreshed.entries.length, 3)
        assert.equal(refreshed.entries.filter((entry) => entry.spanId === tool.spanId).length, 1)
        const older = store.querySessionSpans({ sessionId: 'parent', beforeId: 2 })
        assert.deepEqual(older.entries.map((entry) => entry.name), ['unannotated-tool'])
      })
    })
    assert.equal(store.querySessionSpans({ sessionId: 'parent' }).entries.length, 3)
  } finally {
    await telemetry.shutdown()
    store.close()
  }
})

test('administrative live spans stay out of diagnosis unless nested in same-session execution', async () => {
  const store = new OtelStore(':memory:')
  const telemetry = initializeNodeTelemetry(store)
  const opts = { sessionId: 'parent', physicalSessionId: 'parent-1' }
  try {
    await activeSpan('session.getHistory', async (read) => {
      read.setAttributes(opts)
      await activeSpan('sqlite.read', async () => {
        assert.equal(store.querySessionSpans(opts).entries.length, 0)
        assert.equal(store.querySessionSpans({ sessionId: 'parent' }).entries.length, 0)
      })
    })
    assert.equal(store.querySessionSpans(opts).entries.length, 0)
    for (const name of ['agent.loop', 'agent.chat', 'agent.tool']) {
      const work = trace.getTracer('test').startSpan(name, { attributes: opts })
      const page = store.querySessionSpans(opts)
      assert.equal(page.entries.filter((entry) => entry.live && entry.name === name).length, 1)
      work.end()
      assert.equal(store.querySessionSpans(opts).entries.filter((entry) => entry.name === name).length, 1)
    }
    await activeSpan('session.processMessage', async (execution) => {
      execution.setAttributes(opts)
      await activeSpan('session.getHistory', async (read) => {
        read.setAttribute('sessionId', 'parent')
        const page = store.querySessionSpans(opts)
        assert.equal(page.entries.filter((entry) => entry.live).length, 2)
        assert(page.entries.some((entry) => entry.name === 'session.getHistory'))
      })
      const nested = store.querySessionSpans(opts).entries.filter((entry) => entry.name === 'session.getHistory')
      assert.equal(nested.length, 1)
      assert.equal(nested[0].live, false)
      assert.equal(nested[0].parentSpanId, execution.spanContext().spanId)
    })
    assert.equal(store.querySessionSpans(opts).entries.length, 5)
  } finally {
    await telemetry.shutdown()
    store.close()
  }
})
