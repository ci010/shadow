import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import { ManagedLayerFS, ManagedRuntimeError, spawnManagedDriver } from './managed.ts'
import { layerfsName } from './bridge.ts'
import { ToolOutcomeUnknownError } from '../../tools/tool.ts'

const signal = () => new AbortController().signal
async function temporary(work: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-import-test-'))
  try { await work(dir) } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

test('real helper diagnoses an import without queueing health behind it, and retains sanitized SDK deadline evidence', async () => {
  await temporary(async dir => {
    const sdk = join(dir, 'runtime.mjs')
    await writeFile(sdk, `
      import { writeFile } from 'node:fs/promises';
      export const LayerFSRuntime = { open: async () => {
        let reads=0, started;
        return {worker:{start:async()=>{}}, status:async()=>{await writeFile(${JSON.stringify(join(dir, 'health-count'))},String(++reads));return {worker:{state:'running',answering:true},docker:{level:'ok'}}},
          project:{start_init:async(_name,_source,{timeout})=>{if(timeout!==1000)throw Error('wrong budget'); started=Date.now(); return {id:'safe-job'}},
            get_init:async()=>Date.now()-started<350 ? {step:'scan',scanned:{entries:7,files:4,bytes:100,secret:'NEVER_RETURN'},error:{message:'NEVER_RETURN'}}
              : {step:'failed',error:{code:'Failed',message:'InitFailure { binding_key: [1,2], cursor_key: PRIVATE_KEY, error: Project(Deadline) }'}}}, close:async()=>{}};
      }};
    `)
    const driver = spawnManagedDriver({ requestTimeoutMs: 2000 })
    try {
      await driver.request('open', { runtimeModule: sdk, settings: {}, project: 'fixture' }, signal())
      const scanning = Promise.withResolvers<void>()
      const progress: unknown[] = []
      const creation = driver.request('create', { source: dir, timeoutMs: 1000 }, signal(), value => { progress.push(value); if (value.stage === 'scan') scanning.resolve() })
      const rejected = assert.rejects(creation, (error: unknown) => error instanceof ManagedRuntimeError && error.code === 'ImportDeadline')
      await scanning.promise
      const status: any = await driver.request('status', {}, signal())
      assert.equal(status.health, 'not_checked'); assert.equal(status.docker, 'unknown'); assert.equal(status.ready, false)
      assert.equal(status.operation.stage, 'scan'); assert.equal(status.operation.scanned.files, 4)
      assert.equal(await readFile(join(dir, 'health-count'), 'utf8'), '1', 'Busy status must not enter the SDK health method')
      const live: any = await driver.request('import_status', {}, signal())
      assert.equal(live.jobId, 'safe-job'); assert.equal(live.stage, 'scan')
      await rejected
      const failed: any = await driver.request('import_status', {}, signal())
      assert.equal(failed.stage, 'failed'); assert.equal(failed.code, 'ImportDeadline')
      assert.doesNotMatch(JSON.stringify({ failed, progress, status, live }), /NEVER_RETURN|PRIVATE_KEY|binding_key|cursor_key/)
      await assert.rejects(driver.request('create', { source: dir, timeoutMs: 1000 }, signal()), (error: unknown) => error instanceof ManagedRuntimeError && error.code === 'ImportAlreadyAttempted')
    } finally { await driver.close() }
  })
})

for (const mode of ['progress', 'silence', 'native-deadline', 'invalid-progress'] as const) {
  test(`managed IPC import observation distinguishes ${mode} without replay or kill`, async () => {
    const child: any = new EventEmitter(); child.connected = true
    let interval: ReturnType<typeof setInterval> | undefined, completion: ReturnType<typeof setTimeout> | undefined, sends = 0
    child.send = (request: any, callback: (error?: Error) => void) => {
      callback()
      if (request.action === 'close') { queueMicrotask(() => child.emit('message', { id: request.id, ok: true, result: { closed: true } })); return }
      sends++
      if (mode === 'silence') return
      interval = setInterval(() => child.emit('message', { id: request.id, progress: mode === 'invalid-progress' ? { stage: 'scan', secret: 'FORBIDDEN' } : { stage: 'scan', scanned: { entries: 1 } } }), 25)
      assert.equal(request.input.timeoutMs, 600000, 'The same configured budget is sent to the SDK helper')
      if (mode === 'progress' || mode === 'native-deadline') completion = setTimeout(() => {
        clearInterval(interval)
        child.emit('message', mode === 'progress' ? { id: request.id, ok: true, result: 'done' } : { id: request.id, ok: false, code: 'ImportDeadline' })
      }, 400)
    }
    child.disconnect = () => { child.connected = false }; child.unref = () => child
    child.kill = () => { throw Error('Must never force-kill unknown work') }
    const driver = spawnManagedDriver({ launch: (() => child) as unknown as typeof spawn, requestTimeoutMs: 150 })
    try {
      const request = driver.request('create', { timeoutMs: 600000 }, signal())
      if (mode === 'progress') assert.equal(await request, 'done')
      else if (mode === 'native-deadline') await assert.rejects(request, (error: unknown) => error instanceof ManagedRuntimeError && error.code === 'ImportDeadline')
      else await assert.rejects(request, (error: unknown) => error instanceof ToolOutcomeUnknownError && /heartbeat lost/.test(error.message))
      assert.equal(sends, 1)
    } finally { clearInterval(interval); clearTimeout(completion); await driver.close() }
  })
}

test('read-only diagnostics recognize legacy SDK Deadline without exposing paths, catalog keys or starting a worker', async () => {
  await temporary(async home => {
    const dir = join(home, 'state', 'layerfs', 'runtime', '.runtime'); await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'init-failures.jsonl'), JSON.stringify({ project: { name: layerfsName('one'), source: 'PRIVATE_SOURCE', volume: 'PRIVATE_VOLUME' },
      code: 'Failed', message: 'InitFailure { binding_key: PRIVATE_KEY, error: Project(Deadline) }' }) + '\n')
    const service = new ManagedLayerFS('one', home, () => { throw Error('diagnostics must not start a helper') }, 'win32')
    const status = await service.importStatus(signal())
    assert.equal(status.observation, 'retained_sdk_failure'); assert.equal(status.code, 'ImportDeadline'); assert.equal(status.retryAllowed, false)
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|binding_key/)
    await service.close()
  })
})

