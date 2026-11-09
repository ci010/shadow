import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { LayerFSBaseline } from './baseline.ts'

const owner = 'synthetic-project/session'
const signal = () => new AbortController().signal
async function fixture(work: (source: string, target: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(process.cwd(), '.layerfs-baseline-test-'))
  const source = join(root, 'source'), target = join(root, 'outputs')
  await mkdir(source)
  try { await work(source, target, root) }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
async function put(source: string, path: string, contents = 'synthetic') {
  const parts = path.split('/')
  await mkdir(join(source, ...parts.slice(0, -1)), { recursive: true })
  await writeFile(join(source, ...parts), contents)
}
function git(source: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
async function absent(path: string) { await assert.rejects(lstat(path), { code: 'ENOENT' }) }

test('real synthetic Git inventory copies working-tree tracked files only, warnings are reviewable, original unchanged', async () => {
  await fixture(async (source, target) => {
    git(source, ['init', '--quiet'])
    const contents: Record<string, string> = {
      'src/main.ts': 'indexed version', 'credentials.svg': '<svg/>', 'secret-redaction.ts': 'export const redacted = true',
      '.env.example': 'EXAMPLE=', '.env': 'SYNTHETIC=', 'credentials.json': '{"synthetic":true}',
      'node_modules/synthetic/index.js': 'dependency', '.venv/synthetic.py': 'dependency', '.ssh/synthetic.ts': 'not approved',
    }
    for (const [path, content] of Object.entries(contents)) await put(source, path, content)
    git(source, ['add', '--', '.'])
    await put(source, 'src/main.ts', 'working tree changed from index')
    contents['src/main.ts'] = 'working tree changed from index'
    await put(source, 'untracked.txt', 'never copied')
    const originalIndex = await readFile(join(source, '.git', 'index'))
    const baseline = new LayerFSBaseline(target)
    const plan = await baseline.plan(source, owner, signal())
    await absent(target) // Planning changes/copies nothing, including destination root.
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan)
    assert.equal(plan.summary.files, 4)
    assert.equal(plan.summary.trackedEntries, 9)
    assert.equal(plan.summary.excludedEntries, 5)
    assert.equal(plan.warnings.length, 2)
    assert.match(plan.guidance, /Untracked files are excluded/)
    assert.match(plan.guidance, /not a secret scanner or credential-free certification/)
    assert.match(plan.guidance, /human content review/)
    const ready = await baseline.prepare(plan.plan, source, owner, signal())
    assert.equal(ready.files, 4)
    assert.equal(ready.bytes, plan.summary.bytes)
    assert.equal(await readFile(join(ready.path, 'src/main.ts'), 'utf8'), contents['src/main.ts'])
    assert.equal(await readFile(join(ready.path, 'credentials.svg'), 'utf8'), '<svg/>')
    assert.deepEqual((await readdir(ready.path)).sort(), ['.env.example', 'credentials.svg', 'secret-redaction.ts', 'src'])
    for (const [path, content] of Object.entries(contents)) assert.equal(await readFile(join(source, path), 'utf8'), content)
    assert.deepEqual(await readFile(join(source, '.git', 'index')), originalIndex)
    assert.equal(await readFile(join(source, 'untracked.txt'), 'utf8'), 'never copied')
    await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /fresh source\/owner-bound plan/)
  })
})

test('curated inventory excludes VCS/dependencies/private directories while retaining credential modules', async () => {
  await fixture(async (source, target) => {
    const paths = ['.git/config', '.hg/data', '.svn/file', 'vendor/code.ts', 'node_modules/x/index.ts', '.venv/lib.py', 'credentials/code.ts', '.aws/code.ts', '.ssh/code.ts', '.env.local', 'key.pem', 'secret-store.json', 'credentials.svg', 'secrets.md']
    for (const path of paths) await put(source, path)
    const baseline = new LayerFSBaseline(target, { inventory: async () => paths, maxFindings: 1 })
    const plan = await baseline.plan(source, owner, signal())
    assert.equal(plan.summary.files, 3)
    assert.equal(plan.summary.excludedEntries, 11)
    assert.equal(plan.exclusions.length, 1)
    assert.equal(plan.exclusionsTruncated, true)
    assert.equal(plan.warnings.length, 1)
    assert.equal(plan.warningsTruncated, true)
    assert.ok(!JSON.stringify(plan).includes(source))
    const ready = await baseline.prepare(plan.plan, source, owner, signal())
    assert.deepEqual((await readdir(ready.path)).sort(), ['credentials', 'credentials.svg', 'secrets.md'])
  })
})

