import test from 'node:test'
import assert from 'node:assert/strict'
import { RealtimeHub } from '../../realtime/hub.ts'
import { WorkOrganizer } from '../../projects/work-organizer.ts'
import { InitiativeStore } from '../../initiatives/store.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { organizerRecord, organizerSource, organizerPatch } from '../../testing/work-organization.ts'
import { SessionTools, Tools } from '../../tools/registry.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { createSessionGraphLoader } from '../../../app/src/session-graph-snapshot.ts'

// Real organizer SQLite commits -> real SSE publisher -> graph reader. The
// HTTP inventory is synthetic; this is not a live latency/CPU measurement.
test('organizer presentation commits scope graph probes while preserving Work notifications and full recovery', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home)
  const hub = new RealtimeHub()
  const publisher = hub.registerProject('fixture')
  const reader = hub.connect([{ kind: 'sessions', projectId: 'fixture' }], new AbortController().signal).body!.getReader()
  const next = async () => {
    const chunk = await reader.read()
    assert.equal(chunk.done, false)
    return JSON.parse(new TextDecoder().decode(chunk.value).match(/^data: (.+)$/m)![1])
  }
  const graph = {
    sessions: Array.from({ length: 719 }, (_, i) => ({ sessionId: i ? `web:chat-${i}` : 'organizer:run',
      title: `Synthetic session ${i}`, parentSessionId: null, focus: 'Synthetic goal '.repeat(30),
      description: 'Synthetic presentation '.repeat(20), executionStatus: 'completed' })),
    nodes: Array.from({ length: 719 }, (_, i) => ({ physicalId: `physical-${i}`,
      logicalId: i ? `web:chat-${i}` : 'organizer:run', parentPhysicalId: i === 1 ? 'physical-0' : null })),
  }
  let fullCount = 0, partialCount = 0, bytes = 0
  const fullBytes = Buffer.byteLength(JSON.stringify(graph))
  const loader = createSessionGraphLoader('http://main/projects/fixture', 'fixture', async input => {
    const query = new URL(String(input)).searchParams.get('sessionIds')
    const ids: string[] | undefined = query ? JSON.parse(query) : undefined
    const value = ids ? { partial: true, sessionIds: ids,
      sessions: graph.sessions.filter(row => ids.includes(row.sessionId)),
      nodes: graph.nodes.filter(row => ids.includes(row.logicalId)) } : graph
    if (ids) partialCount++; else fullCount++
    bytes += Buffer.byteLength(JSON.stringify(value))
    return Response.json(value)
  })
  const signal = new AbortController().signal
  const consume = async (id = 'organizer:run') => {
    const event = await next()
    assert.equal(event.type, 'event')
    assert.deepEqual(event.payload, { event: 'invalidate', sessionId: id, changes: ['work'] }, 'Work overview consumers still receive each commit')
    loader.invalidate(event.payload)
    const rows = await loader.load(signal)
    assert.equal(rows.length, 719)
    assert.equal(rows.find(row => row.sessionId === 'web:chat-1')?.contextParentSessionId, 'organizer:run')
  }
  try {
    await next(); await next() // reset + ready
    // The initial inventory precedes this fresh run. Its begin must recover
    // full inventory, even if creation races ahead of the HTTP response.
    const runRow = graph.sessions.shift()!, runNode = graph.nodes.shift()!
    await loader.load(signal)
    const initialBytes = bytes
    graph.sessions.unshift(runRow); graph.nodes.unshift(runNode)
    for (let i = 1; i <= 3; i++) store.saveWork(organizerRecord(i), 0, 'fixture', 'created')
    const organizer = new WorkOrganizer(store, { projectId: 'fixture',
      evidence: async id => ({ sources: [organizerSource(Number(id.split('-').at(-1)))], partial: false }), activity: () => '',
      changed: id => publisher.invalidateSessions(id, undefined, ['work']) })
    const context: ExecutionContext = { sessionId: 'organizer:run', physicalSessionId: 'physical-0', projectId: 'fixture',
      channel: 'organizer', chatId: 'run', senderId: 'system', messageId: 'input', signal,
      tools: new SessionTools(new Tools(home), home) }
    organizer.begin(context.sessionId, 'full', signal); await consume()
    for (let i = 1; i <= 3; i++) {
      await organizer.read({ key: organizerRecord(i).key }, context)
      await organizer.patch(organizerPatch(i, i - 1), context); await consume()
    }
    await organizer.finish({}, context); await consume()
    organizer.end() // finished end must not emit a duplicate
    assert.equal(store.projectFocus()?.result.groups.length, 3)
    assert.equal(fullCount, 2)
    assert.equal(partialCount, 4)
    const oldBytes = initialBytes + 5 * fullBytes // initial, begin, three patches, finish
    assert.ok(bytes < oldBytes * 0.34)
    console.info(JSON.stringify({ scenario: '719-session organizer presentation replay', fullCount, partialCount, bytes,
      oldFullCount: 6, oldBytes, savedPercent: Number(((1 - bytes / oldBytes) * 100).toFixed(2)) }))
    // Unknown runs (creation), broad inventory notifications and reset still
    // recover authoritative topology rather than suppressing global events.
    organizer.begin('organizer:new', 'delta', signal); await consume('organizer:new')
    organizer.end(); await consume('organizer:new')
    publisher.invalidateSessions()
    loader.invalidate((await next()).payload); await loader.load(signal)
    loader.reset(); await loader.load(signal)
    assert.equal(fullCount, 6)
  } finally { await reader.cancel(); hub.close(); store.close() }
}))
