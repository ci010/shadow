import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ManagedLayerFS, type ManagedDriver } from './managed.ts'
import { LayerFSBootstrap } from './bootstrap.ts'
import type { BootstrapRun } from './bootstrap-command.ts'
import { LayerFSTool } from '../../tools/layerfs.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { ToolOutcomeUnknownError, toolResultText } from '../../tools/tool.ts'

const ready = { worker: 'running', answering: true, docker: 'ok', ready: true, sandboxVerified: false }
const request = { action: 'bootstrap_recover_connection', executionId: 'bg:retained', approved: true, allowRootWorker: true }
async function fixture(work: (f: any) => Promise<void>) {
  const home = await mkdtemp(join(process.cwd(), '.layerfs-recover-test-'))
  const directory = join(home, 'state', 'layerfs'), bootstrapDir = join(directory, 'bootstrap')
  try {
    await mkdir(bootstrapDir, { recursive: true }); await mkdir(join(home, 'config'))
    const installation = { apiRoot: join(home, 'api-root'), bundle: '/sealed/build', image: 'sha256:' + 'a'.repeat(64), distribution: 'FixtureWSL', node: '/sealed/node' }
    const journal = { version: 1, projectId: 'p', sessionId: 'web:original', phase: 'uncertain', step: 'connect_worker', provisioningStarted: true,
      key: 'a'.repeat(32), distribution: 'FixtureWSL', executionId: request.executionId, code: 'OUTCOME_UNKNOWN', installation,
      approval: { sessionId: 'web:original', physicalId: 'original-0', requestId: 'original-consent' } }
    const journalPath = join(bootstrapDir, 'bootstrap.json')
    await writeFile(journalPath, JSON.stringify(journal))
    await writeFile(join(directory, 'worker-state.json'), JSON.stringify({ phase: 'uncertain' }))
    await writeFile(join(home, 'config', 'layerfs-managed.json'), JSON.stringify({ version: 1, projectId: 'p', installation, approvedRootWorker: true }))
    const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
    const context = { projectId: 'p', sessionId: 'web:operator', channel: 'web', admin: true, tools, signal: new AbortController().signal } as ExecutionContext
    const calls: string[] = []
    let startup: unknown = ready
    const driver: ManagedDriver = { async request(action) {
      calls.push(action)
      assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).step, 'recover_connect_worker', 'Recovery admission must be durable before worker startup')
      if (startup instanceof Error) throw startup
      return startup
    }, async close() { calls.push('close') } }
    const service = new ManagedLayerFS('p', home, () => driver, 'win32')
    let probe: BootstrapRun = async command => {
      calls.push(command.file)
      assert.equal(command.input, undefined)
      if (command.file === 'powershell.exe') return { code: 0, stdout: Buffer.from('0'), stderr: Buffer.alloc(0) }
      assert.ok(JSON.stringify(command.args) === JSON.stringify(['--list', '--running', '--quiet']) || JSON.stringify(command.args) === JSON.stringify(['--list', '--quiet']))
      return { code: 0, stdout: Buffer.from(command.args.includes('--running') ? '' : 'FixtureWSL\r\n'), stderr: Buffer.alloc(0) }
    }
    const bootstrap = new LayerFSBootstrap('p', home, { runPromiseTask() { throw Error('Must never rebuild') } }, service,
      (command, signal) => probe(command, signal), 'win32', 'x64')
    const tool = new LayerFSTool('p', home, service, bootstrap)
    try { await work({ home, directory, journal, journalPath, installation, context, service, bootstrap, tool, calls,
      setStartup: (value: unknown) => { startup = value }, setProbe: (run: BootstrapRun) => { probe = run } }) }
    finally { await service.close() }
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

test('guarded recovery preserves build/history, records admission before one connection, imports nothing', async () => {
  await fixture(async f => {
    assert.equal((await f.bootstrap.status(f.context)).connectionRecoveryCandidate, true)
    const result = JSON.parse(toolResultText(await f.tool.execute(request, f.context))).result
    assert.equal(result.status, 'ready'); assert.equal(result.rebuilt, false); assert.equal(result.imported, false)
    assert.deepEqual(f.calls, ['powershell.exe', 'wsl.exe', 'wsl.exe', 'open'])
    const current = JSON.parse(await readFile(f.journalPath, 'utf8'))
    assert.equal(current.phase, 'ready'); assert.equal(current.recoveredBy, 'web:operator'); assert.deepEqual(current.installation, f.installation)
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'bootstrap', 'history', `${f.journal.key}-uncertain.json`), 'utf8')), f.journal)
    assert.equal((await readdir(join(f.directory, 'history'))).length, 1)
    await assert.rejects(f.tool.execute(request, f.context), /requires the exact retained/)
    assert.equal(f.calls.filter((value: string) => value === 'open').length, 1)
  })
})