for (const missing of [false, true]) test(`lost import observation stays unknown, not terminal; missing-state=${missing}`, async () => {
  await temporary(async dir => {
    const sdk = join(dir, 'runtime.mjs')
    await writeFile(sdk, `export const LayerFSRuntime={open:async()=>({worker:{start:async()=>{}},status:async()=>({worker:{state:'running',answering:true},docker:{level:'ok'}}),
      project:{start_init:async()=>({id:'job'}),get_init:async()=>{${missing ? 'return null' : "throw Object.assign(Error('LOST_PRIVATE_DIAGNOSTIC'),{code:'Unknown'})"}}},close:async()=>{}})}`)
    const driver = spawnManagedDriver({ requestTimeoutMs: 2000 })
    try {
      await driver.request('open', { runtimeModule: sdk, settings: {}, project: 'fixture' }, signal())
      await assert.rejects(driver.request('create', { source: dir }, signal()), ToolOutcomeUnknownError)
      const status: any = await driver.request('import_status', {}, signal())
      assert.equal(status.stage, 'unknown'); assert.equal(status.endedAt, undefined)
      assert.doesNotMatch(JSON.stringify(status), /LOST_PRIVATE_DIAGNOSTIC/)
    } finally { await driver.close() }
  })
})


test('valid managed heartbeats outlive the former SDK-budget-plus-15-minute cutoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child: any = new EventEmitter(); child.connected = true
  let creation: any, sends = 0
  child.send = (request: any, callback: (error?: Error) => void) => {
    callback()
    if (request.action === 'close') child.emit('message', { id: request.id, ok: true, result: { closed: true } })
    else { creation = request; sends++ }
  }
  child.disconnect = () => { child.connected = false }; child.unref = () => child
  child.kill = () => { throw Error('Must never force-kill unknown work') }
  // Isolate the removed overall cutoff from Node mock timers' refresh semantics.
  // Short real-timer tests above separately verify the renewable silence watchdog.
  const driver = spawnManagedDriver({ launch: (() => child) as unknown as typeof spawn, requestTimeoutMs: 2000000 })
  try {
    let settled = false
    const result = driver.request('create', { timeoutMs: 1000 }, signal())
    void result.then(() => { settled = true }, () => { settled = true })
    for (let second = 0; second < 920; second++) {
      child.emit('message', { id: creation.id, progress: { stage: 'import' } })
      t.mock.timers.tick(1000)
    }
    await Promise.resolve()
    assert.equal(settled, false, 'Only the native SDK may declare import deadline; heartbeat is not completion')
    child.emit('message', { id: creation.id, ok: false, code: 'ImportDeadline' })
    await assert.rejects(result, (error: unknown) => error instanceof ManagedRuntimeError && error.code === 'ImportDeadline')
    assert.equal(sends, 1)
  } finally { await driver.close() }
})