test('owner/source binding, exact token, expiry and single-use concurrency', async t => {
  await fixture(async (source, target, root) => {
    await put(source, 'a.ts')
    const baseline = new LayerFSBaseline(target, { inventory: async () => ['a.ts'] })
    const plan = await baseline.plan(source, owner, signal())
    await assert.rejects(baseline.prepare(plan, source, owner, signal()), /fresh/)
    await assert.rejects(baseline.prepare(plan.plan, source, 'other-owner', signal()), /fresh/)
    await assert.rejects(baseline.prepare(plan.plan, join(root, 'other-source'), owner, signal()), /fresh/)
    const results = await Promise.allSettled([baseline.prepare(plan.plan, source, owner, signal()), baseline.prepare(plan.plan, source, owner, signal())])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(results.filter(r => r.status === 'rejected').length, 1)
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const expires = await baseline.plan(source, owner, signal())
    t.mock.timers.tick(15 * 60_000)
    await assert.rejects(baseline.prepare(expires.plan, source, owner, signal()), /fresh/)
  })
})

test('changed selected metadata or tracked inventory refuses preparation before creating target', async t => {
  for (const change of ['contents', 'inventory', 'remove']) await t.test(change, async () => {
    await fixture(async (source, target) => {
      let paths = ['a.ts']
      await put(source, 'a.ts')
      await put(source, 'b.ts')
      const baseline = new LayerFSBaseline(target, { inventory: async () => paths })
      const plan = await baseline.plan(source, owner, signal())
      if (change === 'contents') await put(source, 'a.ts', 'changed-size')
      if (change === 'inventory') paths = ['a.ts', 'b.ts']
      if (change === 'remove') await rm(join(source, 'a.ts'))
      await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /No destination is ready/)
      await absent(target)
      await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /fresh/)
    })
  })
})

test('symlinks/junctions, linked source ancestors and unsafe target fail closed', async () => {
  await fixture(async (source, target, root) => {
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere)
    await put(elsewhere, 'a.ts')
    const linked = join(source, 'linked')
    await symlink(elsewhere, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const nested = new LayerFSBaseline(target, { inventory: async () => ['linked/a.ts'] })
    await assert.rejects(nested.plan(source, owner, signal()))
    await assert.rejects(nested.plan(linked, owner, signal()))
    await put(source, 'a.ts')
    const baseline = new LayerFSBaseline(target, { inventory: async () => ['a.ts'] })
    const plan = await baseline.plan(source, owner, signal())
    await symlink(elsewhere, target, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /No destination is ready/)
    assert.deepEqual(await readdir(elsewhere), ['a.ts'])
    await assert.rejects(new LayerFSBaseline(join(source, 'nested')).plan(source, owner, signal()), /overlap/)
    await assert.rejects(new LayerFSBaseline(root).plan(source, owner, signal()), /overlap/)
  })
})

test('unsafe inventory, collisions, directories, entry/byte ceilings and abort/deadline are bounded', async () => {
  await fixture(async (source, target) => {
    await put(source, 'a.ts', '12345')
    await mkdir(join(source, 'directory'))
    for (const paths of [['../escape'], ['/absolute'], ['C:/escape'], ['a\\b'], ['a/../b'], ['file:stream'], ['nul.txt'], ['name.'], ['a.ts', 'A.ts'], ['directory']]) {
      await assert.rejects(new LayerFSBaseline(target, { inventory: async () => paths }).plan(source, owner, signal()))
    }
    await assert.rejects(new LayerFSBaseline(target, { inventory: async () => ['a.ts'], maxBytes: 4 }).plan(source, owner, signal()))
    await assert.rejects(new LayerFSBaseline(target, { inventory: async () => ['a.ts', 'b.ts'], maxEntries: 1 }).plan(source, owner, signal()))
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(new LayerFSBaseline(target, { inventory: async () => ['a.ts'] }).plan(source, owner, aborted.signal))
    await assert.rejects(new LayerFSBaseline(target, { inventory: async () => new Promise(() => {}), maxDurationMs: 20 }).plan(source, owner, signal()))
    await absent(target)
  })
})

