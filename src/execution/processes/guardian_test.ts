import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, test } from 'node:test'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { ProcessManager } from './manager.ts'
import { DURABLE_SHELL_OPERATION, isUnknownShellReceipt, ShellJournal } from '../shell-journal.ts'

async function until(check: () => Promise<boolean>, milliseconds = 12_000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!await check()) {
    assert(Date.now() < deadline, 'Timed out waiting for the guarded process tree')
    await delay(25)
  }
}

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
    throw error
  }
}

async function running(pid: number): Promise<boolean> {
  try { process.kill(pid, 0) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
  if (process.platform === 'win32') return true
  try {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'stat=', '-p', String(pid)])
    return !stdout.trim().startsWith('Z')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1 && 'stdout' in error && error.stdout === '') return false
    throw error
  }
}

test('real runtime SIGKILL stops its command and descendant and leaves an independent durable receipt', { timeout: 25_000 }, async () => {
  await withTempWorkspace(async root => {
    const script = `
const fs = require('node:fs'), cp = require('node:child_process');
if (process.argv[2] === 'worker') {
  fs.writeFileSync('descendant.pid', String(process.pid));
  setInterval(() => fs.appendFileSync('effects.txt', 'effect\\n'), 30);
} else {
  fs.appendFileSync('starts.txt', 'start\\n');
  fs.writeFileSync('command.pid', String(process.pid));
  cp.spawn(process.execPath, [__filename, 'worker'], {stdio: 'ignore'});
  setInterval(() => {}, 1000);
}
`
    await writeFile(join(root, 'command with spaces.cjs'), script)
    const id = crypto.randomUUID()
    const owner = spawn(process.execPath, ['--import', import.meta.resolve('tsx'),
      fileURLToPath(new URL('../../testing/shell-owner-fixture.ts', import.meta.url)), root, id, '15000'],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
    const ownerExit = new Promise<void>(resolve => owner.once('close', () => resolve()))
    let errors = ''
    owner.stderr!.on('data', chunk => { errors += chunk.toString() })
    const journal = new ShellJournal(join(root, 'journal'))
    const request = {
      version: 1 as const, jobId: id, idempotencyKey: id, sessionId: 'session', turnId: 'turn',
      nodeId: 'child', capabilityId: 'root', operation: DURABLE_SHELL_OPERATION,
      args: { script: `"${process.execPath}" "command with spaces.cjs"` },
      createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 15000).toISOString(),
    }
    try {
      await until(async () => (await readOptional(join(root, 'effects.txt'))).length > 20)
      const parentPid = Number(await readFile(join(root, 'command.pid'), 'utf8'))
      const descendantPid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'))
      const killedAt = Date.now()
      owner.kill('SIGKILL')
      await ownerExit
      await until(async () => !await running(parentPid) && !await running(descendantPid), 5000)
      assert(Date.now() - killedAt < 5000, 'Cleanup must not wait for the original deadline')
      await until(async () => (await journal.reconcile(request)).outcome === 'known', 5000)
      const result = await journal.reconcile(request)
      assert.equal(result.outcome, 'known', errors)
      const terminal = result.events.at(-1)!
      assert('receipt' in terminal)
      assert.equal(terminal.receipt.reason?.code, 'execution-interrupted')
      const effects = await readFile(join(root, 'effects.txt'), 'utf8')
      await delay(300)
      assert.equal(await readFile(join(root, 'effects.txt'), 'utf8'), effects)
      assert.equal(await readFile(join(root, 'starts.txt'), 'utf8'), 'start\n')
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
      await ownerExit
      // Even a failing assertion must allow the independently bounded guardian to finish.
      try { await until(async () => (await journal.reconcile(request)).outcome === 'known', 18000) }
      catch (error) {
        throw new Error(`Guardian evidence missing. Owner stderr: ${errors}; files: ${JSON.stringify(await readdir(root, { recursive: true }))}`, { cause: error })
      }
    }
  })
})

test('guardian preserves shell argument quoting and cleans descendants after normal foreground completion', { timeout: 15_000 }, async () => {
  await withTempWorkspace(async root => {
    await writeFile(join(root, 'quoted command.cjs'), `
const cp = require('node:child_process');
console.log(JSON.stringify(process.argv.slice(2)));
cp.spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync('leaked.txt', 'leaked'), 2000)"], {stdio:'ignore'}).unref();
`)
    const manager = new ProcessManager()
    const process = await manager.spawn(`"${globalThis.process.execPath}" "quoted command.cjs" "one two" "hello"`, root,
      undefined, undefined, [], { isolated: true, supervision: { deadlineAt: Date.now() + 10000 } })
    const result = await process.exitPromise
    assert.equal(result.success, true, result.guardian?.error)
    assert.deepEqual(JSON.parse(Buffer.concat(process.stdoutChunks).toString()), ['one two', 'hello'])
    await delay(2300)
    assert.equal(await readOptional(join(root, 'leaked.txt')), '')
    manager.remove(process.pid)
  })
})

