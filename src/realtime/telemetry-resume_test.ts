import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeHub } from './hub.ts'

for (const kind of ['logs', 'spans'] as const) {
  test(`${kind} resnapshot after an unobserved interval even with an otherwise valid cursor`, async t => {
    const rows: { id: number }[] = []
    const hub = new RealtimeHub({ telemetryMs: 60_000 })
    t.after(() => hub.close())
    hub.registerProject('default', {
      latest: () => rows.at(-1)?.id ?? 0,
      query: (_kind, afterId, limit) => rows.filter(row => row.id > afterId).slice(0, limit),
    })
    const topics = [{ kind, projectId: 'default' }]
    const first = hub.connect(topics, new AbortController().signal).body!.getReader()
    await first.read()
    await first.read()
    const cursor = hub.cursor
    await first.cancel()
    assert.equal(hub.stats.clients, 0)
    rows.push({ id: 1 })
    assert.equal(hub.cursor, cursor, 'unsubscribed telemetry writes are not in the transport journal')

    const resumed = hub.connect(topics, new AbortController().signal, cursor).body!.getReader()
    const frame = new TextDecoder().decode((await resumed.read()).value)
    const envelope = JSON.parse(frame.match(/^data: (.+)$/m)![1])
    assert.equal(envelope.type, 'reset', 'ready alone would silently lose the unobserved row')
    assert.equal(envelope.reason, 'expired')
    await resumed.cancel()
  })
}