test('source change after copying fails closed, retains partial destination, does not return ready or allow replay', async () => {
  await fixture(async (source, target) => {
    await put(source, 'a.ts')
    let inventories = 0
    const baseline = new LayerFSBaseline(target, { inventory: async () => {
      if (++inventories === 5) await put(source, 'a.ts', 'synthetic concurrent change')
      return ['a.ts']
    } })
    const plan = await baseline.plan(source, owner, signal())
    await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /No destination is ready/)
    const partials = await readdir(target)
    assert.equal(partials.length, 1)
    assert.equal(await readFile(join(target, partials[0]!, 'a.ts'), 'utf8'), 'synthetic')
    assert.equal(await readFile(join(source, 'a.ts'), 'utf8'), 'synthetic concurrent change')
    await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /fresh/)
  })
})

test('abort during copy retains its exclusive destination and does not change originals or existing outputs', async t => {
  await fixture(async (source, target) => {
    await put(source, 'a.ts', 'x'.repeat(4 * 1024 * 1024))
    await put(target, 'existing/keep.txt', 'keep')
    const baseline = new LayerFSBaseline(target, { inventory: async () => ['a.ts'] })
    const plan = await baseline.plan(source, owner, signal())
    const controller = new AbortController()
    // Deterministic interruption after the first actual output write. OS watchers
    // can batch write notifications until close, so they cannot prove mid-copy failure.
    const probe = await open(join(source, 'a.ts'), 'r')
    const prototype = Object.getPrototypeOf(probe) as FileHandle
    const originalWrite = prototype.write
    await probe.close()
    const mocked = t.mock.method(prototype, 'write', async function (this: FileHandle, ...args: unknown[]) {
      const result = await Reflect.apply(originalWrite, this, args)
      controller.abort()
      return result
    })
    try { await assert.rejects(baseline.prepare(plan.plan, source, owner, controller.signal), /No destination is ready/) }
    finally { mocked.mock.restore() }
    assert.equal(await readFile(join(target, 'existing/keep.txt'), 'utf8'), 'keep')
    assert.equal((await lstat(join(source, 'a.ts'))).size, 4 * 1024 * 1024)
    const partials = (await readdir(target)).filter(p => p.startsWith('baseline-'))
    assert.equal(partials.length, 1)
    const copied = (await lstat(join(target, partials[0]!, 'a.ts'))).size
    assert.ok(copied > 0 && copied < 4 * 1024 * 1024, `partial bytes: ${copied}`)
  })
})

