import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { availableExecShells } from '../processes/shells.ts'
import { localExecSafegitAliasEnv } from './safegit-alias.ts'
import { requestedSafegitBinary, SAFEGIT_VERSION } from './safegit.ts'
const exec = promisify(execFile)

function runAlias(env: NodeJS.ProcessEnv) {
  return process.platform === 'win32'
    ? exec('cmd.exe', ['/d', '/c', 'safegit --version'], { env: { ...process.env, ...env } })
    : exec('/bin/sh', ['-c', 'safegit --version'], { env: { ...process.env, ...env } })
}

test('native alias handles spaces, arbitrary override filename, reuse and changed binary', async t => {
  const source = requestedSafegitBinary(import.meta.url, '')
  try { await readFile(source) } catch { t.skip('native archive not prepared'); return }
  const root = await mkdtemp(resolve('.tmp/safegit alias spaces-'))
  try {
    const binary = join(root, 'custom binary' + (process.platform === 'win32' ? '.exe' : ''))
    await copyFile(source, binary); await chmod(binary, 0o755)
    const input = { SHADOW_SAFEGIT_PATH: binary, PATH: process.env.PATH ?? '' }
    const env = await localExecSafegitAliasEnv(input, root, {})
    assert.equal(env.SHADOW_SAFEGIT_ERROR, undefined)
    assert((await runAlias(env)).stdout.includes(SAFEGIT_VERSION))
    for (const shell of await availableExecShells()) {
      const args = shell.name === 'cmd' ? ['/d', '/c', 'safegit --version']
        : ['powershell', 'pwsh'].includes(shell.name) ? ['-NoProfile', '-Command', 'safegit --version; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }']
        : ['-c', 'safegit --version']
      const result = await exec(shell.command, args, { env: { ...process.env, ...env } })
      assert(result.stdout.includes(SAFEGIT_VERSION), shell.name)
    }
    const directory = env.PATH!.split(delimiter)[0]!
    const alias = join(directory, process.platform === 'win32' ? 'safegit.exe' : 'safegit')
    const before = (await stat(alias)).mtimeMs
    assert.deepEqual(await localExecSafegitAliasEnv(input, root, {}), env)
    assert.equal((await stat(alias)).mtimeMs, before)
    assert.equal(env.PATH!.slice(directory.length + 1), input.PATH)
    await writeFile(binary, 'corrupt replacement')
    const invalid = await localExecSafegitAliasEnv(input, root, {})
    assert(invalid.SHADOW_SAFEGIT_ERROR)
    assert.notEqual(invalid.PATH, env.PATH)
    await assert.rejects(runAlias(invalid))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('missing and invalid binaries block inherited same-name system executable; host PATH stays untouched', async () => {
  const root = await mkdtemp(resolve('.tmp/safegit-blocker-'))
  try {
    const system = join(root, 'system')
    await mkdir(system)
    const name = process.platform === 'win32' ? 'safegit.cmd' : 'safegit'
    await writeFile(join(system, name), process.platform === 'win32' ? '@echo SYSTEM_FALLBACK\r\n' : '#!/bin/sh\necho SYSTEM_FALLBACK\n', { mode: 0o755 })
    const host = { PATH: system }
    for (const binary of [undefined, '', 'relative', join(root, 'missing')]) {
      const env = await localExecSafegitAliasEnv(binary === undefined ? {} : { SHADOW_SAFEGIT_PATH: binary }, root, host)
      assert(env.SHADOW_SAFEGIT_ERROR)
      const result = await runAlias(env).then(value => value, error => error as { stdout?: string; code?: unknown })
      assert(!String(result.stdout).includes('SYSTEM_FALLBACK'))
      assert('code' in result, 'blocker must fail nonzero')
      assert.equal(host.PATH, system)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
