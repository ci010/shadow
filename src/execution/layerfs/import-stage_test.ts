import { importSelection } from './import-selection.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { importStageScript } from './import-stage.ts'
import { managedRunner } from './managed-runner.ts'
import { importRefusal } from './import-diagnostic.ts'
import { importProgressSchema } from './managed.ts'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const script = importStageScript.replace('const select = ' + importSelection.toString() + ';', '') .replace("const fs = await import('node:fs/promises');", '')
  .replace("const { execFileSync } = await import('node:child_process');", '')
async function fixture(work: (run: (options?: { source?: string; policy?: string; mutate?: boolean; failWrite?: boolean; ctimeOnly?: boolean; link?: boolean }) => Promise<string>, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(join(process.cwd(), '.layerfs-stage-test-'))
  const source = join(root, 'input'), stages = join(root, 'stages')
  await fs.mkdir(source); await fs.mkdir(stages); await fs.writeFile(join(source, 'hello.txt'), 'approved')
  const mapped = (path: string) => path === '/source' || path.startsWith('/source/') ? source + path.slice(7)
    : path.startsWith('/var/tmp/') ? stages + path.slice(8) : stages
  try {
    await work(async (options = {}) => {
      let output = '', opened = false
      const proxy = {
        ...fs,
        statfs: async () => ({ type: 0xef53 }),
        lstat: async (p: string, o: any) => {
          const s = await fs.lstat(mapped(p), o)
          if (options.link && p === '/source/hello.txt') return { ...s, isSymbolicLink: () => true }
          if (options.ctimeOnly && opened) (s as any).ctimeNs += 1n
          return s
        },
        readdir: (p: string) => fs.readdir(mapped(p)),
        opendir: (p: string) => fs.opendir(mapped(p)),
        mkdir: (p: string, o: any) => fs.mkdir(mapped(p), o),
        chmod: (p: string, mode: number) => fs.chmod(mapped(p), mode),
        utimes: (p: string, a: number, m: number) => fs.utimes(mapped(p), a, m),
        open: async (p: string, flags: any, mode: any) => {
          if (options.failWrite && p.startsWith('/var/tmp/')) throw Error('synthetic write failure')
          const f = await fs.open(mapped(p), flags, mode)
          if (p === '/source/hello.txt') {
            opened = true
            if (options.mutate) await fs.writeFile(mapped(p), 'changed source size')
          }
          return f
        },
      }
      const process = { argv: ['node', options.source ?? 'C:\\approved', 'a'.repeat(32), options.policy ?? 'curated'], stdout: { write: (s: string) => { output += s } } }
      const execFileSync = (command: string, args: string[]) => { assert.equal(command, 'wslpath'); assert.deepEqual(args, ['-a', '-u', options.source ?? 'C:\\approved']); return '/source' }
      await new AsyncFunction('fs', 'process', 'execFileSync', 'select', script)(proxy, process, execFileSync, () => importSelection(source, 'win32'))
      return output
    }, root)
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

test('generated runner and fixed helper are valid JavaScript modules', () => {
  for (const script of [managedRunner, importStageScript]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: script, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
})
test('exclusive complete copy tolerates only ctime changes and retains successful attempts', async () => {
  await fixture(async (run, root) => {
    const a = JSON.parse(await run({ ctimeOnly: true })), b = JSON.parse(await run())
    assert.notEqual(a.destination, b.destination)
    const names = await fs.readdir(join(root, 'stages')); assert.equal(names.length, 2)
    assert.equal(await fs.readFile(join(root, 'stages', names[0]!, 'source', 'hello.txt'), 'utf8'), 'approved')
  })
})
test('legacy aliases copy all safe names without content approval', async () => {
  await fixture(async (run, root) => {
    await fs.mkdir(join(root, 'input', 'node_modules')); await fs.writeFile(join(root, 'input', 'node_modules', 'index.js'), 'code')
    await run()
    await run({ policy: 'whole_tree' })
    await fs.writeFile(join(root, 'input', '.env'), 'synthetic')
    await run({ policy: 'whole_tree' })
  })
})
test('links, unstable identity/size and failed copy retain partials without success receipt', async () => {
  for (const option of [{ link: true }, { mutate: true }, { failWrite: true }]) await fixture(async (run, root) => {
    await assert.rejects(run(option)); assert.equal((await fs.readdir(join(root, 'stages'))).length, 1)
  })
})
test('non-drive input and policy injection are refused before copy', async () => {
  await fixture(async (run, root) => {
    for (const source of ['../source', '/native', '--help', 'C:\\x\0bad', 'C:\\approved\\..\\private']) await assert.rejects(run({ source }))
    await assert.rejects(run({ policy: 'whole_tree; touch /bad' }))
    assert.equal((await fs.readdir(join(root, 'stages'))).length, 0)
  })
})
test('native refusal projects only documented exact messages and bounded in-source names', () => {
  const message = 'project.init refused /mnt/c/source/file.json: the entry changed while Init read it'
  assert.deepEqual(importRefusal({ code: 'InvalidInput', message }, 'C:\\source'), { reason: 'Changed', path: 'file.json' })
  for (const bad of [message + '; private cleanup diagnostic', 'prefix ' + message, message.replace('file.json', '../private'), message.replace('/source/', '/elsewhere/'), message.replace('file.json', 'x\nsecret'), 'PRIVATE_KEY']) assert.equal(importRefusal({ code: 'InvalidInput', message: bad }, 'C:\\source'), undefined)
  assert.equal(importRefusal({ code: 'Failed', message }, 'C:\\source'), undefined)
})

test('IPC refuses arbitrary diagnostic fields, absolute paths and unknown reasons', () => {
  for (const refusal of [{ reason: 'Changed', path: '/private/source' }, { reason: 'Changed', path: '../private' }, { reason: 'CATALOG_KEY', path: 'file' }, { reason: 'Changed', path: 'file', message: 'PRIVATE' }, { reason: 'Mode', path: 'file', mode: '77777' }]) assert.equal(importProgressSchema.safeParse({ stage: 'failed', refusal }).success, false)
})

test('shell-looking source names remain one literal argument to fixed wslpath', async () => {
  await fixture(async run => { await run({ source: 'C:\\literal;$(touch marker)' }) })
})

test('both staging policies retain Git metadata, but reject pointer topology', async () => {
  for (const policy of ['curated', 'whole_tree']) await fixture(async (run, root) => {
    const git = join(root, 'input', '.git')
    assert.equal(spawnSync('git', ['init', join(root, 'input')]).status, 0)
    const config = await fs.readFile(join(git, 'config'), 'utf8')
    await run({ policy })
    const [stage] = await fs.readdir(join(root, 'stages'))
    assert.equal(await fs.readFile(join(root, 'stages', stage!, 'source', '.git', 'config'), 'utf8'), config)
    await fs.rm(git, { recursive: true })
    await fs.writeFile(git, 'gitdir: /synthetic/external')
    await assert.rejects(run({ policy }))
  })
})

test('Windows Linux-view staging applies Git filtering, retains tracked ignored and excludes Windows dependencies', async () => {
  await fixture(async (run, root) => {
    const source = join(root, 'input')
    assert.equal(spawnSync('git', ['init', source]).status, 0)
    await fs.writeFile(join(source, '.gitignore'), 'ignored\nnode_modules/\n')
    await fs.writeFile(join(source, 'ignored'), 'synthetic tracked')
    assert.equal(spawnSync('git', ['-C', source, 'add', '-f', 'ignored']).status, 0)
    await fs.writeFile(join(source, 'untracked'), 'synthetic')
    await fs.mkdir(join(source, 'node_modules')); await fs.writeFile(join(source, 'node_modules', 'x'), 'synthetic')
    assert.equal(spawnSync('git', ['-C', source, 'add', '-f', 'node_modules/x']).status, 0)
    await fs.mkdir(join(source, 'dist')); await fs.writeFile(join(source, 'dist', 'x'), 'synthetic')
    await fs.mkdir(join(source, 'build')); await fs.writeFile(join(source, 'build', 'x'), 'synthetic')
    const index = await fs.readFile(join(source, '.git', 'index'))
    const receipt = JSON.parse(await run())
    const stage = join(root, 'stages', receipt.destination.split('/')[3], 'source')
    assert.deepEqual((await fs.readdir(stage)).sort(), ['.git', '.gitignore', 'build', 'dist', 'hello.txt', 'ignored', 'untracked'])
    assert.deepEqual(await fs.readFile(join(stage, '.git', 'index')), index)
    assert.deepEqual(await fs.readFile(join(source, '.git', 'index')), index)
  })
})

test('Windows staging refuses gitlink before filtering an initialized submodule into an empty directory', async () => {
  await fixture(async (run, root) => {
    const source = join(root, 'input')
    assert.equal(spawnSync('git', ['init', source]).status, 0)
    await fs.mkdir(join(source, 'child'))
    await fs.writeFile(join(source, 'child', '.git'), 'gitdir: ../.git/modules/child\n')
    await fs.writeFile(join(source, 'child', 'fixture.txt'), 'synthetic fixture')
    assert.equal(spawnSync('git', ['-C', source, 'update-index', '--add', '--cacheinfo', '160000,' + 'a'.repeat(40) + ',child']).status, 0)
    const index = await fs.readFile(join(source, '.git', 'index'))
    await assert.rejects(run(), /unsupported_git_submodule_topology/)
    assert.deepEqual(await fs.readdir(join(root, 'stages')), [])
    assert.deepEqual(await fs.readFile(join(source, '.git', 'index')), index)
    assert.equal(await fs.readFile(join(source, 'child', 'fixture.txt'), 'utf8'), 'synthetic fixture')
  })
})
