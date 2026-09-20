import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import { StartupDiagnosticsLog, startupFailure, startupLogPath, type StartupDiagnosticEntry } from './startup-diagnostics.js'

const entry: StartupDiagnosticEntry = {
  timestamp: '2026-09-18T00:00:00.000Z', role: 'main', event: 'failed', elapsedMs: 15000, kind: 'readiness-timeout',
}

test('startup logs are structured, bounded to three files, and omit unapproved data', t => {
  const directory = join(process.cwd(), '.startup-log-fixture-' + randomUUID())
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = startupLogPath(directory)
  const terminal: string[] = []
  const logger = new StartupDiagnosticsLog(path, 512, line => terminal.push(line))
  for (let i = 0; i < 30; i++) logger.write({
    ...entry, elapsedMs: i,
    message: 'private chat', token: 'secret-token', environment: { KEY: 'private-key' },
  } as StartupDiagnosticEntry)
  assert.deepEqual(readdirSync(join(directory, 'logs')).sort(), ['startup.jsonl', 'startup.jsonl.1', 'startup.jsonl.2'])
  for (const name of readdirSync(join(directory, 'logs'))) {
    const file = join(directory, 'logs', name)
    assert.ok(statSync(file).size <= 512)
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /private|secret|token|environment|message/)
    for (const line of text.trim().split('\n')) assert.equal(JSON.parse(line).kind, 'readiness-timeout')
  }
  assert.doesNotMatch(terminal.join(''), /private|secret/)
  assert.equal(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!).elapsedMs, 29)
})

test('untrusted diagnostic fields are rejected rather than redacted with a denylist', t => {
  const directory = join(process.cwd(), '.startup-log-fixture-' + randomUUID())
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const lines: string[] = []
  const logger = new StartupDiagnosticsLog(startupLogPath(directory), 512, line => lines.push(line))
  for (const invalid of [
    { role: 'secret' }, { timestamp: 'private' }, { event: 'provider-secret' }, { elapsedMs: NaN },
  ]) logger.write({ ...entry, ...invalid } as StartupDiagnosticEntry)
  assert.equal(lines.length, 0)
  logger.write({ ...entry, kind: 'secret', exitCode: 'private' } as unknown as StartupDiagnosticEntry)
  assert.doesNotMatch(lines.join(''), /secret|private/)
})

test('unwritable logs warn once without exposing filesystem errors or blocking startup', t => {
  const directory = join(process.cwd(), '.startup-log-fixture-' + randomUUID())
  mkdirSync(directory)
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'logs'), 'synthetic blocker')
  const lines: string[] = []
  const logger = new StartupDiagnosticsLog(startupLogPath(directory), 512, line => lines.push(line))
  logger.write(entry)
  logger.write(entry)
  assert.equal(lines.filter(line => line.includes('could not be saved')).length, 1)
  assert.doesNotMatch(lines.join(''), /\.startup-log-fixture|ENOTDIR|synthetic blocker/)
})

test('failure contract rejects unknown codes and strips raw messages and invalid duration', () => {
  assert.equal(startupFailure({ role: 'main', kind: 'secret' }), undefined)
  assert.deepEqual(startupFailure({ role: 'child', kind: 'early-exit', elapsedMs: -1 }), { role: 'child', kind: 'early-exit' })
})

test('persistent log projects backend phase fields through a second allowlist', t => {
  const directory = join(process.cwd(), '.startup-log-fixture-' + randomUUID())
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = startupLogPath(directory)
  const lines: string[] = []
  const logger = new StartupDiagnosticsLog(path, 512, line => lines.push(line))
  logger.write({
    ...entry, event: 'backend-phase',
    backend: {
      version: 1, component: 'project', phase: 'sessions', status: 'completed',
      elapsedMs: 40, durationMs: 30, projectOrdinal: 1,
      projectId: 'private-id', message: 'private-message',
    },
  } as StartupDiagnosticEntry)
  const text = readFileSync(path, 'utf8')
  assert.equal(JSON.parse(text).backend.projectOrdinal, 1)
  assert.equal(JSON.parse(text).backend.durationMs, 30)
  assert.doesNotMatch(text + lines.join(''), /private|projectId|message/)
})
