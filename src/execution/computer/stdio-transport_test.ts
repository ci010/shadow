import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { DesktopStdioTransport } from './stdio-transport.ts'
import { ComputerError } from './contracts.ts'

test('native input guards, coordinates, key pairing and cancellation use a fake desktop without SendInput', {
  skip: process.platform !== 'win32', timeout: 20_000,
}, async () => {
  const source = fileURLToPath(new URL('./windows-input.cs', import.meta.url))
  const fixture = fileURLToPath(new URL('./testing/input.cs', import.meta.url))
  const quote = (path: string) => `'${path.replaceAll("'", "''")}'`
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(source)}) + [Environment]::NewLine + [IO.File]::ReadAllText(${quote(fixture)})) -ReferencedAssemblies @('System','System.Core','System.Web.Extensions'); [Shadow.InputFixture]::Run()`
  const { stdout } = await promisify(execFile)(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    // A stale MSVC LIB path must not become a C# compiler error in this fake-only test.
    { windowsHide: true, timeout: 15_000, env: { ...process.env, LIB: '', LIBPATH: '' } },
  )
  assert.ok(Number(stdout.trim()) >= 40, 'Native fake-input assertions must execute, not only compile')
})

test('private stdio host serializes requests, rejects concurrent input and aborts uncertain effects', async t => {
  const desktop = new DesktopStdioTransport({
    spawnHost: () => spawn(process.execPath, ['-e', `
      const rl = require('node:readline').createInterface({input:process.stdin});
      rl.on('line', line => { const q=JSON.parse(line); if(q.method === 'act') return;
        setTimeout(() => process.stdout.write(JSON.stringify({id:q.id,result:{ok:true}})+'\\n'), 30); });
    `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  })
  t.after(() => desktop.interrupt())
  const read = desktop.request({ method: 'list' }, new AbortController().signal)
  await assert.rejects(desktop.request({ method: 'list' }, new AbortController().signal), /in progress/)
  assert.deepEqual(await read, { ok: true })
  const controller = new AbortController()
  const action = desktop.request({
    method: 'act', targetId: crypto.randomUUID(), observationId: crypto.randomUUID(),
    actionId: crypto.randomUUID(), action: { kind: 'invoke', elementId: '0' },
  }, controller.signal)
  const rejected = assert.rejects(action, error => error instanceof ComputerError && error.code === 'outcome_unknown')
  controller.abort()
  await rejected
  await desktop.interrupt()
  assert.ok(desktop.generation > 0)
})

test('malformed native replies terminate the host and never become tool data', async t => {
  const desktop = new DesktopStdioTransport({
    spawnHost: () => spawn(process.execPath, ['-e', "process.stdin.once('data',()=>process.stdout.write('PRIVATE INVALID RESPONSE\\n'))"], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    }),
  })
  t.after(() => desktop.interrupt())
  await assert.rejects(desktop.request({ method: 'list' }, new AbortController().signal), error =>
    error instanceof ComputerError && error.code === 'host_protocol' && !error.message.includes('PRIVATE'))
})


test('native diagnostic allowlist preserves only static codes, never provider content', async () => {
  const { nativeResponse, diagnosticReasons } = await import('./agent-desktop-errors.js')
  for (const reason of diagnosticReasons) {
    assert.deepEqual(nativeResponse.parse({ error: { code: 'observation_failed', reason } }),
      { error: { code: 'observation_failed', reason } })
  }
  for (const reason of ['private window title and value', 'uia_value_read: SECRET', null, undefined]) {
    assert.deepEqual(nativeResponse.parse({ error: { code: 'observation_failed', reason } }),
      { error: { code: 'observation_failed' } })
  }
  assert.equal(nativeResponse.safeParse({ error: { code: 'PRIVATE', reason: 'uia_value_read' } }).success, false)
})

test('UIA and desktop gate failures remain distinct across stdio without lock-screen assertions', async t => {
  for (const [code, reason] of [['observation_failed', 'uia_root_protected_or_unknown'], ['desktop_unavailable', 'desktop_open'], ['unavailable', undefined]]) {
    const desktop = new DesktopStdioTransport({ spawnHost: () => spawn(process.execPath, ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        process.stdout.write(JSON.stringify({id:JSON.parse(line).id,error:${JSON.stringify({code, reason})}})+'\\n');
      });
    `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) })
    t.after(() => desktop.interrupt())
    await assert.rejects(desktop.request({method:'observe',targetId:crypto.randomUUID(),screenshot:false},new AbortController().signal), error =>
      error instanceof ComputerError && error.code === code && !error.message.includes('An unlocked')
      && (!reason || error.message.includes(reason)))
    await desktop.interrupt()
  }
})


test('every restricted native UIA diagnostic is allowlisted end to end', async () => {
  const { readFile } = await import('node:fs/promises')
  const { diagnosticReasons } = await import('./agent-desktop-errors.js')
  const patch = await readFile(new URL('../../../integrations/agent-desktop/patches/shadow_observe.rs', import.meta.url), 'utf8')
  const native = await readFile(new URL('../../../integrations/agent-desktop/src/windows.rs', import.meta.url), 'utf8')
  const transport = await readFile(new URL('./stdio-transport.ts', import.meta.url), 'utf8')
  for (const [, reason] of patch.matchAll(/diagnostic\("([a-z_]+)"\)/g)) {
    assert.ok(diagnosticReasons.has(reason), reason)
    assert.ok(native.includes(`"${reason}" => "${reason}"`), reason)
    assert.ok(native.includes(`"reason":"${reason}"`), reason)
    assert.ok(transport.includes(`'${reason}'`), reason)
  }
  assert.match(native, /shadow_observe_window\([^\n]+\)\.map_err\(uia_error\)/)
})
