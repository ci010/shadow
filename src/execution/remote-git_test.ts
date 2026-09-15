import assert from 'node:assert/strict'
import childProcess, { execFile, type SpawnOptions } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { devNull } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import test from 'node:test'
import { ProcessManager } from '../agent/process-manager.ts'
import { projectFixture } from '../projects/test-fixtures.ts'
import { CapabilityGit, GIT_STATUS_OPERATION, GIT_DIFF_OPERATION, MAX_GIT_RESULT_BYTES } from './capability-git.ts'
import { LocalExecutor } from './local-executor.ts'
import { InMemoryLocalApprovalService } from './local-approval.ts'
import { executeRemoteGit } from './remote-git-client.ts'
import type { Executor } from './executor.ts'
import type { JobRequestV1, JobEventV1 } from './contracts.ts'

const exec = promisify(execFile)
const signal = () => new AbortController().signal
function target(executor: Executor) {
  return { executor, nodeId: 'child', capabilityId: 'workdir', sessionId: 'remote-session', turnId: 'git-test', signal: signal() }
}
function fake(output: string, completed = true) {
  const requests: JobRequestV1[] = []
  const executor: Executor = {
    async *execute(request) {
      requests.push(request)
      const timestamp = new Date().toISOString()
      yield { version: 1, jobId: request.jobId, sequence: 0, timestamp, type: 'stdout', chunk: output }
      if (completed) yield { version: 1, jobId: request.jobId, sequence: 1, timestamp, type: 'completed',
        receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'completed', finishedAt: timestamp } }
    },
    getStatus: async () => null,
    cancel: async () => { throw new Error('Unused') },
  }
  return { executor, requests }
}

test('remote Git uses the Child workdir for status and HEAD diff, with no prompts or Git mutation', async t => {
  const { root, folders } = await projectFixture(t)
  const git = (...args: string[]) => exec('git', ['-c', 'core.autocrlf=false', '-c', `core.hooksPath=${devNull}`,
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-C', folders, ...args])
  await git('init', '--quiet')
  await mkdir(join(folders, 'inside'))
  await writeFile(join(folders, 'outside.txt'), 'outside\n')
  await writeFile(join(folders, 'inside', 'file.txt'), 'before\n')
  await git('add', '--all')
  await git('commit', '--quiet', '-m', 'fixture')
  await writeFile(join(folders, 'inside', 'file.txt'), 'staged\n')
  await git('add', '--all')
  await writeFile(join(folders, 'inside', 'file.txt'), 'after\n')
  await writeFile(join(folders, 'outside.txt'), 'do not expose\n')
  const index = await readFile(join(folders, '.git', 'index'))
  const approval = new InMemoryLocalApprovalService([{ capabilityId: 'workdir', displayName: 'Child', policy: 'none' }])
  const local = new LocalExecutor(new ProcessManager(), 'child', [new CapabilityGit([{ capabilityId: 'workdir', rootPath: join(folders, 'inside') }])], [], approval)
  const requests: JobRequestV1[] = []
  const executor: Executor = {
    execute(request, signal) { requests.push(request); return local.execute(request, signal) },
    getStatus: id => local.getStatus(id), cancel: id => local.cancel(id),
  }
  const status = await executeRemoteGit(target(executor), 'status')
  assert.deepEqual(status, { status: 200, body: { available: true, entries: [{ path: 'file.txt', status: 'modified' }] } })
  const diff = await executeRemoteGit(target(executor), 'diff', 'file.txt')
  assert.equal(diff.status, 200)
  assert('hunks' in diff.body)
  assert(diff.body.hunks.some(hunk => hunk.lines.includes('-before') && hunk.lines.includes('+after')))
  assert.equal(diff.body.oldContent, 'before\n')
  assert.equal(diff.body.newContent, 'after\n')
  assert(!JSON.stringify(requests).includes(root))
  assert.deepEqual(requests.map(request => [request.nodeId, request.capabilityId, request.operation, request.args]),
    [['child', 'workdir', GIT_STATUS_OPERATION, {}], ['child', 'workdir', GIT_DIFF_OPERATION, { path: 'file.txt' }]])
  assert.deepEqual(approval.listPending(), [])
  assert.deepEqual(await readFile(join(folders, '.git', 'index')), index)
  assert.equal((await executeRemoteGit(target(executor), 'diff', 'missing.txt')).status, 404)
})

test('remote Git reports non-repositories, invalid arguments and unknown bindings explicitly', async t => {
  const { root, folders } = await projectFixture(t)
  const spawn = childProcess.spawn
  t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: SpawnOptions) =>
    spawn(command, args, { ...options, env: { ...options.env, GIT_CEILING_DIRECTORIES: root } }))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const handler = new CapabilityGit([{ capabilityId: 'workdir', rootPath: folders }])
  const local = new LocalExecutor(new ProcessManager(), 'child', [handler])
  assert.deepEqual(await executeRemoteGit(target(local), 'status'), { status: 200, body: { available: false, reason: 'not_repository', entries: [] } })
  assert.equal((await executeRemoteGit(target(local), 'diff', 'file.txt')).status, 409)
  for (const path of ['../outside', '/etc/passwd', 'C:\\Main', '.git/config', 'x\0y']) {
    const fixture = fake('')
    assert.equal((await executeRemoteGit(target(fixture.executor), 'diff', path)).status, 400)
    assert.equal(fixture.requests.length, 0)
  }
  assert.equal((await executeRemoteGit({ ...target(local), capabilityId: 'unknown' }, 'status')).status, 503)
  const captured = fake('{}')
  await assert.rejects(executeRemoteGit(target(captured.executor), 'status'))
  const request = captured.requests[0]!
  for (const args of [{ cwd: '/main' }, { script: 'git status' }, { path: '../outside' }]) {
    const response = JSON.parse(await handler.execute({ ...request, args }, signal()))
    assert.equal(response.status, 400)
  }
  await writeFile(join(folders, '.git'), 'gitdir: missing-repository\n')
  const broken = await executeRemoteGit(target(local), 'status')
  assert.equal(broken.status, 500)
  assert('error' in broken.body && broken.body.error === 'git_failed')
  assert.match(broken.body.message, /\[Git rev-parse; stage=exit; exit=128; cause=invalid_repository\]/)
  assert(!broken.body.message.includes(root), 'Remote Git diagnostics must not expose device paths')
})