test('Git inventory disables repository fsmonitor and ignores inherited Git config injection', async () => {
  await fixture(async (source, target) => {
    git(source, ['init', '--quiet'])
    await put(source, 'a.ts')
    git(source, ['add', '--', 'a.ts'])
    git(source, ['config', 'core.fsmonitor', 'a-command-that-must-never-run'])
    // Real Git regression: Git for Windows must use its /dev/null spelling,
    // while inherited global/system config and command injection stay disabled.
    const poison = join(source, 'untracked-poison.config')
    await writeFile(poison, '[invalid config syntax')
    const overrides = { GIT_CONFIG_COUNT: 'invalid-inherited-injection', GIT_CONFIG_GLOBAL: poison, GIT_CONFIG_SYSTEM: poison }
    const old = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
    Object.assign(process.env, overrides)
    try {
      const baseline = new LayerFSBaseline(target)
      const plan = await baseline.plan(source, owner, signal())
      assert.equal(plan.summary.files, 1)
      const prepared = await baseline.prepare(plan.plan, source, owner, signal())
      assert.equal(await readFile(join(prepared.path, 'a.ts'), 'utf8'), 'synthetic')
      await absent(join(prepared.path, 'untracked-poison.config'))
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

test('unreadable selected files are rejected', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  await fixture(async (source, target) => {
    await put(source, 'a.ts')
    await chmod(join(source, 'a.ts'), 0)
    try { await assert.rejects(new LayerFSBaseline(target, { inventory: async () => ['a.ts'] }).plan(source, owner, signal())) }
    finally { await chmod(join(source, 'a.ts'), 0o600) }
  })
})

test('special tracked files are rejected without opening contents', { skip: process.platform === 'win32' }, async () => {
  await fixture(async (source, target) => {
    const made = spawnSync('mkfifo', [join(source, 'pipe')], { encoding: 'utf8' })
    assert.equal(made.status, 0, made.stderr)
    await assert.rejects(new LayerFSBaseline(target, { inventory: async () => ['pipe'] }).plan(source, owner, signal()))
  })
})


test('exact credential plaintext/export artifacts are excluded while explanatory files and assets are copied', async () => {
  await fixture(async (source, target) => {
    const excluded = ['credentials.txt', 'secrets.txt', 'secret.csv', 'credentials.bak', 'credential.tsv', 'secrets.log', '.credentials.txt', '.secret.csv']
    const reviewable = ['credentials.svg', 'secret-redaction.ts', 'secret-guide.txt', 'credentials-explanation.csv', 'secret-redaction.log']
    const paths = [...excluded, ...reviewable]
    for (const path of paths) await put(source, path)
    const baseline = new LayerFSBaseline(target, { inventory: async () => paths })
    const plan = await baseline.plan(source, owner, signal())
    assert.equal(plan.summary.files, reviewable.length)
    assert.equal(plan.summary.excludedEntries, excluded.length)
    assert.deepEqual(plan.exclusions.map(finding => finding.path).sort(), [...excluded].sort())
    assert.ok(plan.exclusions.every(finding => finding.reason === 'possible_credentials_or_private_key'))
    assert.deepEqual(plan.warnings.map(finding => finding.path).sort(), [...reviewable].sort())
    const ready = await baseline.prepare(plan.plan, source, owner, signal())
    assert.deepEqual((await readdir(ready.path)).sort(), [...reviewable].sort())
    for (const path of excluded) assert.equal(await readFile(join(source, path), 'utf8'), 'synthetic')
  })
})


test('planning and pre-copy metadata revalidation retain their 120-second default/ceiling', async t => {
  for (const phase of ['plan-default', 'plan-capped', 'pre-copy']) await t.test(phase, async t => {
    await fixture(async (source, target) => {
      await put(source, 'a.ts')
      t.mock.timers.enable({ apis: ['setTimeout'] })
      let calls = 0
      const baseline = new LayerFSBaseline(target, {
        maxDurationMs: phase === 'plan-capped' ? 1_000_000 : undefined,
        inventory: async () => {
          if (++calls === (phase === 'pre-copy' ? 3 : 1)) t.mock.timers.tick(120_000)
          return ['a.ts']
        },
      })
      if (phase === 'pre-copy') {
        const plan = await baseline.plan(source, owner, signal())
        await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /baseline_time_limit/)
      } else {
        await assert.rejects(baseline.plan(source, owner, signal()), /baseline_time_limit/)
      }
      await absent(target)
    })
  })
})

test('admitted preparation has an independent 15-minute default/ceiling and optional tighter budget', async t => {
  const cases = [
    { name: 'continues beyond planning budget', elapsed: 120_001, maxPrepareDurationMs: undefined, succeeds: true },
    { name: 'default runtime limit', elapsed: 900_000, maxPrepareDurationMs: undefined, succeeds: false },
    { name: 'cannot raise runtime ceiling', elapsed: 900_000, maxPrepareDurationMs: 1_000_000, succeeds: false },
    { name: 'tighter runtime limit', elapsed: 25, maxPrepareDurationMs: 25, succeeds: false },
  ]
  for (const item of cases) await t.test(item.name, async t => {
    await fixture(async (source, target) => {
      await put(source, 'a.ts')
      t.mock.timers.enable({ apis: ['setTimeout'] })
      let calls = 0
      const baseline = new LayerFSBaseline(target, {
        // No real-clock waits: only the admitted runtime's clock advances.
        maxDurationMs: 1,
        maxPrepareDurationMs: item.maxPrepareDurationMs,
        inventory: async () => {
          if (++calls === 5) t.mock.timers.tick(item.elapsed)
          return ['a.ts']
        },
      })
      const plan = await baseline.plan(source, owner, signal())
      if (item.succeeds) {
        const ready = await baseline.prepare(plan.plan, source, owner, signal())
        assert.equal(await readFile(join(ready.path, 'a.ts'), 'utf8'), 'synthetic')
      } else {
        await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /baseline_time_limit.*No destination is ready.*partial destination is retained/)
        const partials = await readdir(target)
        assert.equal(partials.length, 1)
        assert.equal(await readFile(join(target, partials[0]!, 'a.ts'), 'utf8'), 'synthetic')
        await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /fresh/)
      }
      assert.equal(await readFile(join(source, 'a.ts'), 'utf8'), 'synthetic')
    })
  })
})

test('plan expiry during pre-copy revalidation refuses admission without creating destination', async t => {
  await fixture(async (source, target) => {
    await put(source, 'a.ts')
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    let calls = 0
    const baseline = new LayerFSBaseline(target, { inventory: async () => {
      // The token is fresh when prepare starts, but expires during its rescan.
      if (++calls === 4) t.mock.timers.tick(15 * 60_000)
      return ['a.ts']
    } })
    const plan = await baseline.plan(source, owner, signal())
    await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /baseline_source_changed_or_expired/)
    await absent(target)
    await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /fresh/)
  })
})

