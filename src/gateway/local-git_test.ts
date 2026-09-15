import assert from 'node:assert/strict'
import childProcess, { execFile, type SpawnOptions } from 'node:child_process'
import { renameSync } from 'node:fs'
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { devNull } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { GitReadError, isNonRepositoryResult, localGitDiff, localGitStatus, MAX_GIT_FILE_BYTES, serveLocalGit } from './local-git.ts'
import { projectFixture } from '../projects/test-fixtures.ts'
import { ProjectRegistry } from '../projects/registry.ts'
import { ProjectService } from '../projects/routes.ts'
import { sessionsApiPlugin } from '../sessions/routes.ts'
import type { SessionManager } from '../sessions/session-manager.ts'

const exec = promisify(execFile)
test('Git discovery classifies only absence of a worktree, including warning-prefixed Windows diagnostics', () => {
  const absent = 'fatal: not a git repository (or any of the parent directories): .git'
  for (const stderr of [absent, `${absent}\r\n`, `warning: fixture advisory\r\n${absent}\r\n`,
    'fatal: not a git repository (or any parent up to mount point /fixture)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n',
    'fatal: this operation must be run in a work tree\n']) {
    assert.equal(isNonRepositoryResult({ code: 128, stderr }), true, stderr)
    assert.equal(isNonRepositoryResult({ code: 1, stderr }), false)
  }
  for (const stderr of ["fatal: not a git repository: 'C:/fixture/broken.git'\n",
    'fatal: invalid gitfile format: .git\n', 'fatal: detected dubious ownership in repository at C:/fixture\n',
    'fatal: unable to access C:/fixture/.git/config: Permission denied\n', 'fatal: bad config line 1\n',
    `error: could not read configuration\n${absent}\n`, `fatal: Permission denied\n${absent}\n`]) {
    assert.equal(isNonRepositoryResult({ code: 128, stderr }), false, stderr)
  }
})

test('ordinary folders return normal unavailable Git status without creating a repository', async t => {
  const { root, folders } = await projectFixture(t)
  // Only the test subprocess receives a discovery ceiling: the fixture is
  // inside the developer checkout but must exercise genuine absent-repo Git.
  const spawn = childProcess.spawn
  t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: SpawnOptions) =>
    spawn(command, args, { ...options, env: { ...options.env, GIT_CEILING_DIRECTORIES: root } }))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await writeFile(join(folders, 'ordinary.txt'), 'normal file\n')
  const app = new Hono()
  app.get('/git/status', c => serveLocalGit(c, folders, 'status'))
  const result = await app.request('/git/status')
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { available: false, reason: 'not_repository', entries: [] })
  await assert.rejects(localGitDiff(folders, 'ordinary.txt'), (error: any) => error.code === 'not_repository')
  assert.equal(await readFile(join(folders, 'ordinary.txt'), 'utf8'), 'normal file\n')
  await assert.rejects(readFile(join(folders, '.git')), (error: any) => error.code === 'ENOENT')
  await writeFile(join(folders, '.git'), 'gitdir: missing-repository\n')
  assert.equal((await app.request('/git/status')).status, 500, 'A broken gitdir is not a non-Git folder')
  t.mock.method(childProcess, 'spawn', (_command: string, args: string[], options: SpawnOptions) =>
    spawn(join(root, 'missing-git-executable'), args, options))
  syncBuiltinESMExports()
  const unavailable = await app.request('/git/status')
  assert.equal(unavailable.status, 200)
  assert.deepEqual(await unavailable.json(), { available: false, reason: 'git_unavailable', entries: [] },
    'Missing Git must retain its distinct unavailable reason')
  await assert.rejects(localGitDiff(folders, 'ordinary.txt'), error => {
    assert(error instanceof GitReadError)
    assert.equal(error.code, 'git_unavailable')
    assert.deepEqual(error.diagnostic, { operation: 'rev-parse', stage: 'spawn', osCode: 'ENOENT' })
    assert.match(error.message, /Git rev-parse; stage=spawn; os=ENOENT/)
    return true
  })
})

