import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SafegitRunner } from '../execution/git/safegit.ts'
import { isolationGit, prepareWorktree } from './work-isolation.ts'

const signal = () => new AbortController().signal

test('real Git worktree starts at committed HEAD, not dirty index/files, and retains independent branch commits', async () => withTempWorkspace(async home => {
  const source = join(home, 'source'), data = join(home, 'project')
  await mkdir(source)
  await mkdir(data)
  await isolationGit(source, ['init'], signal())
  await isolationGit(source, ['config', 'user.name', 'Synthetic Work Test'], signal())
  await isolationGit(source, ['config', 'user.email', 'work-test@example.invalid'], signal())
  await writeFile(join(source, 'tracked.txt'), 'committed\n')
  const safe = new SafegitRunner()
  const commit = await safe.run(['commit', '-m', 'Synthetic baseline', '--', 'tracked.txt'], source, signal())
  assert.equal(commit.exitCode, 0, commit.stderr)
  const base = await isolationGit(source, ['rev-parse', 'HEAD'], signal())
  await writeFile(join(source, 'tracked.txt'), 'user staged\n')
  await isolationGit(source, ['add', 'tracked.txt'], signal())
  await writeFile(join(source, 'tracked.txt'), 'user unstaged\n')
  await writeFile(join(source, 'untracked.txt'), 'private untracked content\n')
  const before = await isolationGit(source, ['status', '--porcelain=v1'], signal())
  const originalIndex = await readFile(join(source, '.git', 'index'))
  const isolated = await prepareWorktree(data, 'project-a', source, 'worker-a', signal())
  assert.equal(await readFile(join(isolated.path, 'tracked.txt'), 'utf8'), 'committed\n')
  await assert.rejects(readFile(join(isolated.path, 'untracked.txt')), /ENOENT/)
  assert.equal(await isolationGit(isolated.path, ['rev-parse', 'HEAD'], signal()), base)
  assert.equal(await isolationGit(isolated.path, ['status', '--porcelain=v1'], signal()), '')
  await writeFile(join(isolated.path, 'result.txt'), 'agent result\n')
  const delivery = await safe.run(['commit', '-m', 'Synthetic isolated delivery', '--', 'result.txt'], isolated.path, signal())
  assert.equal(delivery.exitCode, 0, delivery.stderr)
  assert.equal(await isolationGit(isolated.path, ['show', `${isolated.branch}:tracked.txt`], signal()), 'committed')
  assert.equal(await isolationGit(isolated.path, ['show', `${isolated.branch}:result.txt`], signal()), 'agent result')
  assert.equal(await isolationGit(source, ['rev-parse', 'HEAD'], signal()), base)
  assert.deepEqual(await readFile(join(source, '.git', 'index')), originalIndex)
  assert.equal(await isolationGit(source, ['status', '--porcelain=v1'], signal()), before)
  assert.deepEqual(await prepareWorktree(data, 'project-a', source, 'worker-a', signal()), isolated)
  const other = await prepareWorktree(data, 'project-b', source, 'worker-a', signal())
  assert.notEqual(other.branch, isolated.branch)
  assert.notEqual(other.path, isolated.path)
  await assert.rejects(prepareWorktree(data, 'project-a', source, 'missing-executor', signal(), true), /missing; refusing to recreate/)
  const nested = join(source, '..inside-source')
  await mkdir(nested)
  await assert.rejects(prepareWorktree(nested, 'project-a', source, 'nested', signal()), /must not be nested/)
  await assert.rejects(prepareWorktree(data, 'project-a', nested, 'subdirectory', signal()), /repository root/)
  await isolationGit(isolated.path, ['switch', '-c', 'unexpected-branch'], signal())
  await assert.rejects(prepareWorktree(data, 'project-a', source, 'worker-a', signal(), true), /identity does not match/)
}))

test('nonrepositories, subdirectories and conflicting retained paths fail closed', async () => withTempWorkspace(async home => {
  await assert.rejects(prepareWorktree(join(home, 'project'), 'p', home, 'id', signal()), /git|repository/)
  await mkdir(join(home, 'nested'))
  // No fallback or implicit initialization of the selected source.
  await assert.rejects(readFile(join(home, '.git', 'HEAD')), /ENOENT/)
  await assert.rejects(prepareWorktree(join(home, 'project'), 'p', join(home, 'nested'), 'id', AbortSignal.abort()), /abort/i)
}))
