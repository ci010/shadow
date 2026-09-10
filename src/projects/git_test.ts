import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { hasOwnedProcessExited, runOwnedProcess, validateCloneUrl, validateDirectoryName } from './git.ts'
import { projectFixture } from './test-fixtures.ts'

test('clone URL and directory validators reject secrets, helpers, options, and unsafe names', () => {
  for (const value of [
    'https://example.com/org/repo.git',
    'ssh://git@example.com:2222/org/repo.git',
    'ssh://git@localhost/org/repo.git',
    'ssh://git@git-host.example.com./org/repo.git',
    'ssh://git@192.0.2.1/org/repo.git',
    'ssh://git@[2001:db8::1]:2222/org/repo.git',
    'git@example.com:org/repo.git',
    'git@192.0.2.1:org/repo.git',
    'git@[2001:db8::1]:org/repo.git',
    pathToFileURL(process.cwd()).href,
  ]) assert.equal(typeof validateCloneUrl(value), 'string')
  for (const value of [
    '--upload-pack=evil', 'ext::evil', 'http://example.com/repo',
    'https://username@example.com/repo', 'https://user:secret@example.com/repo',
    'https://example.com/repo?token=secret', 'https://example.com/repo#secret',
    'https://example.com/repo?', 'https://example.com/repo#',
    'git@example.com:repo;evil', 'ssh://git@example.com/repo%3Bevil',
    'ssh://git@-v/repo', 'ssh://git@-oProxyCommand=evil/repo',
    'ssh://git@bad_host/repo', 'ssh://git@host..example/repo',
    'ssh://git@host-.example/repo', 'ssh://git@999.999.999.999/repo',
    `ssh://git@${'a'.repeat(64)}.example/repo`,
    'git@-v:org/repo.git', 'git@host..example:org/repo.git',
    'file://remote/share/repo', 'https://example.com/repo\nbad',
  ]) assert.throws(() => validateCloneUrl(value))
  for (const value of ['Project', 'My Project', 'repo.git', '项目']) {
    assert.equal(validateDirectoryName(value), value)
  }
  for (const value of [
    '', '.', '..', '../outside', '/absolute', 'C:\\absolute', 'sub\\dir',
    'CON', 'nul.txt', 'COM1', 'LPT².txt', 'trailing.', 'trailing ', '-option',
    'control\u007f',
  ]) assert.throws(() => validateDirectoryName(value))
})

test('process exit probing treats only ESRCH as gone and surfaces permission or other failures', () => {
  const pid = 12345
  assert.equal(hasOwnedProcessExited(pid, (actual, signal) => {
    assert.equal(actual, pid)
    assert.equal(signal, 0)
    return true
  }), false)
  assert.equal(hasOwnedProcessExited(pid, () => {
    throw Object.assign(new Error('missing'), { code: 'ESRCH' })
  }), true)
  for (const code of ['EPERM', 'EACCES', 'EINVAL', undefined]) {
    const error = Object.assign(new Error('probe failed'), { code })
    assert.throws(() => hasOwnedProcessExited(pid, () => { throw error }), (actual) => actual === error)
  }
})

test('owned process cancellation terminates its child process tree and waits for close', async (t) => {
  const { root } = await projectFixture(t)
  const pidsFile = join(root, 'pids.json')
  const script = `
    const {spawn} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
  `
  const controller = new AbortController()
  const done = runOwnedProcess(process.execPath, ['-e', script, pidsFile], {
    signal: controller.signal,
  })
  const rejected = assert.rejects(done, { name: 'AbortError' })
  t.after(async () => { controller.abort(); await rejected })
  let pids: number[] | undefined
  for (let count = 0; count < 200; count++) {
    try {
      pids = JSON.parse(await readFile(pidsFile, 'utf8')) as number[]
      break
    } catch {
      await setTimeout(10)
    }
  }
  assert.ok(pids, 'process tree started')
  controller.abort()
  await rejected
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), `process ${pid} should have exited`)
  }
})

test('owned process handles failed spawn and pre-aborted execution without hanging', async () => {
  await assert.rejects(runOwnedProcess('shadow-project-test-nonexistent-command', [], {
    signal: new AbortController().signal,
  }), /Git clone did not complete/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runOwnedProcess(process.execPath, [], { signal: controller.signal }), {
    name: 'AbortError',
  })
})
