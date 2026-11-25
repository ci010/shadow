import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { AggregatedProvider } from '../providers/aggregated.ts'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { projectUsageSchema } from '../projects/usage-contract.ts'
import { SkillRecallStore } from '../skills/recall.ts'
import { measureProviderAttempt, observeStreamText } from '../providers/request-meter.ts'
import { readProjectUsage } from './project-usage.ts'
import { readUsage } from './profile-usage.ts'
import { physicalSessionId } from './session-identity.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { StatsIndex } from './stats-index.ts'
import { usageProvider } from './usage.ts'

const asOf = Date.parse('2026-10-11T12:00:00Z')
for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`${Store.name}: rebuild and live writes share dedupe and do not read source at query time`, async () => {
  await withTempWorkspace(async root => {
    const source = new Store(join(root, 'sessions'))
    const file = join(root, 'stats.sqlite')
    let index = new StatsIndex(file)
    const state = { sessionId: 's', segmentIndex: 0, projectId: 'p' }
    const physical = physicalSessionId(state)
    const timestamp = '2026-10-10T12:00:00Z'
    const model = { type: 'model_usage', sessionId: 's', id: 'm', timestamp, model: 'fixture@account', durationMs: 200, firstTextMs: 40, queueMs: 30, outcome: 'success', textObservation: 'stream_text',
      attempts: [{ outcome: 'failure', durationMs: 60, mode: 'stream' }, { outcome: 'success', durationMs: 100, firstTextMs: 40, mode: 'stream' }],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedTokens: 0, cacheWriteTokens: 2, costs: [{ currency: 'USD', amount: 0.1 }] } }
    await source.init()
    try {
      await source.createSessionLog(physical, [{ sessionId: 's', previous_physical_id: null }, model, model,
        { role: 'assistant', tool_calls: [{ id: 't', function: { name: 'invoke_tool', arguments: JSON.stringify({ name: 'fixture.read', args: 'private' }) } }] },
        { role: 'tool', tool_call_id: 't', timestamp, content: 'private' }, { role: 'tool', tool_call_id: 't', timestamp }])
      const indexed = index.attach(source)
      assert.equal((await readProjectUsage(indexed, [state], 'p', asOf)).coverage, 'partial')
      await index.backfill(source, [state], 'p')
      await index.close()
      // Simulate an existing stats DB with completed segment checkpoints and no quality dimensions.
      const legacy = new DatabaseSync(file)
      legacy.exec(`DROP INDEX model_quality_scope; DROP INDEX model_quality_provider;
        ALTER TABLE model DROP COLUMN provider; ALTER TABLE model DROP COLUMN quality_model;`)
      legacy.close()
      index = new StatsIndex(file)
      const store = index.attach(source)
      await index.backfill(source, [state], 'p')
      await store.appendRawEvents(physical, [model, { ...model, id: 'new', timestamp: '2026-10-11T01:00:00Z', durationMs: 0, firstTextMs: undefined, queueMs: undefined, attempts: undefined, outcome: 'cancelled', textObservation: undefined, usage: null }])
      source.readSessionLog = async function* () { throw new Error('opened source log during query') }
      const usage = await readProjectUsage(store, [state], 'p', asOf)
      assert.equal(usage.coverage, 'complete')
      assert.deepEqual(usage.total, { calls: 2, tokens: 12, unknownTokenCalls: 1, costs: [{ currency: 'USD', amount: 0.1 }], unknownCostCalls: 1, durationMs: 200, unknownDurationCalls: 0 })
      assert.equal(usage.today.tokens, null)
      assert.deepEqual(usage.firstText, { p50Ms: 40, p95Ms: 40, samples: 1 })
      assert.deepEqual(usage.activity.total.tools, [{ name: 'fixture.read', calls: 1 }])
      assert.deepEqual(usage.activity.total.models, [{ name: 'fixture@account', calls: 2, usage: usage.total }])
      assert.deepEqual(usage.activity.today.models, [{ name: 'fixture@account', calls: 1, usage: usage.today }])
      const quality = usage.requestQuality!
      const periods = projectUsageSchema.parse(usage).requestQualityByPeriod!
      assert.deepEqual(periods.total.models.map(({ provider, model }) => [provider, model]), [['account', 'fixture']])
      assert.equal(periods.today.models[0]?.quality.outcomes[0]?.outcome, 'cancelled')
      assert.deepEqual(quality.duration, { samples: 2, p50Ms: 0, p95Ms: 200 })
      assert.deepEqual(quality.outputRate, { samples: 1, outputTokens: 2, activeDurationMs: 60, tokensPerSecond: 2 / 0.06 })
      assert.deepEqual(projectUsageSchema.parse(usage).requestQuality?.outputRate, quality.outputRate)
      assert.deepEqual(quality.queue, { samples: 1, p50Ms: 30, p95Ms: 30 })
      assert.deepEqual(quality.outcomes, [
        { outcome: 'cancelled', requests: 1, observedAttempts: null, requestsWithAttempts: 0 },
        { outcome: 'success', requests: 1, observedAttempts: 2, requestsWithAttempts: 1 },
      ])
      assert.deepEqual(quality.cache, { readTokens: 0, requestsWithReadTokens: 1, writeTokens: 2, requestsWithWriteTokens: 1,
        inputTokens: 10, requestsWithInputTokens: 1, outputTokens: 2, requestsWithOutputTokens: 1 })
      const profile = await readUsage(store, [state], -Infinity, asOf)
      assert.equal(profile.providerCalls, 2)
      assert.equal(profile.toolCalls, 1)
      assert.equal(profile.inputTokens, 10)
      assert.doesNotMatch(JSON.stringify([...index.records()]), /private/)
      await store.deleteSessionLog(physical)
      assert.equal((await readProjectUsage(store, [], 'p', asOf)).total.calls, 0)
    } finally { await index.close(); source.close?.() }
  })
})