describe('supervision layer failures', () => {
  for (const fault of ['guardian', 'guardian-and-owner', 'posix-controller'] as const) {
    test(`${fault} loss stops finite descendants without replay`, {
      timeout: 25_000, skip: fault === 'posix-controller' && process.platform === 'win32',
    }, async () => {
      await withTempWorkspace(async root => {
        await writeFile(join(root, 'command with spaces.cjs'), `
  const fs=require('node:fs'),cp=require('node:child_process');
  if(process.argv[2]==='worker'){
    fs.writeFileSync('descendant.pid',String(process.pid));
    const timer=setInterval(()=>fs.appendFileSync('effects.txt','effect\\n'),30);
    setTimeout(()=>{clearInterval(timer);fs.writeFileSync('natural.txt','finished')},7000);
  }else{
    fs.appendFileSync('starts.txt','start\\n');
    fs.writeFileSync('command.pid',String(process.pid));
    cp.spawn(process.execPath,[__filename,'worker'],{stdio:'ignore'});
  }
  `)
        const id = crypto.randomUUID()
        const owner = spawn(process.execPath, ['--import', import.meta.resolve('tsx'),
          fileURLToPath(new URL('../../testing/shell-owner-fixture.ts', import.meta.url)), root, id, '15000'],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
        const ownerExit = new Promise<void>(resolve => owner.once('close', () => resolve()))
        let guardian: { pid: number; commandPid: number } | undefined
        let errors = ''
        owner.stderr!.on('data', chunk => { errors += chunk.toString() })
        owner.on('message', value => {
          if (value && typeof value === 'object' && 'type' in value && value.type === 'guardian'
            && 'pid' in value && typeof value.pid === 'number'
            && 'commandPid' in value && typeof value.commandPid === 'number') {
            guardian = { pid: value.pid, commandPid: value.commandPid }
          }
        })
        const journal = new ShellJournal(join(root, 'journal'))
        const request = {
          version: 1 as const, jobId: id, idempotencyKey: id, sessionId: 'session', turnId: 'turn',
          nodeId: 'child', capabilityId: 'root', operation: DURABLE_SHELL_OPERATION,
          args: { script: `"${process.execPath}" "command with spaces.cjs"` },
          createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 15000).toISOString(),
        }
        let pids: number[] = []
        try {
          await until(async () => !!guardian && (await readOptional(join(root, 'effects.txt'))).length > 20)
          pids = await Promise.all(['command.pid', 'descendant.pid'].map(async name =>
            Number(await readFile(join(root, name), 'utf8'))))
          if (fault === 'posix-controller') {
            const { stdout } = await promisify(execFile)('ps', ['-o', 'ppid=', '-p', String(guardian!.commandPid)])
            const controllerPid = Number(stdout.trim())
            assert.ok(Number.isSafeInteger(controllerPid) && controllerPid > 1)
            const command = await promisify(execFile)('ps', ['-o', 'command=', '-p', String(controllerPid)])
            assert.match(command.stdout, /posix-controller\.ts/)
            process.kill(controllerPid, 'SIGKILL')
          } else {
            process.kill(guardian!.pid, 'SIGKILL')
            if (fault === 'guardian-and-owner') owner.kill('SIGKILL')
          }
          await until(async () => (await Promise.all(pids.map(running))).every(alive => !alive), 4000)
          assert.equal(await readOptional(join(root, 'natural.txt')), '', errors)
          const effects = await readFile(join(root, 'effects.txt'), 'utf8')
          await delay(250)
          assert.equal(await readFile(join(root, 'effects.txt'), 'utf8'), effects)
          if (process.platform !== 'win32' && fault !== 'posix-controller') {
            await until(async () => {
              const result = await journal.reconcile(request)
              const terminal = result.outcome === 'known' ? result.events.at(-1) : undefined
              return !!terminal && 'receipt' in terminal && terminal.receipt.reason?.code === 'execution-interrupted'
            }, 4000)
          } else {
            const result = await journal.reconcile(request)
            if (result.outcome === 'known') {
              const terminal = result.events.at(-1)!
              assert.ok('receipt' in terminal && isUnknownShellReceipt(terminal.receipt))
            }
          }
          assert.equal(await readFile(join(root, 'starts.txt'), 'utf8'), 'start\n')
        } finally {
          if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
          await ownerExit
          await until(async () => (await Promise.all(pids.map(running))).every(alive => !alive), 9000)
        }
      })
    })
  }

  test('POSIX admission gate prevents execution if its controller dies before acknowledgement', {
    timeout: 12_000, skip: process.platform === 'win32',
  }, async () => {
    await withTempWorkspace(async root => {
      const controller = spawn(process.execPath, ['--import', import.meta.resolve('tsx'),
        fileURLToPath(new URL('./posix-controller.ts', import.meta.url))],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], detached: true })
      const exit = new Promise<void>(resolve => controller.once('close', () => resolve()))
      let pid: number | undefined
      controller.on('message', value => {
        if (value && typeof value === 'object' && 'type' in value && value.type === 'started'
          && 'pid' in value && typeof value.pid === 'number') pid = value.pid
      })
      try {
        controller.send({ type: 'start', request: {
          command: '/bin/sh', args: ['-c', 'echo unexpected > effect.txt'], cwd: root,
          env: process.env, windowsVerbatimArguments: false, deadlineAt: Date.now() + 5000,
        } })
        await until(async () => !!pid, 5000)
        controller.kill('SIGKILL')
        await exit
        await until(async () => !await running(pid!), 3000)
        assert.equal(await readOptional(join(root, 'effect.txt')), '')
      } finally {
        if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL')
        await exit
      }
    })
  })
})
