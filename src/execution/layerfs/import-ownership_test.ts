import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectInactiveImportWorker } from './import-ownership.ts'
import type { BootstrapCommand, BootstrapReceipt, BootstrapRun } from './bootstrap-command.ts'
import { ToolOutcomeUnknownError } from '../../tools/tool.ts'

const secret = 'fixture-endpoint-secret-DO-NOT-SURFACE'
const receipt = (stdout: string | Buffer, code = 0, stderr = ''): BootstrapReceipt => ({ code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: Buffer.from(stderr) })
const stopped = () => [receipt('0'), receipt('FixtureWSL\r\n'), receipt(''), receipt('0')]
const running = () => [receipt('0'), receipt('FixtureWSL\r\n'), receipt('FixtureWSL\r\n'), receipt('{"workers":0,"incomplete":false}\n'), receipt('0')]
function fixture(receipts: BootstrapReceipt[], change?: (index: number) => void) {
  const calls: BootstrapCommand[] = []
  const run: BootstrapRun = async (command, signal) => {
    assert.equal(signal.aborted, false)
    calls.push(command)
    assertReadOnly(command)
    change?.(calls.length - 1)
    const result = receipts[calls.length - 1]
    assert.ok(result, 'No additional commands or retries allowed')
    return result
  }
  return { calls, run }
}
function assertReadOnly(command: BootstrapCommand) {
  assert.equal(command.input, undefined)
  assert.equal(command.timeoutMs, 30000)
  assert.doesNotMatch(JSON.stringify(command), /Stop-Process|Remove-Item|\bkill\b|--terminate|--shutdown|LayerFSRuntime\.open|endpoint\.json|os\.system|subprocess|\.write\(/i)
  if (command.file === 'powershell.exe') {
    assert.deepEqual(command.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
    assert.match(command.args[3], /Get-CimInstance Win32_Process/)
    assert.match(command.args[3], /IsNullOrWhiteSpace/)
    assert.match(command.args[3], /\[Console\]::Write\(\$busy.Count\)/)
    assert.doesNotMatch(command.args[3], /--input-type=module/, 'All managed helper candidates, not only one launcher form')
  } else {
    assert.equal(command.file, 'wsl.exe')
    if (command.args[0] === '--list') {
      assert.ok(JSON.stringify(command.args) === JSON.stringify(['--list', '--quiet']) || JSON.stringify(command.args) === JSON.stringify(['--list', '--running', '--quiet']))
    } else {
      assert.deepEqual(command.args.slice(0, -1), ['--distribution', 'FixtureWSL', '--user', 'root', '--exec', 'python3', '-I', '-B', '-c'])
      const script = command.args.at(-1)!
      assert.match(script, /needle = b'api\/runtime\/' \+ b'src\/worker\/' \+ b'server.js'/)
      assert.ok(!script.includes('api/runtime/src/worker/server.js'), 'Census must not match itself or its launcher')
      assert.match(script, /open\('\/proc\/' \+ pid \+ '\/cmdline', 'rb'\)/)
      assert.match(script, /except FileNotFoundError:\s+pass/)
      assert.match(script, /except Exception:\s+incomplete = True/)
      assert.match(script, /len\(data\) > 1048576/)
      assert.match(script, /data.endswith\(b'\\0'\)/)
      assert.match(script, /len\(pids\) > 32768/)
      assert.match(script, /time.monotonic\(\) - started > 10/)
      assert.equal((script.match(/print\(/g) ?? []).length, 1, 'Only sanitized census JSON is printed')
    }
  }
}
const signal = () => new AbortController().signal
const unknown = (error: unknown) => {
  assert.ok(error instanceof ToolOutcomeUnknownError)
  assert.ok(!JSON.stringify(error).includes(secret))
  assert.ok(!String(error).includes(secret))
  assert.equal((error as Error).cause, undefined)
  return true
}

test('stopped distribution proves inactivity without WSL exec, and rechecks host helpers', async () => {
  const f = fixture(stopped())
  assert.deepEqual(await inspectInactiveImportWorker('FixtureWSL', signal(), f.run), { ownership: 'inactive', evidence: 'stopped_distribution' })
  assert.deepEqual(f.calls.map(c => c.file), ['powershell.exe', 'wsl.exe', 'wsl.exe', 'powershell.exe'])
})

test('running distribution uses a bounded root census then rechecks host helpers', async () => {
  const f = fixture(running())
  assert.deepEqual(await inspectInactiveImportWorker('FixtureWSL', signal(), f.run), { ownership: 'inactive', evidence: 'no_layerfs_worker_process' })
  assert.equal(f.calls.length, 5)
})

test('UTF-16LE WSL inventories and case-insensitive membership are accepted', async () => {
  const rows = stopped()
  rows[1] = receipt(Buffer.from('\uFEFFfixturewsl\r\nOtherWSL\r\n', 'utf16le'))
  rows[2] = receipt(Buffer.from('otherwsl\r\n', 'utf16le'))
  const f = fixture(rows)
  assert.equal((await inspectInactiveImportWorker('FixtureWSL', signal(), f.run)).evidence, 'stopped_distribution')
})

for (const [label, output] of [
  ['active worker', '{"workers":1,"incomplete":false}'],
  ['permission or unreadable census', '{"workers":0,"incomplete":true}'],
  ['malformed JSON', secret], ['extra property', '{"workers":0,"incomplete":false,"secret":"' + secret + '"}'],
  ['duplicate key', '{"workers":1,"workers":0,"incomplete":false}'],
  ['negative count', '{"workers":-1,"incomplete":false}'], ['coerced count', '{"workers":"0","incomplete":false}'],
  ['missing field', '{"workers":0}'], ['extra output', '{"workers":0,"incomplete":false}\n' + secret],
  ['truncated output', '{"workers":0,"incomplete":'], ['overflow count', '{"workers":999999999999999999999999,"incomplete":false}'],
] as const) test(`refuses ${label} without disclosing census output`, async () => {
  const rows = running(); rows[3] = receipt(output)
  const f = fixture(rows)
  await assert.rejects(inspectInactiveImportWorker('FixtureWSL', signal(), f.run), unknown)
  assert.equal(f.calls.length, 4)
})

test('retained or unreadable host helpers refuse both before and after Linux inspection', async () => {
  for (const index of [0, 4]) for (const bad of [receipt('1'), receipt(''), receipt(secret), receipt('0\n'), receipt('0', 1), receipt('0', 0, secret)]) {
    const rows = running(); rows[index] = bad
    const f = fixture(rows)
    await assert.rejects(inspectInactiveImportWorker('FixtureWSL', signal(), f.run), unknown)
    assert.equal(f.calls.length, index + 1)
  }
})

test('malformed, incomplete and inconsistent WSL inventories never prove absence', async () => {
  for (const index of [1, 2]) for (const bad of [
    receipt('Inventory failed!\n'), receipt('FixtureWSL'), receipt('FixtureWSL\n\n'), receipt('FixtureWSL\nfixturewsl\n'),
    receipt('FixtureWSL\u0000\n'), receipt(Buffer.from([0xff, 0x0a])), receipt(Buffer.from([0xff, 0xfe, 0x41])),
    receipt('FixtureWSL\n', 1), receipt('FixtureWSL\n', 0, secret),
    receipt(Buffer.from('x'.repeat(65536 - 11) + 'FixtureWSL\n')),
  ]) {
    const rows = stopped(); rows[index] = bad
    await assert.rejects(inspectInactiveImportWorker('FixtureWSL', signal(), fixture(rows).run), unknown)
  }
  for (const [all, live] of [['', ''], ['OtherWSL\n', ''], ['FixtureWSL\n', 'UnknownWSL\n']]) {
    const rows = stopped(); rows[1] = receipt(all); rows[2] = receipt(live)
    await assert.rejects(inspectInactiveImportWorker('FixtureWSL', signal(), fixture(rows).run), unknown)
  }
})

test('nonzero, stderr, unsuccessful diagnostics and thrown failures are sanitized at every step', async () => {
  for (let index = 0; index < 5; index++) {
    for (const kind of ['nonzero', 'stderr', 'diagnostic', 'throw']) {
      const rows = running()
      if (kind === 'nonzero') rows[index].code = 1
      if (kind === 'stderr') rows[index].stderr = Buffer.from(secret)
      if (kind === 'diagnostic') rows[index].diagnostic = { reason: 'timeout', timeoutMs: 30000, elapsedMs: 30000, exitCode: 0, signal: null, launcherExited: true }
      const f = fixture(rows, n => { if (kind === 'throw' && n === index) throw new Error(secret) })
      await assert.rejects(inspectInactiveImportWorker('FixtureWSL', signal(), f.run), unknown)
      assert.equal(f.calls.length, index + 1)
    }
  }
})

test('aborted inspection never proceeds to another command or returns inactive', async () => {
  for (const abortAt of [-1, 0, 1, 2, 3, 4]) {
    const controller = new AbortController()
    if (abortAt === -1) controller.abort(secret)
    const f = fixture(running(), n => { if (n === abortAt) controller.abort(secret) })
    await assert.rejects(inspectInactiveImportWorker('FixtureWSL', controller.signal, f.run), error => {
      assert.ok(error instanceof DOMException && error.name === 'AbortError')
      assert.ok(!String(error).includes(secret))
      return true
    })
    assert.equal(f.calls.length, abortAt + 1)
  }
})

test('invalid distribution argv refuses before any command', async () => {
  for (const name of ['', '--root', 'a b', 'a\n', '../a', 'a;id', 'a'.repeat(129), secret + '\u0000']) {
    const f = fixture([])
    await assert.rejects(inspectInactiveImportWorker(name, signal(), f.run), unknown)
    assert.equal(f.calls.length, 0)
  }
})
