import assert from 'node:assert/strict'
import test from 'node:test'
import { BackendStartupDiagnostics, type BackendStartupTiming } from './backend-startup-diagnostics.js'

const marker = (fields: Record<string, unknown> = {}) => '[startup] ' + JSON.stringify({
  version: 1, component: 'project', projectId: 'synthetic-private-project',
  phase: 'sessions', status: 'completed', elapsedMs: 900, durationMs: 350, ...fields,
}) + '\n'

test('agent and session startup substages retain timings without exposing project identity', () => {
  const phases = [
    'agent-mcp', 'agent-skills', 'agent-types', 'agent-watchers', 'agent-sessions',
    'session-load', 'session-migrate', 'session-lineage', 'session-task-history', 'session-reports', 'session-recovery',
  ]
  const entries: BackendStartupTiming[] = []
  const parser = new BackendStartupDiagnostics(entry => entries.push(entry))
  for (const phase of phases) parser.push('stdout', marker({ phase }))
  assert.deepEqual(entries.map(entry => entry.phase), phases)
  assert.ok(entries.every(entry => entry.durationMs === 350 && entry.projectOrdinal === 1))
  assert.doesNotMatch(JSON.stringify(entries), /private|projectId/)
})

test('backend timing markers survive chunk boundaries and redact project identities with stable ordinals', () => {
  const entries: BackendStartupTiming[] = []
  const parser = new BackendStartupDiagnostics(entry => entries.push(entry))
  const first = marker()
  parser.push('stdout', first.slice(0, 5))
  parser.push('stderr', marker({ projectId: 'another-private-project' }))
  parser.push('stdout', first.slice(5, 32))
  parser.push('stdout', first.slice(32).replace(/\n$/, '\r\n'))
  parser.push('stdout', marker({ phase: 'ready', durationMs: undefined }))
  assert.deepEqual(entries.map(entry => entry.projectOrdinal), [1, 2, 2])
  assert.deepEqual(entries[1], {
    version: 1, component: 'project', phase: 'sessions', status: 'completed',
    elapsedMs: 900, durationMs: 350, projectOrdinal: 2,
  })
  assert.doesNotMatch(JSON.stringify(entries), /private|projectId/)
})

test('backend diagnostics reject raw, unknown and malformed fields, phases and durations', () => {
  const entries: BackendStartupTiming[] = []
  const parser = new BackendStartupDiagnostics(entry => entries.push(entry))
  parser.push('stdout', 'provider-key=private\n[other] {"private":"secret"}\n[startup] invalid-json\n')
  for (const fields of [
    { token: 'private-key' }, { phase: 'private-phase' }, { status: 'private-status' },
    { component: 'private-component' }, { elapsedMs: -1 }, { elapsedMs: Infinity },
    { durationMs: 0.5 }, { version: 2 }, { projectId: 42 },
    { projectId: 'x'.repeat(201) }, { component: 'host' },
    { projectOrdinal: 1 },
  ]) parser.push('stdout', marker(fields))
  assert.equal(entries.length, 0)
  parser.push('stdout', marker({ component: 'host', projectId: undefined, phase: 'projects' }))
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.projectOrdinal, undefined)
})

test('backend parsing drops oversized lines without capturing their tail and caps record volume', () => {
  const entries: BackendStartupTiming[] = []
  const parser = new BackendStartupDiagnostics(entry => entries.push(entry))
  parser.push('stdout', 'x'.repeat(2500))
  parser.push('stdout', marker())
  assert.equal(entries.length, 0)
  parser.push('stdout', marker().repeat(700))
  parser.push('stderr', marker().repeat(700))
  assert.equal(entries.length, 512)
})

test('backend diagnostics bound the project identity map', () => {
  const entries: BackendStartupTiming[] = []
  const parser = new BackendStartupDiagnostics(entry => entries.push(entry))
  for (let i = 0; i < 200; i++) parser.push('stdout', marker({ projectId: `project-${i}` }))
  assert.equal(entries.length, 128)
  assert.equal(entries.at(-1)?.projectOrdinal, 128)
})
