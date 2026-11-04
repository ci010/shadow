import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { ProjectCatalog } from './catalog.ts'
import { reserveRemoteSessionWorkdirs } from './session-ownership.ts'
import { NodeSidecarSupervisor, type SidecarChildProcess } from '../../desktop/src/sidecar/supervisor.ts'
import { StartupDiagnosticsLog, startupLogPath, type StartupDiagnosticEntry } from '../../desktop/src/sidecar/startup-diagnostics.ts'

class Child extends EventEmitter implements SidecarChildProcess {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}

test('ownership failure travels through child capture to desktop terminal and disk without private fields', async t => {
  await withTempWorkspace(async root => {
    const home = join(root, 'private-home')
    const catalog = new ProjectCatalog(join(root, 'catalog'))
    await catalog.init()
    await mkdir(projectStoragePath(home, '.cron'), { recursive: true })
    await writeFile(projectStoragePath(home, '.cron/jobs.json'), '{"private-session": INVALID}')
    const child = new Child()
    const terminal: string[] = []
    const path = startupLogPath(join(root, 'desktop-profile'))
    const log = new StartupDiagnosticsLog(path, undefined, line => terminal.push(line))
    const supervisor = new NodeSidecarSupervisor({
      spawn: () => child,
      readinessProbe: () => new Promise(() => {}),
      diagnosticSink: entry => log.write(entry),
    })
    const starting = supervisor.start({ role: 'main', executablePath: 'synthetic.exe', entryPath: 'entry.js', configPath: 'config.json', launchToken: 'private-token', port: 43123 })
    const lines: string[] = []
    t.mock.method(console, 'error', (line: string) => {
      lines.push(line)
      child.stderr.emit('data', line.slice(0, 17))
      child.stderr.emit('data', line.slice(17) + '\r\n')
    })
    try {
      await assert.rejects(reserveRemoteSessionWorkdirs(home, catalog, 'private-project'), SyntaxError)
      assert.deepEqual(catalog.remoteClaims(), [])
      const marker = lines[0]!
      for (const bad of [marker + ' message=private-message', marker.replace('error=SyntaxError', 'error=private'), 'private-output', marker.replace('stage=cron', 'stage=private')]) {
        child.stdout.emit('data', bad + '\n')
      }
      const base = { timestamp: new Date().toISOString(), role: 'main', event: 'backend-storage-validation-failed', elapsedMs: 0 } as const
      log.write({ ...base, storageValidation: { stage: 'cron', source: 'cron', error: 'SyntaxError', message: 'private-message' } } as unknown as StartupDiagnosticEntry)
      child.emit('exit', 1, null)
      assert.equal((await starting).phase, 'failed')
      const text = await readFile(path, 'utf8')
      const records = text.trim().split('\n').map(line => JSON.parse(line))
      const failures = records.filter(entry => entry.event === 'backend-storage-validation-failed')
      assert.equal(failures.length, 1)
      assert.deepEqual(failures[0].storageValidation, { stage: 'cron', source: 'cron', error: 'SyntaxError' })
      assert.ok(terminal.some(line => line.startsWith('[desktop:startup] ') && line.includes('backend-storage-validation-failed')))
      assert.doesNotMatch(text + terminal.join('\n'), /private|INVALID|message|projectId/)
      assert.ok(!text.includes(root))
    } finally { await supervisor.stop() }
  })
})

for (const scenario of [
  { name: 'focus schema', fields: { focus: { secret: 'private-value' } }, source: 'session-metadata' },
  { name: 'legacy Work schema', fields: { initiativeName: 'private-value' }, source: 'initiative-metadata' },
  { name: 'fresh slot shape', fields: null, source: 'fresh-automation-state' },
  { name: 'archive claim', fields: null, source: 'fresh-automation-state' },
]) test(`JSONL ${scenario.name} failure retains source frames through supervisor and disk`, async t => {
  await withTempWorkspace(async root => {
    const home = join(root, 'private-home')
    const directory = projectStoragePath(home, '.sessions')
    const catalog = new ProjectCatalog(join(root, 'catalog'))
    await catalog.init()
    const target = scenario.fields === null
      ? join(directory, '.fresh-automation-v1-jsonl', 'private-slot.json')
      : join(directory, 'private-session.json')
    await mkdir(scenario.fields === null ? join(directory, '.fresh-automation-v1-jsonl') : directory, { recursive: true })
    const raw = scenario.fields === null ? 'null' : JSON.stringify({
      ownershipVersion: 2, projectId: 'private-project', sessionId: 'private-session', segmentIndex: 0, ...scenario.fields,
    })
    if (scenario.name === 'archive claim') {
      const db = new DatabaseSync(join(directory, '.fresh-automation-v1-jsonl', 'archive.db'))
      try {
        db.exec('CREATE TABLE claims (project_id TEXT NOT NULL, folder_id TEXT NOT NULL, workdir TEXT NOT NULL, PRIMARY KEY(project_id, folder_id, workdir))')
        db.prepare('INSERT INTO claims VALUES (?, ?, ?)').run('private-project', 'private-folder', 'null')
      } finally { db.close() }
    } else await writeFile(target, raw)
    const child = new Child()
    const terminal: string[] = []
    const path = startupLogPath(join(root, 'desktop-profile'))
    const log = new StartupDiagnosticsLog(path, undefined, line => terminal.push(line))
    const supervisor = new NodeSidecarSupervisor({ spawn: () => child, readinessProbe: () => new Promise(() => {}), diagnosticSink: entry => log.write(entry) })
    const starting = supervisor.start({ role: 'main', executablePath: 'synthetic.exe', entryPath: 'entry.js', configPath: 'config.json', launchToken: 'private-token', port: 43123 })
    t.mock.method(console, 'error', (line: string) => {
      child.stderr.emit('data', line.slice(0, 31))
      child.stderr.emit('data', line.slice(31) + '\r\n')
    })
    try {
      await assert.rejects(reserveRemoteSessionWorkdirs(home, catalog, 'private-project'), scenario.name === 'archive claim' ? /Invalid archived workdir claim/ : TypeError)
      child.emit('exit', 1, null)
      assert.equal((await starting).phase, 'failed')
      const text = await readFile(path, 'utf8')
      const failures = text.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'backend-storage-validation-failed')
      assert.equal(failures.length, 1)
      const diagnostic = failures[0].storageValidation
      assert.equal(diagnostic.stage, 'jsonl')
      assert.equal(diagnostic.source, 'jsonl')
      assert.equal(diagnostic.error, scenario.name === 'archive claim' ? 'Error' : 'TypeError')
      assert.match(diagnostic.frames[0], new RegExp(`^src/sessions/${scenario.source}\\.ts:[1-9]\\d*:[1-9]\\d*$`))
      assert.ok(diagnostic.frames.length <= 4)
      assert.ok(terminal.some(line => line.includes(JSON.stringify(diagnostic))))
      assert.doesNotMatch(text + terminal.join('\n'), /private|secret|message|projectId/)
      assert.ok(!text.includes(root))
      if (scenario.name === 'archive claim') {
        const db = new DatabaseSync(join(directory, '.fresh-automation-v1-jsonl', 'archive.db'), { readOnly: true })
        try { assert.equal(db.prepare('SELECT workdir FROM claims').get()?.workdir, 'null') }
        finally { db.close() }
      } else assert.equal(await readFile(target, 'utf8'), raw)
      assert.deepEqual(catalog.remoteClaims(), [])
    } finally { await supervisor.stop() }
  })
})
