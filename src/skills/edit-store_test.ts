import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { getArch, getOs } from '../utils/runtime.ts'
import { SkillEditStore, SKILL_EDIT_LIMITS, readSkillDirectory } from './edit-store.ts'
import { SkillsManager } from './loader.ts'
import { searchSkills } from './search.ts'

function manifest(name = 'example', body = 'Original instructions', extra: Record<string, unknown> = {}): string {
  return `---\n${JSON.stringify({ name, description: body, ...extra })}\n---\n${body}\n`
}

function setup(workspace: string) {
  const skills = new SkillsManager(workspace)
  return { skills, store: new SkillEditStore(workspace, skills), directory: join(workspace, 'skills', 'example') }
}

function noTransactions(workspace: string): void {
  const root = join(workspace, 'skills')
  if (fs.existsSync(root)) assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.skill-edit-')), [])
}

test('create, merge, delete and read complete packages; refresh manager and search immediately', async () => {
  await withTempWorkspace(async workspace => {
    const { skills, store, directory } = setup(workspace)
    assert.deepEqual({ ...store.read('example'), files: {} }, { name: 'example', revision: null, files: {}, source: 'missing' })
    const created = await store.save('example', {
      'SKILL.md': manifest(), 'references/one.txt': 'first', 'references/two.txt': 'second',
    }, null)
    assert.deepEqual(created.files, ['SKILL.md', 'references/one.txt', 'references/two.txt'])
    assert.equal(store.read('example').source, 'project')
    assert.equal(store.read('example').revision, created.revision)
    assert.equal(readSkillDirectory(directory).revision, created.revision)
    assert.match(skills.getSkillBody('example')!, /Original instructions/)
    const binary = Buffer.from([0, 1, 2, 0xff, 0xfe, 0x80])
    fs.writeFileSync(join(directory, 'binary.dat'), binary)
    const baseline = store.read('example')
    assert.notEqual(baseline.revision, created.revision)
    const updated = await store.save('example', {
      'SKILL.md': manifest('example', 'Freshly searchable'),
      'references/one.txt': null, 'references/three.txt': 'third',
    }, baseline.revision)
    assert.notEqual(updated.revision, baseline.revision)
    assert.deepEqual(fs.readFileSync(join(directory, 'binary.dat')), binary)
    assert.equal(fs.readFileSync(join(directory, 'references', 'two.txt'), 'utf8'), 'second')
    assert.equal(fs.existsSync(join(directory, 'references', 'one.txt')), false)
    assert.match(skills.getSkillBody('example')!, /Freshly searchable/)
    assert.equal(JSON.parse(searchSkills(skills, { query: 'Freshly searchable' })).skills[0].name, 'example')
    baseline.files['binary.dat']![0] = 99
    assert.deepEqual(store.read('example').files['binary.dat'], binary)
    noTransactions(workspace)
  })
})

test('empty directories read as missing and can be initialized', async () => {
  await withTempWorkspace(async workspace => {
    const { store, directory } = setup(workspace)
    fs.mkdirSync(directory, { recursive: true })
    assert.equal(store.read('example').source, 'missing')
    assert.equal(store.read('example').revision, null)
    const saved = await store.save('example', { 'SKILL.md': 'Plain instructions without frontmatter' }, null)
    assert.equal(store.read('example').revision, saved.revision)
    noTransactions(workspace)
  })
})

test('fingerprints detect same-size same-mtime external changes and all resource changes', async () => {
  await withTempWorkspace(async workspace => {
    const { store, directory } = setup(workspace)
    const original = await store.save('example', { 'SKILL.md': manifest(), 'data.txt': 'aaaa' }, null)
    const data = join(directory, 'data.txt')
    const stat = fs.statSync(data)
    fs.writeFileSync(data, 'bbbb')
    fs.utimesSync(data, stat.atime, stat.mtime)
    assert.notEqual(store.read('example').revision, original.revision)
    await assert.rejects(store.save('example', { 'SKILL.md': manifest('example', 'overwrite') }, original.revision), /revision conflict/)
    await assert.rejects(store.save('example', { 'SKILL.md': manifest() }, null), /revision conflict/)
    assert.equal(fs.readFileSync(data, 'utf8'), 'bbbb')
    assert.equal(fs.readFileSync(join(directory, 'SKILL.md'), 'utf8'), manifest())
    noTransactions(workspace)
  })
})