test('remote Git rejects malformed, oversized, incomplete and cross-file results without falling back', async () => {
  const body = { path: 'file.txt', status: 'modified', base: 'HEAD', binary: false, truncated: false, hunks: [] }
  for (const output of ['not json', '{}', JSON.stringify({ status: 200, body: { ...body, path: 'other.txt' } }),
    JSON.stringify({ status: 200, body: { ...body, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+bad'] }] } }),
    'x'.repeat(MAX_GIT_RESULT_BYTES + 1)]) {
    const fixture = fake(output)
    await assert.rejects(executeRemoteGit(target(fixture.executor), 'diff', 'file.txt'))
    assert.equal(fixture.requests.length, 1)
  }
  assert.equal((await executeRemoteGit(target(fake('', false).executor), 'status')).status, 503)
  assert.deepEqual(await executeRemoteGit(target(fake(JSON.stringify({ status: 504, body: { error: 'git_timeout', message: 'Timed out' } })).executor), 'status'),
    { status: 504, body: { error: 'git_timeout', message: 'Timed out' } })
  const result = await executeRemoteGit(target(fake(JSON.stringify({ status: 200, body: { ...body, sourcePath: 'C:\\Main\\wrong.txt' } })).executor), 'diff', 'file.txt')
  assert(!('sourcePath' in result.body))
})

test('large Git responses are split into bounded job frames and reconstruct exactly', async () => {
  const body = { path: 'file.txt', status: 'modified', base: 'HEAD', binary: false, truncated: false, hunks: [], oldContent: 'x'.repeat(260_000), newContent: 'y'.repeat(260_000) }
  const output = JSON.stringify({ status: 200, body })
  const frames: JobEventV1[] = []
  const local = new LocalExecutor(new ProcessManager(), 'child', [{ handles: () => true, execute: async () => output }])
  const executor: Executor = {
    async *execute(request, signal) {
      for await (const event of local.execute(request, signal)) { frames.push(event); yield event }
    },
    getStatus: id => local.getStatus(id), cancel: id => local.cancel(id),
  }
  const result = await executeRemoteGit(target(executor), 'diff', 'file.txt')
  assert.deepEqual(result, { status: 200, body })
  assert(frames.filter(event => event.type === 'stdout').length > 1)
  assert(frames.every(event => Buffer.byteLength(JSON.stringify(event)) < 64 * 1024))
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(executeRemoteGit({ ...target(executor), signal: aborted.signal }, 'status'), { name: 'AbortError' })
})