for (const refusal of ['consent', 'foreign-id', 'task', 'runtime-exists', 'running-distro', 'retained-helper', 'bad-inventory', 'profile-mismatch', 'later-stage']) {
  test(`connection recovery refuses ${refusal} without launching anything`, async () => {
    await fixture(async f => {
      let args = request, ctx = f.context
      if (refusal === 'consent') args = { ...request, approved: false }
      if (refusal === 'foreign-id') args = { ...request, executionId: 'bg:other' }
      if (refusal === 'task') ctx = { ...ctx, tools: { ...ctx.tools, executionMode: 'task' } }
      if (refusal === 'runtime-exists') await mkdir(join(f.directory, 'runtime'))
      if (refusal === 'running-distro' || refusal === 'retained-helper' || refusal === 'bad-inventory') f.setProbe(async (command: any) => ({ code: 0, stderr: Buffer.alloc(0),
        stdout: Buffer.from(command.file === 'powershell.exe' ? refusal === 'retained-helper' ? '1' : refusal === 'bad-inventory' ? 'unavailable' : '0' : 'FixtureWSL\r\n') }))
      if (refusal === 'profile-mismatch') await writeFile(join(f.home, 'config', 'layerfs-managed.json'), JSON.stringify({ version: 1, projectId: 'p', approvedRootWorker: true, installation: { ...f.installation, distribution: 'OtherWSL' } }))
      if (refusal === 'later-stage') await writeFile(f.journalPath, JSON.stringify({ ...f.journal, step: 'recover_connect_worker' }))
      await assert.rejects(f.tool.execute(args, ctx))
      assert.equal(f.calls.includes('open'), false)
      assert.equal(JSON.parse(await readFile(join(f.directory, 'worker-state.json'), 'utf8')).phase, 'uncertain')
    })
  })
}

test('failed recovery retains uncertainty and cannot replay; connected but unhealthy is not reported ready', async () => {
  for (const failed of [true, false]) await fixture(async f => {
    f.setStartup(failed ? new ToolOutcomeUnknownError('lost connection receipt') : { ...ready, docker: 'down', ready: false })
    if (failed) {
      await assert.rejects(f.tool.execute(request, f.context), ToolOutcomeUnknownError)
      const journal = JSON.parse(await readFile(f.journalPath, 'utf8'))
      assert.equal(journal.phase, 'uncertain'); assert.equal(journal.step, 'recover_connect_worker')
    } else {
      const result = JSON.parse(toolResultText(await f.tool.execute(request, f.context))).result
      assert.equal(result.status, 'not_ready'); assert.equal(JSON.parse(await readFile(f.journalPath, 'utf8')).phase, 'blocked')
    }
    await assert.rejects(f.tool.execute(request, f.context), /requires the exact retained/)
    assert.equal(f.calls.filter((value: string) => value === 'open').length, 1)
  })
})

test('recovery owns setup/connect and refuses state changes during read-only inspection', async () => {
  await fixture(async f => {
    f.setProbe(async (command: any) => {
      await assert.rejects(f.service.connect(f.context.signal), /setup\/recovery owns/)
      await assert.rejects(f.service.setup(f.installation, f.context.signal), /already owned/)
      if (command.file === 'wsl.exe') await writeFile(f.journalPath, JSON.stringify({ ...f.journal, step: 'changed-by-another-owner' }))
      return { code: 0, stdout: Buffer.from(command.file === 'powershell.exe' ? '0' : command.args.includes('--running') ? '' : 'FixtureWSL\r\n'), stderr: Buffer.alloc(0) }
    })
    await assert.rejects(f.tool.execute(request, f.context), /changed during inspection/)
    assert.equal(f.calls.includes('open'), false)
    assert.equal(JSON.parse(await readFile(join(f.directory, 'worker-state.json'), 'utf8')).phase, 'uncertain')
  })
})

test('malformed or incomplete WSL inventory is not proof of a stopped distribution', async () => {
  for (const bad of ['Inventory could not be determined!', 'UnknownDistro']) await fixture(async f => {
    f.setProbe(async (command: any) => ({ code: 0, stdout: Buffer.from(command.file === 'powershell.exe' ? '0' : command.args.includes('--running') ? bad : 'FixtureWSL\r\n'), stderr: Buffer.alloc(0) }))
    await assert.rejects(f.tool.execute(request, f.context), /inventory is incomplete/)
    assert.equal(f.calls.includes('open'), false)
    assert.equal(JSON.parse(await readFile(f.journalPath, 'utf8')).step, 'connect_worker')
  })
})

test('shutdown waits for recovery admission and forbids worker dispatch after close', async () => {
  await fixture(async f => {
    const admitted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const lease = f.service.acquireSetup()
    const run: BootstrapRun = async command => ({ code: 0, stdout: Buffer.from(command.file === 'powershell.exe' ? '0' : command.args.includes('--running') ? '' : 'FixtureWSL\r\n'), stderr: Buffer.alloc(0) })
    const recovery = f.service.recoverUnstartedConnection(f.installation, f.context.signal, lease.token, async () => { admitted.resolve(); await release.promise }, run)
    await admitted.promise
    let closed = false
    const closing = f.service.close().then(() => { closed = true })
    await Promise.resolve()
    assert.equal(closed, false, 'Shutdown must wait for the recovery lifecycle')
    release.resolve()
    await assert.rejects(recovery, /shutting down/)
    await closing
    lease.release()
    assert.equal(f.calls.includes('open'), false)
    assert.equal(JSON.parse(await readFile(join(f.directory, 'worker-state.json'), 'utf8')).phase, 'uncertain')
  })
})