test('Git failure diagnostics expose only operation, exit code and fixed cause labels', async t => {
  const { folders } = await projectFixture(t)
  const spawn = childProcess.spawn
  let stderr = ''
  t.mock.method(childProcess, 'spawn', (_command: string, _args: string[], options: SpawnOptions) =>
    spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(128)`], options))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const cases = [
    ['fatal: detected dubious ownership in repository at C:/private-fixture', 'unsafe_ownership'],
    ['fatal: unable to access https://private-fixture.invalid: Permission denied', 'permission_denied'],
    ['fatal: bad config line 7 in C:/private-fixture/config', 'invalid_configuration'],
    ["fatal: not a git repository: 'C:/private-fixture/broken.git'", 'invalid_repository'],
    ['error: unknown option private-fixture', 'unsupported_command'],
    ['unexpected private-fixture diagnostic', undefined],
  ] as const
  const app = new Hono()
  app.get('/git/status', c => serveLocalGit(c, folders, 'status'))
  for (const [diagnostic, cause] of cases) {
    stderr = `${diagnostic}\nprivate-fixture-secret=${'x'.repeat(8000)}\n`
    const response = await app.request('/git/status')
    const body = await response.json()
    assert.equal(response.status, 500)
    assert.equal(body.error, 'git_failed')
    assert.equal(body.message, 'Git inspection failed. Check repository access and integrity; no changes were made.'
      + ` [Git rev-parse; stage=exit; exit=128${cause ? `; cause=${cause}` : ''}]`)
    assert(!JSON.stringify(body).includes('private-fixture'))
    assert(!JSON.stringify(body).includes(folders))
  }
})

test('Git spawn failures preserve safe OS codes without exposing native error messages', async t => {
  const { folders } = await projectFixture(t)
  let code = 'EACCES'
  t.mock.method(childProcess, 'spawn', () => { throw Object.assign(new Error('private-fixture-secret'), { code }) })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  for (const expected of ['EACCES', 'UNKNOWN']) {
    code = expected === 'UNKNOWN' ? 'private-fixture-secret' : expected
    await assert.rejects(localGitStatus(folders), error => {
      assert(error instanceof GitReadError)
      assert.equal(error.code, 'git_failed')
      assert.equal(error.diagnostic?.operation, 'rev-parse')
      assert.equal(error.diagnostic?.stage, 'spawn')
      assert.equal(error.diagnostic?.osCode, expected)
      assert(!error.message.includes('private-fixture'))
      return true
    })
  }
})

test('a missing Git cwd is not misreported as a missing executable, including a spawn race', async t => {
  const { root, folders } = await projectFixture(t)
  await assert.rejects(localGitStatus(join(root, 'missing')), error => {
    assert(error instanceof GitReadError)
    assert.equal(error.code, 'git_cwd_unavailable')
    assert.deepEqual(error.diagnostic, { operation: 'rev-parse', stage: 'workdir', osCode: 'ENOENT', cause: 'workdir_unavailable' })
    assert(!error.message.includes(root))
    return true
  })
  const spawn = childProcess.spawn
  t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: SpawnOptions) => {
    renameSync(folders, join(root, 'moved'))
    return spawn(command, args, options)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(localGitStatus(folders), error => {
    assert(error instanceof GitReadError)
    assert.equal(error.code, 'git_cwd_unavailable')
    assert.deepEqual(error.diagnostic, { operation: 'rev-parse', stage: 'spawn', osCode: 'ENOENT', cause: 'workdir_unavailable' })
    return true
  })
})

async function fixture(t: TestContext, initialize = true) {
  const data = await projectFixture(t)
  // An enclosing synthetic bare repository prevents any upward discovery of
  // the developer's actual checkout in the non-repository tests.
  await exec('git', ['init', '--bare', '--quiet', data.root])
  const git = (...args: string[]) => exec('git', ['-c', `core.hooksPath=${join(data.root, 'no-hooks')}`,
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false', '-C', data.folders, ...args])
  if (initialize) await git('init', '--quiet')
  const write = (name: string, content: string | Uint8Array) => writeFile(join(data.folders, name), content)
  const commit = async () => { await git('add', '--all'); await git('commit', '--quiet', '-m', 'fixture') }
  return { ...data, git, write, commit }
}

test('Git inspection disables hooks with a nonempty null-device path compatible with VFS Git', async t => {
  const { folders } = await fixture(t)
  const hooks = join(folders, 'fixture-hooks')
  await mkdir(hooks)
  await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\necho fixture > hook-ran\n', { mode: 0o755 })
  await exec('git', ['-C', folders, 'config', 'core.hooksPath', hooks])
  await exec('git', ['-C', folders, 'hook', 'run', 'pre-commit'])
  assert.equal((await readFile(join(folders, 'hook-ran'), 'utf8')).trim(), 'fixture')
  await rm(join(folders, 'hook-ran'))
  const spawn = childProcess.spawn
  let discoveryFlags: string[] | undefined
  t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: SpawnOptions) => {
    assert.equal(command, 'git')
    assert(args.includes(`core.hooksPath=${devNull}`))
    assert(!args.includes('core.hooksPath='), 'VFS Git rejects an empty hooks path even during rev-parse')
    const discovery = args.indexOf('rev-parse')
    if (discovery >= 0) discoveryFlags = args.slice(0, discovery)
    return spawn(command, args, options)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  assert.equal((await localGitStatus(folders)).available, true)
  assert(discoveryFlags)
  await exec('git', [...discoveryFlags, '-C', folders, 'hook', 'run', '--ignore-missing', 'pre-commit'])
  await assert.rejects(readFile(join(folders, 'hook-ran')), { code: 'ENOENT' })
})

test('Git compares HEAD to current workdir, combining staged and unstaged edits without mutation', async t => {
  const { folders, write, commit, git } = await fixture(t)
  await write('main.ts', 'const value = 1;\nconst tail = true;\n')
  await commit()
  assert.deepEqual(await localGitStatus(folders), { available: true, entries: [] })
  await write('main.ts', 'const value = 2;\nconst tail = true;\n')
  await git('add', '--', 'main.ts')
  await write('main.ts', 'const value = 3;\nconst tail = false;\n')
  const index = await readFile(join(folders, '.git', 'index'))
  const head = (await git('rev-parse', 'HEAD')).stdout
  assert.deepEqual(await localGitStatus(folders), { available: true, entries: [{ path: 'main.ts', status: 'modified' }] })
  const diff = await localGitDiff(folders, 'main.ts')
  assert.equal(diff.base, 'HEAD')
  assert.equal(diff.binary, false)
  assert.equal(diff.truncated, false)
  assert.equal(diff.oldContent, 'const value = 1;\nconst tail = true;\n')
  assert.equal(diff.newContent, 'const value = 3;\nconst tail = false;\n')
  assert(diff.hunks[0]!.lines.includes('-const value = 1;'))
  assert(diff.hunks[0]!.lines.includes('+const value = 3;'))
  assert.deepEqual(await readFile(join(folders, '.git', 'index')), index)
  assert.equal((await git('rev-parse', 'HEAD')).stdout, head)
})

test('status and diffs cover staged additions, deletion, rename, literal untracked names and index-only changes', async t => {
  const { folders, write, commit, git } = await fixture(t)
  for (const name of ['deleted.txt', 'old.txt', 'index-only.txt']) await write(name, 'base\n')
  await commit()
  await rm(join(folders, 'deleted.txt'))
  await git('mv', '--', 'old.txt', 'renamed.txt')
  await write('renamed.txt', 'renamed plus edit\n')
  await write('added.txt', 'staged\n')
  await git('add', '--', 'added.txt')
  await write('--odd[1].txt', 'untracked\n')
  await write('index-only.txt', 'index differs\n')
  await git('add', '--', 'index-only.txt')
  await write('index-only.txt', 'base\n')
  const entries = (await localGitStatus(folders)).entries
  const entry = (path: string) => entries.find(entry => entry.path === path)!
  assert.equal(entry('deleted.txt').status, 'deleted')
  assert.equal(entry('added.txt').status, 'added')
  assert.equal(entry('--odd[1].txt').status, 'untracked')
  assert.equal(entry('renamed.txt').originalPath, 'old.txt')
  assert.equal(entry('renamed.txt').status, 'renamed')
  assert.equal((await localGitDiff(folders, 'renamed.txt')).oldContent, 'base\n')
  assert.equal((await localGitDiff(folders, 'deleted.txt')).newContent, '')
  assert.equal((await localGitDiff(folders, '--odd[1].txt')).base, 'empty')
  const unchanged = await localGitDiff(folders, 'index-only.txt')
  assert.deepEqual(unchanged.hunks, [])
  assert.match(unchanged.notice!, /No text differences/)
})

test('unborn HEAD yields an empty base, while non-working trees are explicitly unavailable', async t => {
  const { folders, write, git } = await fixture(t)
  await write('first.txt', 'first\n')
  await git('add', '--', 'first.txt')
  const diff = await localGitDiff(folders, 'first.txt')
  assert.equal(diff.base, 'empty')
  assert.equal(diff.oldContent, '')
  assert.equal(diff.newContent, 'first\n')
  const outside = await fixture(t, false)
  assert.deepEqual(await localGitStatus(outside.folders), { available: false, reason: 'not_repository', entries: [] })
})

test('subfolder workdirs never expose sibling paths or outside rename origins', async t => {
  const { folders, write, commit, git } = await fixture(t)
  await mkdir(join(folders, 'inside'))
  await write('outside.txt', 'outside base\n')
  await write('inside/local.txt', 'local base\n')
  await write('inside/moving.txt', 'moving base\n')
  await commit()
  await git('mv', '--', 'outside.txt', 'inside/incoming.txt')
  await git('mv', '--', 'inside/moving.txt', 'outgoing.txt')
  await write('inside/local.txt', 'local edit\n')
  await write('sibling-secret.txt', 'not in scope\n')
  const base = join(folders, 'inside')
  const status = await localGitStatus(base)
  assert(!JSON.stringify(status).includes('outside.txt'))
  assert(!JSON.stringify(status).includes('outgoing.txt'))
  assert(!JSON.stringify(status).includes('sibling-secret'))
  assert(status.entries.some(entry => entry.path === 'local.txt'))
  const incoming = await localGitDiff(base, 'incoming.txt')
  assert.equal(incoming.originalPath, undefined)
  assert.equal(incoming.base, 'empty')
  assert.equal(incoming.oldContent, '')
  assert.equal((await localGitDiff(base, 'local.txt')).oldContent, 'local base\n')
  for (const path of ['../sibling-secret.txt', '/outside.txt', 'C:\\outside.txt', 'folder/../../outside', 'file\0bad', '.git/config']) {
    await assert.rejects(localGitDiff(base, path), (error: any) => error.code === 'invalid_path')
  }
})

test('binary, oversized, symlink and dirty submodule changes have explicit non-text notices', async t => {
  const { folders, root, write, commit, git } = await fixture(t)
  await write('binary.bin', new Uint8Array([1, 0, 2]))
  await write('large.txt', 'base\n')
  const submodule = join(folders, 'child')
  await mkdir(submodule)
  const childGit = (...args: string[]) => exec('git', ['-c', `core.hooksPath=${join(root, 'no-hooks')}`,
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-C', submodule, ...args])
  await childGit('init', '--quiet')
  await write('child/file.txt', 'child base\n')
  await childGit('add', '--all')
  await childGit('commit', '--quiet', '-m', 'child')
  await commit()
  await write('binary.bin', new Uint8Array([3, 0, 4]))
  await write('large.txt', 'x'.repeat(MAX_GIT_FILE_BYTES + 1))
  await write('child/file.txt', 'child dirty\n')
  const sibling = join(root, 'private')
  await mkdir(sibling)
  await writeFile(join(sibling, 'secret.txt'), 'must never be read')
  await symlink(sibling, join(folders, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const binary = await localGitDiff(folders, 'binary.bin')
  assert.equal(binary.binary, true)
  assert.equal(binary.oldContent, undefined)
  const oversized = await localGitDiff(folders, 'large.txt')
  assert.equal(oversized.truncated, true)
  assert.match(oversized.notice!, /256 KiB/)
  const status = await localGitStatus(folders)
  assert(status.entries.some(entry => entry.path === 'child'))
  assert(status.entries.some(entry => entry.path === 'escape'), JSON.stringify(status))
  const child = await localGitDiff(folders, 'child')
  assert.match(child.notice!, /Submodules/)
  assert.equal(child.newContent, undefined)
  const linked = await localGitDiff(folders, 'escape')
  assert.match(linked.notice!, /Symbolic links/)
  await assert.rejects(localGitDiff(folders, 'escape/secret.txt'))
})

test('configured filter and fsmonitor commands are not executed and Git failures are not clean status', async t => {
  const { folders, write, commit, git } = await fixture(t)
  await write('file.txt', 'base\n')
  await commit()
  await write('.gitattributes', '*.txt filter=synthetic\n')
  await git('config', 'filter.synthetic.clean', 'echo should-not-run > filter-ran')
  await git('config', 'filter.synthetic.process', 'echo should-not-run > filter-ran')
  await git('config', 'filter.synthetic.required', 'true')
  await git('config', 'core.fsmonitor', 'echo should-not-run > monitor-ran')
  await write('file.txt', 'modified\n')
  assert((await localGitStatus(folders)).available)
  await assert.rejects(readFile(join(folders, 'filter-ran')))
  await assert.rejects(readFile(join(folders, 'monitor-ran')))
  await writeFile(join(folders, '.git', 'index'), 'corrupt index')
  await assert.rejects(localGitStatus(folders), error => {
    assert(error instanceof GitReadError)
    assert.equal(error.code, 'git_failed')
    assert.deepEqual(error.diagnostic, { operation: 'ls-files', stage: 'exit', exitCode: 128, cause: 'invalid_repository' })
    assert(!error.message.includes(folders))
    return true
  })
})

test('conflicted files compare current conflict markers with HEAD without changing the index', async t => {
  const { folders, write, commit, git } = await fixture(t)
  await write('conflict.txt', 'base\n')
  await commit()
  const branch = (await git('branch', '--show-current')).stdout.trim()
  await git('checkout', '--quiet', '-b', 'other')
  await write('conflict.txt', 'theirs\n')
  await commit()
  await git('checkout', '--quiet', branch)
  await write('conflict.txt', 'ours\n')
  await commit()
  await assert.rejects(git('merge', '--no-edit', 'other'))
  const index = await readFile(join(folders, '.git', 'index'))
  assert.equal((await localGitStatus(folders)).entries[0]!.status, 'conflicted')
  const diff = await localGitDiff(folders, 'conflict.txt')
  assert.equal(diff.oldContent, 'ours\n')
  assert.match(diff.newContent!, /<<<<<<< HEAD/)
  assert.deepEqual(await readFile(join(folders, '.git', 'index')), index)
})

test('ignored directories are pruned and tracked files replaced by directories expose new children', async t => {
  const { folders, write, commit } = await fixture(t)
  await write('.gitignore', 'ignored/\n*.log\n')
  await write('replaced', 'file\n')
  await commit()
  await rm(join(folders, 'replaced'))
  await mkdir(join(folders, 'replaced'))
  await write('replaced/new.txt', 'new\n')
  await mkdir(join(folders, 'ignored'))
  await write('ignored/secret.txt', 'ignored fixture\n')
  await write('ignored.log', 'ignored\n')
  const entries = (await localGitStatus(folders)).entries
  assert(entries.some(entry => entry.path === 'replaced/new.txt' && entry.status === 'untracked'))
  assert(!entries.some(entry => entry.path.includes('ignored')))
})

test('in-flight cancellation stops owned Git work before returning', async t => {
  const { folders } = await fixture(t)
  const controller = new AbortController()
  const pending = localGitStatus(folders, controller.signal)
  const timer = setTimeout(() => controller.abort(), 5)
  try { await assert.rejects(pending, (error: any) => error.code === 'request_cancelled') }
  finally { clearTimeout(timer) }
})

test('project/session routes share validated read-only Git access and remote routes never fall back', async t => {
  const { folders, workspace, write, commit } = await fixture(t)
  await write('file.txt', 'base\n')
  await commit()
  await write('file.txt', 'edit\n')
  const registry = new ProjectRegistry(workspace)
  await registry.init()
  const project = await registry.register(folders)
  let created = 0
  const service = new ProjectService({ registry, createSession: async () => { created++; return { sessionId: 'unexpected', chatId: 'unexpected' } } })
  t.after(() => service.dispose())
  const app = new Hono()
  service.plugin(app)
  const guarded = new Hono()
  guarded.use('/api/*', async (c, next) => c.req.header('authorization') === 'fixture' ? next() : c.json({ error: 'unauthorized' }, 401))
  service.plugin(guarded)
  assert.equal((await guarded.request(`/api/projects/${project.id}/files`)).status, 401)
  assert.equal((await guarded.request(`/api/projects/${project.id}/git/status`)).status, 401)
  assert.equal((await guarded.request(`/api/projects/${project.id}/git/diff?path=file.txt`)).status, 401)
  sessionsApiPlugin({
    workspace, getSessionState: (sessionId: string) => ({
      sessionId, workdir: { version: 1, nodeId: sessionId === 'remote' ? 'child' : 'local', capabilityId: 'workdir' },
    }),
    workdirCapabilityLookup: () => ({ node: 'online', capability: { kind: 'workdir', online: true, path: folders } }),
  } as unknown as SessionManager)(app)
  for (const base of [`/api/projects/${project.id}`, '/api/sessions/local']) {
    assert.equal((await app.request(`${base}/git/status`)).status, 200)
    const diff = await app.request(`${base}/git/diff?path=file.txt&cwd=untrusted`)
    assert.equal(diff.status, 200)
    assert.equal((await diff.json()).newContent, 'edit\n')
    assert.equal((await app.request(`${base}/git/diff?path=..%2Fsecret`)).status, 400)
  }
  assert.equal(created, 0)
  assert.equal((await app.request('/api/projects/missing/git/status')).status, 404)
  assert.deepEqual(await (await app.request('/api/sessions/remote/git/status')).json(),
    { available: false, reason: 'remote_unsupported', entries: [] })
  assert.equal((await app.request('/api/sessions/remote/git/diff?path=file.txt')).status, 501)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(localGitStatus(folders, aborted.signal), (error: any) => error.code === 'request_cancelled')
  const unavailable = new Hono()
  unavailable.get('/git/status', c => serveLocalGit(c, folders, 'status'))
  await rename(folders, `${folders}-moved`)
  t.after(() => rm(`${folders}-moved`, { force: true, recursive: true }))
  assert.equal((await unavailable.request('/git/status')).status, 503)
  assert.equal((await app.request(`/api/projects/${project.id}/git/status`)).status, 409)
})
