import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildInputGuard, prepareInputGuardSource } from './agent-desktop-input-guard.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
test('AOT guard reuses the existing monitor/lease, removes PowerShell, and adds independent cancellation', async () => {
  const input = await readFile(join(root, 'src/execution/computer/windows-input.cs'), 'utf8')
  const source = prepareInputGuardSource(input)
  assert.doesNotMatch(source, /ForegroundInputBridge|powershell\.exe|Add-Type/)
  for (const text of ['PhysicalInputMonitor', 'ReleaseHeld', 'owner.WaitForExit()', 'SHADOW_INPUT_CANCEL_EVENT', 'cancellationWatchdog', 'lease.RequireFocus', 'lease.Execute']) assert.ok(source.includes(text), text)
  assert.throws(() => prepareInputGuardSource('unrecognized source'), /Unexpected guard source/)
})

test('AOT guard core runs the existing fake-environment assertions without hooks, UIA or SendInput', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-input-guard-fixture-'))
  try {
    const exe = join(directory, 'fake-guard-tests.exe')
    const built = await buildInputGuard(root, exe, { fixture: true })
    assert.match(built.sha256, /^[a-f0-9]{64}$/)
    const { stdout } = await promisify(execFile)(exe, [], { windowsHide: true, timeout: 10000 })
    assert.ok(Number(stdout.trim()) >= 40, 'The existing fake input assertions must actually execute')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('real guard executable supports metadata-only identity without starting the input host', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-input-guard-identity-'))
  try {
    const exe = join(directory, 'guard.exe')
    const built = await buildInputGuard(root, exe)
    const { stdout } = await promisify(execFile)(exe, ['--identity'], { windowsHide: true, timeout: 10000 })
    assert.deepEqual(JSON.parse(stdout), { protocol: 1, backend: 'shadow-input-guard', sourceSha256: built.sourceSha256 })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('idle AOT guard exits on stdin EOF and owner death without beginning an input lease', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-input-guard-lifecycle-'))
  try {
    const exe = join(directory, 'guard.exe')
    await buildInputGuard(root, exe)
    for (const cause of ['eof', 'owner-death']) {
      // This owned helper has no application/window, only an event loop.
      const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true })
      assert.ok(owner.pid)
      const guard = spawn(exe, [String(owner.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      guard.stderr.resume()
      const closed = once(guard, 'exit', { signal: AbortSignal.timeout(5000) })
      const ownerClosed = once(owner, 'exit')
      try {
        const id = randomUUID()
        const ready = once(guard.stdout, 'data', { signal: AbortSignal.timeout(5000) })
        // cancel with no lease is metadata-only: never begin/execute, no hooks,
        // target reads, cursor movement, key state probes or SendInput.
        guard.stdin.write(JSON.stringify({ id, method: 'cancel', payload: {} }) + '\n')
        const [line] = await ready
        assert.deepEqual(JSON.parse(String(line)), { id, result: { cancelled: true } })
        if (cause === 'eof') guard.stdin.end()
        else owner.kill()
        const [exitCode] = await closed
        assert.equal(exitCode, 0, cause)
      } finally {
        if (guard.exitCode === null) guard.kill()
        if (owner.exitCode === null) owner.kill()
        await ownerClosed
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
