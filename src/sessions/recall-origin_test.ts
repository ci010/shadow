import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { recallOrigin } from './recall-origin.ts'
import { RecallIndex } from './recall-index.ts'
import type { SessionState } from './session-store.ts'

const state = (sessionId: string, extra: Partial<SessionState> = {}): SessionState =>
  ({ sessionId, automationVersion: 1, ...extra }) as SessionState

test('recall classification uses admitted turn provenance and structured ancestry, not names', () => {
  const states = new Map<string, SessionState>([
    ['ordinary', state('ordinary', { agentType: 'reflector' })],
    ['schedule-looking-address', state('schedule-looking-address')],
    ['learning', state('learning', { channelBoundary: { learning: { batchId: 'batch', pipeline: 'reflector' } } as SessionState['channelBoundary'] })],
    ['automation', state('automation', { automation: { jobId: 'job', name: 'job', runId: 'run', startedAt: '2026-01-01T00:00:00.000Z', contextMode: 'fresh', config: { source: 'cron', schedule: 'fixture' } } as SessionState['automation'] })],
    ['automatic-work', state('automatic-work', { automaticWork: {} as SessionState['automaticWork'] })],
    ['fresh', state('fresh', { statePersistence: {} as SessionState['statePersistence'] })],
    ['child', state('child', { parentSessionId: 'automation' })],
    ['grandchild', state('grandchild', { parentSessionId: 'child' })],
    ['ordinary-child', state('ordinary-child', { parentSessionId: 'ordinary' })],
    ['orphan', state('orphan', { parentSessionId: 'missing' })],
    ['cycle', state('cycle', { parentSessionId: 'cycle' })],
    ['legacy', state('legacy', { automationVersion: undefined })],
  ])
  const classify = (id: string, source: 'user' | 'session' | 'event' | undefined = 'user', sender?: string) =>
    recallOrigin(id, source, id => states.get(id), sender)
  for (const id of ['ordinary', 'schedule-looking-address', 'ordinary-child']) assert.equal(classify(id), 'conversation')
  for (const id of ['learning', 'automation', 'automatic-work', 'fresh', 'child', 'grandchild']) assert.equal(classify(id), 'excluded')
  for (const id of ['missing', 'orphan', 'cycle', 'legacy']) assert.equal(classify(id), 'unknown')
  assert.equal(classify('ordinary', 'event'), 'excluded')
  assert.equal(recallOrigin('ordinary', undefined, id => states.get(id)), 'unknown')
  assert.equal(classify('ordinary', 'session'), 'unknown')
  assert.equal(classify('ordinary', 'session', 'grandchild'), 'excluded')
  assert.equal(classify('ordinary', 'session', 'learning'), 'excluded')
  assert.equal(classify('ordinary', 'session', 'ordinary-child'), 'conversation')
})

test('v2 projection excludes legacy, unknown and automation; replay is stable across upgrade and rebuild', async () => {
  const root = mkdtempSync(join(process.cwd(), '.shadow-test-recall-'))
  const journal = join(root, 'recall.jsonl')
  const db = new DatabaseSync(':memory:')
  const rebuilt = new DatabaseSync(':memory:')
  try {
    // Pre-upgrade schema and aggregate have no reliable session provenance.
    db.exec('CREATE TABLE skill_recall (skill_path TEXT PRIMARY KEY, reads INTEGER NOT NULL); INSERT INTO skill_recall VALUES (\'legacy-only\',42)')
    appendFileSync(journal, JSON.stringify({ id: 'legacy', day: '2026-01-01', entry: 'legacy-event', source: 'skill' }) + '\n')
    const index = new RecallIndex(db, journal)
    for (const source of ['skill', 'active', 'automatic'] as const) {
      index.record('normal', source, 'conversation')
      index.record('excluded', source, 'excluded')
      index.record('unknown', source)
    }
    await index.replay(() => false)
    await index.replay(() => false)
    assert.deepEqual(index.usageSummary(true), {
      skills: [{ entry: 'normal', reads: 1 }],
      memory: [{ entry: 'normal', source: 'active', reads: 1 }, { entry: 'normal', source: 'automatic', reads: 1 }],
      coverage: 'complete',
    })
    assert.equal(db.prepare('SELECT reads FROM skill_recall WHERE skill_path=?').get('legacy-only')?.reads, 42)
    assert.equal(db.prepare('SELECT reads FROM skill_recall WHERE skill_path=?').get('legacy-event')?.reads, 1)
    assert.equal(db.prepare('SELECT reads FROM skill_recall WHERE skill_path=?').get('unknown')?.reads, 1)
    const fresh = new RecallIndex(rebuilt, journal)
    await fresh.replay(() => false)
    await fresh.replay(() => false)
    assert.deepEqual(fresh.usageSummary(true), index.usageSummary(true))
    assert.equal(rebuilt.prepare('SELECT reads FROM skill_recall WHERE skill_path=?').get('legacy-event')?.reads, 1)
  } finally { db.close(); rebuilt.close(); rmSync(root, { recursive: true, force: true }) }
})
