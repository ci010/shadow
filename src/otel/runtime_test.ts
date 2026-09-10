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