test('same-store concurrent saves serialize and only one matching revision succeeds', async () => {
  await withTempWorkspace(async workspace => {
    const { store } = setup(workspace)
    const original = await store.save('example', { 'SKILL.md': manifest() }, null)
    const results = await Promise.allSettled([
      store.save('example', { 'one.txt': 'one' }, original.revision),
      store.save('example', { 'two.txt': 'two' }, original.revision),
    ])
    assert.equal(results[0].status, 'fulfilled')
    assert.equal(results[1].status, 'rejected')
    assert.deepEqual(Object.keys(store.read('example').files).sort(), ['SKILL.md', 'one.txt'])
    noTransactions(workspace)
  })
})

test('multi-file candidates validate manifest, declared sources and parameter schemas before writes', async () => {
  await withTempWorkspace(async workspace => {
    const { store } = setup(workspace)
    const saved = await store.save('example', { 'SKILL.md': manifest(), 'keep.txt': 'unchanged' }, null)
    const invalid: Array<Record<string, string | null>> = [
      { 'SKILL.md': null },
      { 'SKILL.md': '  \n' },
      { 'SKILL.md': '---\nname: example\n' },
      { 'SKILL.md': '---\nname: [invalid\n---\nbody\n' },
      { 'SKILL.md': '---\n- not-a-mapping\n---\nbody\n' },
      { 'SKILL.md': '---\nname: example\nname: duplicate\n---\nbody\n' },
      { 'SKILL.md': manifest('different') },
      { 'SKILL.md': manifest('example', 'bad tools', { tools: { invalid: {} } }) },
      { 'SKILL.md': manifest('example', 'missing source', { tools: {
        run: { source: 'missing.ts', description: 'Run', parameters: { type: 'object', properties: {} } },
      } }) },
      { 'SKILL.md': manifest('example', 'escaping source', { tools: {
        run: { source: '../outside.ts', description: 'Run', parameters: { type: 'object', properties: {} } },
      } }) },
      { 'SKILL.md': manifest('example', 'invalid schema', { tools: {
        run: { source: 'run.ts', description: 'Run', parameters: { type: 'object', properties: { value: { type: 'not-a-json-schema-type' } } } },
      } }), 'run.ts': 'export default () => 1' },
    ]
    for (const edits of invalid) {
      await assert.rejects(store.save('example', { 'keep.txt': 'would be changed', ...edits }, saved.revision))
      assert.equal(store.read('example').revision, saved.revision)
      assert.equal(store.read('example').files['keep.txt']!.toString(), 'unchanged')
      noTransactions(workspace)
    }
    const tools = { run: { source: './scripts/run.ts', description: 'Run',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }
    const updated = await store.save('example', {
      'SKILL.md': manifest('example', 'Tools', { tools }), 'scripts/run.ts': 'export default () => 1',
    }, saved.revision)
    await assert.rejects(store.save('example', { 'scripts/run.ts': null }, updated.revision), /source does not exist/)
    assert.equal(store.read('example').revision, updated.revision)
  })
})

test('builtin-only packages are readable but immutable; existing project overrides are editable', async () => {
  await withTempWorkspace(async workspace => {
    const { skills, store } = setup(workspace)
    await skills.load()
    const builtin = skills.availableSkillSources(true).find(entry => entry.source === 'builtin' && !entry.skill.meta.admin)!
    assert.ok(builtin)
    const name = builtin.skill.meta.name
    const read = store.read(name)
    assert.equal(read.source, 'builtin')
    assert.ok(read.files['SKILL.md'])
    await assert.rejects(store.save(name, { 'SKILL.md': manifest(name) }, null), /Builtin-only/)
    await assert.rejects(store.save(name, { 'SKILL.md': manifest(name) }, read.revision), /Builtin-only/)
    const target = join(workspace, 'skills', name)
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(join(target, 'SKILL.md'), manifest(name, 'Project override'))
    assert.equal(store.read(name).source, 'project')
    await store.save(name, { 'SKILL.md': manifest(name, 'Updated override') }, store.read(name).revision)
    assert.match(skills.getSkillBody(name)!, /Updated override/)
    fs.rmSync(target, { recursive: true })
    await assert.rejects(store.save(name, { 'SKILL.md': manifest(name) }, null), /Builtin-only/)
    noTransactions(workspace)
  })
})

test('reject traversal, reserved Windows names, casing and file/directory collisions', async () => {
  await withTempWorkspace(async workspace => {
    const { store } = setup(workspace)
    const saved = await store.save('example', { 'SKILL.md': manifest(), 'Keep.txt': 'safe' }, null)
    for (const name of ['..', '../escape', 'a\\b', 'C:drive', '.hidden', 'CON', 'nul.txt', 'com¹.txt', 'EXAMPL~1', 'trailing.', 'space ']) {
      assert.throws(() => store.read(name), /Skill|skill|Unsafe/)
      await assert.rejects(store.save(name, { 'SKILL.md': manifest(name) }, null))
    }
    for (const path of ['../escape', '/absolute', '\\absolute', 'C:\\escape', 'stream:ads',
      'a/../b', 'a//b', 'a/./b', 'NUL.txt', 'NUL .txt', 'nested/LPT9', 'bad.', 'a /b', 'e\u0301.txt']) {
      await assert.rejects(store.save('example', { [path]: 'bad' }, saved.revision))
    }
    const collisions: Array<Record<string, string | null>> = [
      { 'A.txt': 'one', 'a.txt': 'two' },
      { 'a/b.txt': 'one', 'a\\b.txt': 'two' },
      { 'folder': 'file', 'folder/child.txt': 'child' },
      { 'Folder/one.txt': 'one', 'folder/two.txt': 'two' },
      { 'keep.txt': 'wrong case' },
      { 'keep.txt': null },
      { 'SKILL.md/child': 'child' },
    ]
    for (const edits of collisions) await assert.rejects(store.save('example', edits, saved.revision), /collision|colliding|casing/)
    await assert.rejects(store.save('EXAMPLE', { 'SKILL.md': manifest('EXAMPLE') }, null), /collides/)
    assert.equal(store.read('example').revision, saved.revision)
    noTransactions(workspace)
  })
})

test('junctions and hard links cannot be read or edited as package resources', async () => {
  await withTempWorkspace(async workspace => {
    const { store, directory } = setup(workspace)
    const saved = await store.save('example', { 'SKILL.md': manifest() }, null)
    const outside = join(workspace, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(join(outside, 'data.txt'), 'untouched')
    fs.symlinkSync(outside, join(directory, 'linked'), 'junction')
    assert.throws(() => store.read('example'), /symlink|junction/)
    await assert.rejects(store.save('example', { 'linked/data.txt': 'changed' }, saved.revision), /symlink|junction/)
    fs.unlinkSync(join(directory, 'linked'))
    fs.linkSync(join(outside, 'data.txt'), join(directory, 'hard.txt'))
    assert.throws(() => store.read('example'), /regular file/)
    fs.unlinkSync(join(directory, 'hard.txt'))
    fs.symlinkSync(outside, join(workspace, 'skills', 'linked'), 'junction')
    assert.throws(() => store.read('linked'), /symlink|junction/)
    await assert.rejects(store.save('linked', { 'SKILL.md': manifest('linked') }, null), /symlink|junction/)
    assert.equal(fs.readFileSync(join(outside, 'data.txt'), 'utf8'), 'untouched')
    noTransactions(workspace)
  })
})

test('symlinked owning skills roots are rejected before creation', async () => {
  await withTempWorkspace(async workspace => {
    const { store } = setup(workspace)
    const outside = join(workspace, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, join(workspace, 'skills'), 'junction')
    assert.throws(() => store.read('example'), /symlink|junction/)
    await assert.rejects(store.save('example', { 'SKILL.md': manifest() }, null), /symlink|junction/)
    assert.deepEqual(fs.readdirSync(outside), [])
  })
})

test('count, byte and depth limits reject rather than truncate existing or proposed packages', async () => {
  await withTempWorkspace(async workspace => {
    const { store, directory } = setup(workspace)
    await assert.rejects(store.save('example', { 'SKILL.md': 'x'.repeat(SKILL_EDIT_LIMITS.bytes + 1) }, null), /byte limit/)
    const tooMany = Object.fromEntries(Array.from({ length: SKILL_EDIT_LIMITS.files + 1 }, (_, i) => [`${i}.txt`, 'x']))
    await assert.rejects(store.save('example', tooMany, null), /file count limit/)
    await assert.rejects(store.save('example', { [`${'a/'.repeat(SKILL_EDIT_LIMITS.depth)}file`]: 'x' }, null), /depth limit/)
    assert.equal(fs.existsSync(join(workspace, 'skills')), false)
    const saved = await store.save('example', { 'SKILL.md': manifest() }, null)
    for (let i = 0; i < SKILL_EDIT_LIMITS.files; i++) fs.writeFileSync(join(directory, `${i}.txt`), 'x')
    assert.throws(() => store.read('example'), /file count limit/)
    await assert.rejects(store.save('example', { '0.txt': null }, saved.revision), /file count limit/)
    for (let i = 0; i < SKILL_EDIT_LIMITS.files; i++) fs.unlinkSync(join(directory, `${i}.txt`))
    const descriptor = fs.openSync(join(directory, 'oversized.bin'), 'w')
    fs.ftruncateSync(descriptor, SKILL_EDIT_LIMITS.bytes + 1)
    fs.closeSync(descriptor)
    assert.throws(() => store.read('example'), /byte limit/)
    noTransactions(workspace)
  })
})

test('already aborted and queued aborted saves do not write', async () => {
  await withTempWorkspace(async workspace => {
    const { store } = setup(workspace)
    const aborted = AbortSignal.abort()
    await assert.rejects(store.save('example', { 'SKILL.md': manifest() }, null, false, aborted), { name: 'AbortError' })
    assert.equal(fs.existsSync(join(workspace, 'skills')), false)
    const saved = await store.save('example', { 'SKILL.md': manifest() }, null)
    const controller = new AbortController()
    const pending = store.save('example', { 'new.txt': 'never written' }, saved.revision, false, controller.signal)
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(store.read('example').revision, saved.revision)
    noTransactions(workspace)
  })
})

test('failed replacement rolls back the original and removes transaction directories', async t => {
  await withTempWorkspace(async workspace => {
    const { store, skills } = setup(workspace)
    const saved = await store.save('example', { 'SKILL.md': manifest(), 'keep.txt': 'safe' }, null)
    const rename = fs.renameSync
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).endsWith('candidate')) throw new Error('injected replacement failure')
      return rename(from, to)
    })
    await assert.rejects(store.save('example', { 'SKILL.md': manifest('example', 'new') }, saved.revision), /injected replacement failure/)
    assert.equal(store.read('example').revision, saved.revision)
    assert.match(skills.getSkillBody('example')!, /Original instructions/)
    noTransactions(workspace)
    t.mock.restoreAll()
    await store.save('example', { 'recovered.txt': 'queue still usable' }, saved.revision)
    noTransactions(workspace)
  })
})

