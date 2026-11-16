import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnManagedDriver, ManagedRuntimeError } from './managed.ts'
import { managedRunner } from './managed-runner.ts'
import { runInNewContext } from 'node:vm'

// Real Shadow IPC/helper, synthetic official SDK. No WSL, Docker or real Store.
// Fixture models the pinned public open/worker.start/status boundary; it does
// not purport to test WSL's process ownership or external-client race safety.
test('recovery runner requires absent same-home owner before public SDK open, never sweeps or replays Init', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-recovery-runner-test-'))
  try {
    const worker = join(dir, 'worker'), endpoint = join(worker, 'endpoint.json'), log = join(dir, 'calls.jsonl')
    await mkdir(worker)
    const sdk = join(dir, 'sdk.mjs')
    await writeFile(sdk, `
      import {appendFile} from 'node:fs/promises';
      const log = async value => appendFile(${JSON.stringify(log)}, JSON.stringify(value)+'\\n');
      export const LayerFSRuntime = {open: async settings => {
        if (settings.sweep !== false) throw Error('sweep forbidden');
        await log({action:'open',settings});
        return {
          worker:{start:async()=>log({action:'start'})},
          status:async()=>({worker:{state:'running',answering:true,secret:'DO_NOT_LEAK'},docker:{level:'ok',detail:'DO_NOT_LEAK'}}),
          project:{get_init:async()=>{await log({action:'get_init'});throw Object.assign(Error('DO_NOT_LEAK missing Init'),{code:'Unknown'})},start_init:async()=>{throw Error('Init forbidden')},list:async()=>[{name:'existing',initialized:true,image:'sha256:'+'a'.repeat(64),volume:'existing-volume'}]},
          volume:{list:async()=>[{name:'existing-volume',owner:'this',project:'existing',live:true}]},
          close:async()=>log({action:'close'})
        };
      }};
    `)
    const deployment = { runtimeModule: sdk, sdkModule: sdk, settings: { home: dir, sweep: false, bundle: '/sealed', containerPrefix: 'fixture-', wsl: { home: '/same-home' } } }
    const check = async (text: string | undefined, code: string) => {
      if (text !== undefined) await writeFile(endpoint, text)
      const driver = spawnManagedDriver({ requestTimeoutMs: 5000 })
      try {
        await assert.rejects(driver.request('recover_open', deployment, AbortSignal.timeout(6000)), (error: unknown) => {
          assert.ok(error instanceof ManagedRuntimeError); assert.equal(error.code, code)
          assert.ok(!error.message.includes('DO_NOT_LEAK')); return true
        })
      } finally { await driver.close() }
      await assert.rejects(readFile(log), { code: 'ENOENT' }, 'preflight must precede SDK import/open')
    }
    await check(undefined, 'RecoveryEvidenceUnavailable')
    await check('{DO_NOT_LEAK', 'RecoveryEvidenceUnavailable')
    for (const value of [{ home: '/other', pid: process.pid }, { home: '/same-home' }, { home: '/same-home', pid: -1 }, { home: '/same-home', pid: '1' }]) await check(JSON.stringify({ ...value, secret: 'DO_NOT_LEAK' }), 'RecoveryIdentityMismatch')
    await check(JSON.stringify({ home: '/same-home', pid: process.pid, secret: 'DO_NOT_LEAK' }), 'RecoveryOwnerLive')
    // Obtain a definitely exited host PID, not an assumed unused number.
    const child = execFile(process.execPath, ['-e', ''], { windowsHide: true })
    const pid = child.pid!
    await once(child, 'exit')
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    await writeFile(endpoint, JSON.stringify({ home: '/same-home', pid, secret: 'DO_NOT_LEAK' }))
    const admissions = join(dir, 'shadow-init-admissions')
    await mkdir(admissions); await writeFile(join(admissions, 'existing.json'), 'unknown Init admission')
    const driver = spawnManagedDriver({ requestTimeoutMs: 5000 })
    try {
      const status = await driver.request('recover_open', deployment, AbortSignal.timeout(6000)) as any
      assert.equal(status.ready, true); assert.ok(!JSON.stringify(status).includes('DO_NOT_LEAK'))
      const config = await driver.request('configuration', { project: 'existing' }, AbortSignal.timeout(6000)) as any
      assert.equal(config.env.LAYERFS_HOME, '/same-home'); assert.equal(config.env.LAYERFS_VOLUME, 'existing-volume')
      // Missing upstream Init history remains a failure after reconnection, not success.
      await assert.rejects(driver.request('official_project', { method: 'get_init', args: ['lost-job'] }, AbortSignal.timeout(6000)), /unknown/i)
      const source = '/var/lib/shadow-layerfs-sources/' + 'a'.repeat(64) + '/repo'
      const profile = await driver.request('context', {}, AbortSignal.timeout(6000), async () => source) as any
      const response = await fetch(`http://127.0.0.1:${profile.port}`, { method: 'POST', headers: { authorization: `Bearer ${profile.token}` },
        body: JSON.stringify({ action: 'official_project', input: { method: 'start_init', args: ['existing', source, { image: 'sha256:' + 'a'.repeat(64), timeout: 1000 }] } }) })
      const receipt = await response.json() as any
      assert.equal(receipt.ok, false); assert.equal(receipt.code, 'ImportAlreadyAttempted')
      assert.ok(!JSON.stringify(receipt).includes(profile.token))
      assert.equal(await readFile(join(admissions, 'existing.json'), 'utf8'), 'unknown Init admission')
    } finally { await driver.close() }
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(calls.map(value => value.action), ['open', 'start', 'get_init', 'close'])
    assert.deepEqual(calls[0].settings, deployment.settings)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('owner preflight treats host PID permission and probe failures as unknown, never as absence', async () => {
  // Extract the actual fixed helper with synthetic host process/fs boundaries.
  // Upstream endpoint.pid is spawn("wsl.exe").pid, not a Linux PID.
  const source = managedRunner.slice(managedRunner.indexOf('async function recoveryOwner('), managedRunner.indexOf('let runtime, deployment'))
  for (const code of ['EPERM', 'EACCES', undefined, 'ESRCH']) {
    const calls: unknown[] = []
    const probe = runInNewContext(source + '\nrecoveryOwner', {
      join,
      readFile: async () => JSON.stringify({ home: '/same-home', pid: 123, secret: 'DO_NOT_LEAK' }),
      process: { kill: (pid: number, signal: number) => { calls.push([pid, signal]); throw Object.assign(new Error('DO_NOT_LEAK'), { code }) } },
      fail: (value: string) => { throw new Error(value) },
    })
    const result = probe({ settings: { home: 'host-home', wsl: { home: '/same-home' } } })
    if (code === 'ESRCH') await result
    else await assert.rejects(result, /^Error: RecoveryOwnerUnknown$/)
    assert.deepEqual(calls, [[123, 0]])
  }
})