test('estimated output speed weights eligible streams by post-first-text time only', async () => {
  const index = new StatsIndex(':memory:')
  const noSamples = { samples: 0, outputTokens: 0, activeDurationMs: 0, tokensPerSecond: null }
  const usage = (completionTokens: number) => ({ promptTokens: 10, completionTokens, totalTokens: 10 + completionTokens })
  const attempt = { outcome: 'success', firstTextMs: 200, durationMs: 1000 }
  const model = { type: 'model_usage', sessionId: 's', timestamp: new Date(asOf - 1).toISOString(),
    outcome: 'success', textObservation: 'stream_text', firstTextMs: 200, durationMs: 5000,
    usage: usage(80), attempts: [{ outcome: 'failure', durationMs: 900 }, attempt] }
  try {
    index.ingest('p', [
      { ...model, id: 'tool', textObservation: 'tool_only' },
      { ...model, id: 'nonstream', textObservation: 'nonstream' },
      { ...model, id: 'failed-request', outcome: 'failure' },
      { ...model, id: 'failed-attempt', attempts: [{ ...attempt, outcome: 'failure' }] },
      { ...model, id: 'no-attempt', attempts: undefined },
      { ...model, id: 'no-first-text', attempts: [{ ...attempt, firstTextMs: undefined }] },
      { ...model, id: 'zero-interval', attempts: [{ ...attempt, durationMs: 200 }] },
      { ...model, id: 'negative-interval', attempts: [{ ...attempt, durationMs: 100 }] },
      { ...model, id: 'unknown-usage', usage: null },
      { ...model, id: 'zero-output', usage: usage(0) },
      { ...model, id: 'future', timestamp: new Date(asOf).toISOString() },
    ])
    assert.deepEqual(index.requestSummary(asOf).outputRate, noSamples)
    index.ingest('p', [{ ...model, id: 'a' },
      { ...model, id: 'b', usage: usage(20), firstTextMs: 400, attempts: [{ ...attempt, firstTextMs: 400, durationMs: 1600 }] }])
    assert.deepEqual(index.requestSummary(asOf).outputRate, { samples: 2, outputTokens: 100, activeDurationMs: 2000, tokensPerSecond: 50 })
  } finally { await index.close() }
})

test('logical usage captures measured attempts and does not invent a streaming sample', async () => {
  const rows: Record<string, unknown>[] = []
  const store = { appendRawEvents: async (_id: string, events: Record<string, unknown>[]) => { rows.push(...events) } } as never
  const provider = usageProvider({ name: 'fixture', listModels: () => [], async chat(_messages, _tools, options) {
    await assert.rejects(() => measureProviderAttempt(async () => { throw new Error('retry') }))
    return measureProviderAttempt(async () => {
      observeStreamText(' ')
      if (options.model === 'stream') observeStreamText('answer')
      return { content: 'answer', toolCalls: [] }
    })
  } }, store, () => ({ sessionId: 's', physicalId: 'p' }))
  await provider.chat([], [], { model: 'stream' })
  await provider.chat([], [], { model: 'nonstream' })
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.provider, 'fixture')
  assert.equal(rows[0]!.textObservation, 'stream_text')
  assert.equal(rows[1]!.textObservation, 'unknown')
  assert.deepEqual((rows[0]!.attempts as Array<{ outcome: string }>).map(a => a.outcome), ['failure', 'success'])
  assert.equal(typeof rows[0]!.firstTextMs, 'number')
  assert.equal(rows[1]!.firstTextMs, undefined)
})

test('legacy Skill Recall baseline only migrates once', async () => {
  await withTempWorkspace(async root => {
    const legacy = join(root, 'skill-recall.sqlite'), target = join(root, 'stats.sqlite')
    const old = new SkillRecallStore(legacy)
    old.record('fixture'); old.record('fixture'); old.close()
    const first = new SkillRecallStore(target, legacy)
    first.record('fixture'); first.close()
    const second = new SkillRecallStore(target, legacy)
    try { assert.match(second.render(), /3\t"fixture"/) } finally { second.close() }
  })
})