test('final revalidation rejects external content changes and newly introduced junctions', async t => {
  await withTempWorkspace(async workspace => {
    const { store, directory } = setup(workspace)
    const saved = await store.save('example', { 'SKILL.md': manifest(), 'data.txt': 'old' }, null)
    const write = fs.writeFileSync
    let injected = false
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      write(...args)
      if (!injected && String(args[0]).includes('.skill-edit-')) {
        injected = true
        write(join(directory, 'data.txt'), 'new')
      }
    })
    await assert.rejects(store.save('example', { 'next.txt': 'next' }, saved.revision), /revision conflict during commit/)
    assert.equal(fs.readFileSync(join(directory, 'data.txt'), 'utf8'), 'new')
    noTransactions(workspace)
    t.mock.restoreAll()
    const current = store.read('example')
    const outside = join(workspace, 'outside')
    fs.mkdirSync(outside)
    injected = false
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      write(...args)
      if (!injected && String(args[0]).includes('.skill-edit-')) {
        injected = true
        fs.symlinkSync(outside, join(directory, 'link'), 'junction')
      }
    })
    await assert.rejects(store.save('example', { 'next.txt': 'next' }, current.revision), /symlink|junction/)
    assert.deepEqual(fs.readdirSync(outside), [])
    noTransactions(workspace)
  })
})

