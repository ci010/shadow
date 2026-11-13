import test from 'node:test'
import assert from 'node:assert/strict'
import { realpath, mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { LayerFSImportReview, importPolicy } from './import-review.ts'
import { stageLocalImport } from './import-local-stage.ts'

const signal = () => new AbortController().signal
test('Git-aware plan and actual staging preserve index, tracked ignored and untracked nonignored files', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'import-test-'))
  let staged: string | undefined
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args])
  try {
    git('init')
    await writeFile(join(root, '.gitignore'), 'ignored\nnode_modules/\n')
    await writeFile(join(root, 'ignored'), 'synthetic tracked fixture')
    git('add', '-f', 'ignored'); git('add', '.gitignore')
    await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules', 'untracked'), 'fixture')
    await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist', 'x'), 'fixture')
    await mkdir(join(root, 'build')); await writeFile(join(root, 'build', 'x'), 'fixture')
    await writeFile(join(root, '.env'), 'synthetic fixture only')
    const index = await readFile(join(root, '.git', 'index'))
    const review = new LayerFSImportReview()
    for (const policy of ['git', 'curated', 'whole_tree']) {
      assert.equal(importPolicy(policy), 'git')
      assert.equal((await review.preview(root, 'owner', signal(), policy)).status, 'ready')
    }
    await review.consume(undefined, root, 'owner', undefined, signal())
    staged = await stageLocalImport(root, signal())
    assert.deepEqual((await readdir(staged)).sort(), ['.env', '.git', '.gitignore', 'build', 'dist', 'ignored'])
    assert.deepEqual(await readFile(join(staged, '.git', 'index')), index)
    assert.deepEqual(await readFile(join(root, '.git', 'index')), index)
    assert.equal(execFileSync('git', ['-C', staged, 'status', '--porcelain']).toString(), git('status', '--porcelain').toString())
  } finally { await rm(root, { recursive: true, force: true }); if (staged) await rm(join(staged, '..'), { recursive: true, force: true }) }
})
test('non Git ignores no names; safety, quotas and pointer topology still fail closed', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'import-test-'))
  try {
    await mkdir(join(root, 'node_modules')); await writeFile(join(root, '.gitignore'), '*')
    await writeFile(join(root, '.env'), 'synthetic')
    const review = new LayerFSImportReview()
    assert.equal((await review.preview(root, 'owner', signal())).summary.files, 2)
    assert.equal((await new LayerFSImportReview({ maxEntries: 1 }).preview(root, 'owner', signal())).status, 'blocked')
    await symlink('/outside', join(root, 'link'))
    assert.equal((await review.preview(root, 'owner', signal())).status, 'blocked')
    await rm(join(root, 'link')); await writeFile(join(root, '.git'), 'gitdir: /outside')
    await assert.rejects(review.consume(undefined, root, 'owner', undefined, signal()))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('dependency reuse is source-provenance aware, never inferred from WSL target', async () => {
  const { importSelection } = await import('./import-selection.ts')
  const root = await mkdtemp(join(await realpath(tmpdir()), 'import-os-test-'))
  try {
    execFileSync('git', ['init', root])
    await writeFile(join(root, '.gitignore'), 'node_modules/\ncache/\n')
    await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules', 'x'), 'synthetic')
    await mkdir(join(root, 'cache')); await writeFile(join(root, 'cache', 'x'), 'synthetic')
    for (const os of ['win32', 'darwin', 'unknown', 'linux']) {
      const selection = await importSelection(root, os)
      assert.equal(selection.includes('node_modules'), os === 'linux')
      assert.equal(selection.includes('node_modules/x'), os === 'linux')
      assert.equal(selection.includes('cache/x'), false)
    }
    execFileSync('git', ['-C', root, 'add', '-f', 'node_modules/x'])
    assert.equal((await importSelection(root, 'win32')).includes('node_modules/x'), false)
    assert.equal((await importSelection(root, 'linux')).includes('node_modules/x'), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('initialized submodule gitlinks explicitly block preview and local staging before filtering', async () => {
  const envelope = await mkdtemp(join(await realpath(tmpdir()), 'import-submodule-test-'))
  const root = join(envelope, 'root'), sub = join(envelope, 'sub')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
  try {
    await mkdir(root); await mkdir(sub)
    git(root, 'init'); git(sub, 'init')
    await writeFile(join(sub, 'fixture.txt'), 'synthetic fixture')
    git(sub, 'add', 'fixture.txt')
    git(sub, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'child')
    assert.match(await readFile(join(root, 'child', '.git'), 'utf8'), /^gitdir:/)
    const index = await readFile(join(root, '.git', 'index'))
    const review = new LayerFSImportReview()
    const preview = await review.preview(root, 'owner', signal())
    assert.equal(preview.status, 'blocked')
    assert.ok(preview.blockers.some(blocker => blocker.reason === 'unsupported_git_submodule_topology'))
    await assert.rejects(stageLocalImport(root, signal()), /unsupported_git_submodule_topology/)
    assert.deepEqual(await readFile(join(root, '.git', 'index')), index)
    assert.equal(await readFile(join(root, 'child', 'fixture.txt'), 'utf8'), 'synthetic fixture')
  } finally { await rm(envelope, { recursive: true, force: true }) }
})
