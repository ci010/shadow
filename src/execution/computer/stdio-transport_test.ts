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