test('metadata-only recall survives cursor replay and reconstruction, with source distinctions', async () => {
  await withTempWorkspace(async root => {
    const original = new StatsIndex(join(root, 'original.sqlite'))
    original.recall.record('topics/entry.md', 'active')
    original.recall.record('topics/entry.md', 'automatic')
    original.recall.record('test-skill', 'skill')
    await original.recall.replay(() => false)
    await original.recall.replay(() => false)
    assert.equal(original.db.prepare('SELECT sum(reads) AS n FROM memory_recall').get()?.n, 2)
    await original.close()
    const rebuilt = new StatsIndex(join(root, 'rebuilt.sqlite'))
    try {
      await rebuilt.recall.replay(() => false)
      assert.deepEqual(rebuilt.recall.memorySummary().map(row => [row.entry, row.source, row.reads]), [
        ['topics/entry.md', 'active', 1], ['topics/entry.md', 'automatic', 1],
      ])
      assert.deepEqual(rebuilt.recall.usageSummary(false), { coverage: 'partial', skills: [{ entry: 'test-skill', reads: 1 }],
        memory: [{ entry: 'topics/entry.md', source: 'active', reads: 1 }, { entry: 'topics/entry.md', source: 'automatic', reads: 1 }] })
      assert.equal(rebuilt.db.prepare('SELECT reads FROM skill_recall WHERE skill_path=?').get('test-skill')?.reads, 1)
    } finally { await rebuilt.close() }
  })
})


test('quality projections use UTC periods and pool samples separately by project, provider and model', async () => {
  const index = new StatsIndex(':memory:')
  const other = new StatsIndex(':memory:')
  const at = Date.parse('2026-10-03T11:00:00Z')
  const event = (id: string, timestamp: string | undefined, model: string | undefined, provider: string | undefined,
    firstTextMs = 100, active = 1000, output = 10) => ({
    type: 'model_usage', sessionId: 's', id, timestamp, model, provider, firstTextMs, durationMs: firstTextMs + active,
    outcome: 'success', textObservation: 'stream_text', attempts: [{ outcome: 'success', firstTextMs, durationMs: firstTextMs + active }],
    usage: { promptTokens: 5, completionTokens: output, totalTokens: 5 + output },
  })
  try {
    index.ingest('log', [
      event('all', '2026-09-26T23:59:59Z', 'm', undefined),
      event('week', '2026-09-27T00:00:00Z', 'm', 'a', 25),
      event('month', '2026-10-01T00:00:00Z', 'm@a', undefined, 900),
      event('today-a', '2026-10-03T00:00:00Z', 'm@a', 'a', 200, 200, 10),
      event('today-b', '2026-10-03T10:00:00Z', 'm', 'b', 500),
      event('today-alt', '2026-10-03T10:59:59Z', 'alt', 'a', 50, 1800, 30),
      event('future', new Date(at).toISOString(), 'm', 'future'),
      event('undated', undefined, undefined, 'undated'),
    ])
    other.ingest('log', [event('private', '2026-10-03T10:00:00Z', 'm', 'other-project')])
    const store = index.attach({} as never)
    const projection = (await readProjectUsage(store, [], 'project', at)).requestQualityByPeriod!
    assert.deepEqual(Object.values(projection).map(period => period.outcomes[0]?.requests), [6, 3, 5, 4])
    assert.deepEqual(projection.today.models.map(({ provider, model }) => [provider, model]), [['a', 'alt'], ['a', 'm'], ['b', 'm']])
    assert.equal(projection.total.models[0]?.quality.outcomes[0]?.requests, 3)
    assert.equal(projection.total.models.find(row => row.provider === null)?.model, 'm')
    assert.equal(projection.total.providers.some(row => row.provider === 'other-project'), false)
    const a = projection.today.providers.find(row => row.provider === 'a')?.quality
    assert.deepEqual(a?.firstText, { samples: 2, p50Ms: 50, p95Ms: 200 })
    assert.deepEqual(a?.outputRate, { samples: 2, outputTokens: 40, activeDurationMs: 2000, tokensPerSecond: 20 })
  } finally { await index.close(); await other.close() }
})

test('usage records the configured provider instance for bare and qualified model IDs', async () => {
  const rows: Record<string, unknown>[] = []
  const store = { appendRawEvents: async (_id: string, events: Record<string, unknown>[]) => { rows.push(...events) } } as never
  const provider = { name: 'adapter-type', listModels: () => [], async chat() { return { content: 'ok', toolCalls: [] } } }
  const aggregated = new AggregatedProvider(new Map([['primary', provider], ['other', provider]]), 'primary')
  const metered = usageProvider(aggregated, store, () => ({ sessionId: 's', physicalId: 'p' }))
  await metered.chat([], [], { model: 'm' })
  await metered.chat([], [], { model: 'm@other' })
  assert.deepEqual(rows.map(row => [row.model, row.provider]), [['m', 'primary'], ['m@other', 'other']])
})