test('cleanup failures are explicit even when the save has committed', async t => {
  await withTempWorkspace(async workspace => {
    const { store, skills } = setup(workspace)
    const remove = fs.rmSync
    t.mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
      if (String(args[0]).includes('.skill-edit-')) throw new Error('injected cleanup failure')
      return remove(...args)
    })
    await assert.rejects(store.save('example', { 'SKILL.md': manifest() }, null), /Skill saved, but transaction cleanup failed/)
    assert.ok(store.read('example').revision)
    assert.match(skills.getSkillBody('example')!, /Original instructions/)
    t.mock.restoreAll()
    for (const entry of fs.readdirSync(join(workspace, 'skills'))) {
      if (entry.startsWith('.skill-edit-')) fs.rmSync(join(workspace, 'skills', entry), { recursive: true })
    }
    noTransactions(workspace)
  })
})

test('staging failure and abort during preparation preserve the original package', async t => {
  await withTempWorkspace(async workspace => {
    const { store } = setup(workspace)
    const saved = await store.save('example', { 'SKILL.md': manifest() }, null)
    const write = fs.writeFileSync
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).includes('.skill-edit-')) throw new Error('injected staging failure')
      write(...args)
    })
    await assert.rejects(store.save('example', { 'extra.txt': 'new' }, saved.revision), /injected staging failure/)
    assert.equal(store.read('example').revision, saved.revision)
    noTransactions(workspace)
    t.mock.restoreAll()
    const controller = new AbortController()
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      write(...args)
      if (String(args[0]).includes('.skill-edit-')) controller.abort()
    })
    await assert.rejects(store.save('example', { 'extra.txt': 'new' }, saved.revision, false, controller.signal), { name: 'AbortError' })
    assert.equal(store.read('example').revision, saved.revision)
    noTransactions(workspace)
  })
})