test('plan expiry after valid admission does not invalidate a stable completed baseline', async t => {
  await fixture(async (source, target) => {
    await put(source, 'a.ts')
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    let calls = 0
    const baseline = new LayerFSBaseline(target, { inventory: async () => {
      const call = ++calls
      if (call === 4) t.mock.timers.tick(15 * 60_000 - 1)
      // Final revalidation happens after destination creation and copying.
      if (call === 5) t.mock.timers.tick(2)
      return ['a.ts']
    } })
    const plan = await baseline.plan(source, owner, signal())
    assert.match(plan.guidance, /Plans expire after 15 minutes/)
    assert.match(plan.guidance, /plan expiry does not interrupt an admitted copy/)
    const ready = await baseline.prepare(plan.plan, source, owner, signal())
    assert.equal(ready.files, 1)
    assert.equal(await readFile(join(ready.path, 'a.ts'), 'utf8'), 'synthetic')
    assert.equal(await readFile(join(source, 'a.ts'), 'utf8'), 'synthetic')
    await assert.rejects(baseline.prepare(plan.plan, source, owner, signal()), /fresh/)
  })
})


test('curated baseline retains credential source modules but excludes nested secret data', async () => {
  await fixture(async (source, target) => {
    const paths = ['src/credentials/index.ts', 'src/credentials/provider/auth.ts', 'src/credentials/account.json', 'src/credentials/.env', 'src/credentials/private.key']
    for (const path of paths) await put(source, path)
    const baseline = new LayerFSBaseline(target, { inventory: async () => paths })
    const plan = await baseline.plan(source, owner, signal())
    assert.equal(plan.summary.files, 2)
    assert.equal(plan.summary.excludedEntries, 3)
    assert.equal(plan.warnings.length, 2)
    const result = await baseline.prepare(plan.plan, source, owner, signal())
    assert.equal(await readFile(join(result.path, paths[0]), 'utf8'), 'synthetic')
    assert.equal(await readFile(join(result.path, paths[1]), 'utf8'), 'synthetic')
    await absent(join(result.path, paths[2]))
  })
})
