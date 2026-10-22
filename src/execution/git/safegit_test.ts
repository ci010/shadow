import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { SAFEGIT_VERSION, safegitTarget, requestedSafegitBinary, SafegitRunner } from './safegit.ts'
import { SafegitTool } from '../../tools/safegit.ts'
import type { ExecutionContext } from '../../tools/context.ts'

test('pinned targets include native Windows x64; no fallback even with override', async () => {
  assert.equal(safegitTarget('win32', 'x64'), 'windows_amd64')
  assert.equal(safegitTarget('win32', 'arm64'), undefined)
  assert.equal(safegitTarget('linux', 'x64'), 'linux_amd64')
  assert.equal(safegitTarget('darwin', 'arm64'), 'darwin_arm64')
  assert.equal(safegitTarget('linux', 'ia32'), undefined)
  const runner = new SafegitRunner(() => { throw new Error('must not resolve') }, () => undefined)
  assert.equal((await runner.status()).supported, false)
  await assert.rejects(runner.run(['commit'], resolve('.'), new AbortController().signal), /No git or WSL fallback/)
})

test('resolver covers source, dev dist, relocated installed bundle and explicit absolute override', () => {
  const root = resolve('.')
  for (const file of ['src/execution/git/safegit.ts', 'dist/src/execution/git/safegit.js']) {
    assert.equal(requestedSafegitBinary(pathToFileURL(join(root, file)).href, ''), join(root, 'desktop/safegit', process.platform === 'win32' ? 'safegit.exe' : 'safegit'))
  }
  const resources = resolve('relocated/resources')
  assert.equal(requestedSafegitBinary(pathToFileURL(join(resources, 'backend/dist/src/execution/git/safegit.js')).href, ''), join(resources, 'safegit', process.platform === 'win32' ? 'safegit.exe' : 'safegit'))
  assert.equal(requestedSafegitBinary(import.meta.url, resolve('custom')), resolve('custom'))
  assert.throws(() => requestedSafegitBinary(import.meta.url, 'relative'), /absolute/)
})

test('run preserves literal argv, cwd, abort, refusal exit code; version mismatch fails closed', async () => {
  const scratch = await mkdtemp(resolve('.tmp/safegit-test-'))
  const binary = join(scratch, 'safegit')
  await writeFile(binary, 'fixture')
  const calls: unknown[][] = []
  const execute = (async (...args: unknown[]) => {
    calls.push(args)
    if ((args[1] as string[])[0] === '--version') return { stdout: 'safegit 0.33.0-windows.1\n', stderr: '' }
    throw Object.assign(new Error('refused'), { code: 20, stdout: '', stderr: 'approval required' })
  }) as never
  try {
    const runner = new SafegitRunner(() => binary, () => 'linux_amd64', execute)
    const signal = new AbortController().signal
    const args = ['commit', '-m', 'literal $(echo nope)', '--', 'file with spaces']
    assert.deepEqual(await runner.run(args, scratch, signal), { exitCode: 20, stdout: '', stderr: 'approval required' })
    assert.deepEqual(calls[1]?.[1], args)
    assert.equal((calls[1]?.[2] as { cwd: string }).cwd, scratch)
    assert.equal((calls[1]?.[2] as { signal: AbortSignal }).signal, signal)
    const bad = new SafegitRunner(() => binary, () => 'linux_amd64', (async () => ({ stdout: 'safegit 0.32.0', stderr: '' })) as never)
    await assert.rejects(bad.run(['push'], scratch, signal), /Expected safegit/)
    await assert.rejects(runner.run(['push'], scratch, AbortSignal.abort()), /abort/i)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('tool validates project/locality/schema and does not accept arbitrary cwd', async () => {
  let called = false
  const runner = { status: async () => ({ supported: false }), run: async () => { called = true; return {} } } as unknown as SafegitRunner
  const tool = new SafegitTool(runner, 'p')
  const context = { projectId: 'p', cwd: resolve('.'), signal: new AbortController().signal } as ExecutionContext
  assert.equal(JSON.parse(await tool.execute({ action: 'status' }, context)).supported, false)
  await assert.rejects(tool.execute({ action: 'status' }, { ...context, projectId: 'other' }), /owning Project/)
  await assert.rejects(tool.execute({ action: 'run', args: ['push'] }, { ...context, remoteWorkdir: {} } as ExecutionContext), /local workdir/)
  await assert.rejects(tool.execute({ action: 'run', args: ['push'], cwd: '/' }, context))
  assert.equal(called, false)
  await tool.execute({ action: 'run', args: ['push', '--refs', 'head'] }, context)
  assert.equal(called, true)
})