test('rollback failure is explicit and never deletes the only surviving original', async t => {
  await withTempWorkspace(async workspace => {
    const { store } = setup(workspace)
    const saved = await store.save('example', { 'SKILL.md': manifest(), 'keep.txt': 'irreplaceable' }, null)
    const rename = fs.renameSync
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (/candidate$|previous$/.test(String(from))) throw new Error('injected rename failure')
      return rename(from, to)
    })
    await assert.rejects(store.save('example', { 'keep.txt': 'new' }, saved.revision), /replacement and rollback failed; original retained at/)
    const transactions = fs.readdirSync(join(workspace, 'skills')).filter(name => name.startsWith('.skill-edit-'))
    assert.equal(transactions.length, 1)
    const previous = join(workspace, 'skills', transactions[0]!, 'previous')
    assert.equal(fs.readFileSync(join(previous, 'keep.txt'), 'utf8'), 'irreplaceable')
    assert.equal(readSkillDirectory(previous).revision, saved.revision)
    t.mock.restoreAll()
    fs.renameSync(previous, join(workspace, 'skills', 'example'))
    fs.rmSync(join(workspace, 'skills', transactions[0]!), { recursive: true })
    noTransactions(workspace)
  })
})

test('manager removes stale directory aliases and respects platform, architecture and admin visibility', async () => {
  await withTempWorkspace(async workspace => {
    const { store, skills, directory } = setup(workspace)
    skills.setSkill('old-alias', { meta: { name: 'old-alias', description: 'stale' }, body: 'old', dirPath: directory })
    let saved = await store.save('example', { 'SKILL.md': manifest('example', 'current', {
      platform: [getOs()], arch: [getArch()],
    }) }, null)
    assert.equal(skills.getSkill('old-alias'), undefined)
    assert.ok(skills.getSkill('example'))
    saved = await store.save('example', { 'SKILL.md': manifest('example', 'other platform', { platform: ['unsupported-platform'] }) }, saved.revision)
    assert.equal(skills.getSkill('example'), undefined)
    saved = await store.save('example', { 'SKILL.md': manifest('example', 'other arch', { arch: ['unsupported-arch'] }) }, saved.revision)
    assert.equal(skills.getSkill('example'), undefined)
    await assert.rejects(store.save('example', { 'SKILL.md': manifest('example', 'admin only', { admin: true }) }, saved.revision), /admin/)
    saved = await store.save('example', { 'SKILL.md': manifest('example', 'admin only', { admin: true }) }, saved.revision, true)
    assert.equal(skills.getSkill('example'), undefined)
    assert.ok(skills.getSkill('example', true))
    assert.throws(() => store.read('example'), /admin/)
    assert.equal(store.read('example', true).revision, saved.revision)
    await assert.rejects(store.save('example', { 'extra.txt': 'denied' }, saved.revision), /admin/)
    noTransactions(workspace)
  })
})
