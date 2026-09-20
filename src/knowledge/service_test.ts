import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { SkillsManager } from '../skills/loader.ts'
import { KnowledgeError, KnowledgeService, KNOWLEDGE_LIMITS } from './service.ts'
import { registerKnowledgeRoutes } from './routes.ts'
import { canonicalReference, markdownReferences } from './links.ts'

async function fixture(t: TestContext) {
  const root = resolve('.knowledge-test-' + randomUUID())
  await mkdir(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (id: string, content: string) => {
    const file = join(root, ...id.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
    return file
  }
  const skills = new SkillsManager(root)
  const service = new KnowledgeService(root, skills)
  return { root, put, skills, service }
}

test('catalog classifies actual memory files and arbitrary wiki directories, excluding bookkeeping', async t => {
  const f = await fixture(t)
  for (const id of ['memory/sessions/session.md', 'memory/sessions/session.conventions.md',
    'memory/projects/project/conventions.md', 'memory/agent.conventions.md']) await f.put(id, '# Memory')
  await f.put('memory/events/2026-09-20.jsonl', '{"what":"hello"}\n')
  await f.put('memory/sessions/session.files.jsonl', '{"path":"memory/custom/topic.md","action":"write"}\n')
  await f.put('memory/custom/deep/topic.md', '# Wiki')
  await f.put('memory/.learning-watermark.json', '{}')
  await f.put('memory/.private/hidden.md', '# hidden')
  await f.put('memory/custom/asset.json', '{}')
  const catalog = f.service.catalog()
  assert.equal(catalog.entries.length, 7)
  assert.equal(catalog.entries.filter(entry => entry.kind === 'memory').length, 6)
  assert.equal(catalog.entries.find(entry => entry.kind === 'wiki')?.title, 'Wiki')
  assert.ok(catalog.entries.every(entry => entry.source === 'project' && entry.deletable))
  assert.deepEqual(catalog.links, [{
    source: 'memory/sessions/session.files.jsonl', target: 'memory/custom/topic.md', label: 'modified',
  }])
})

test('graph resolves markdown, event refs, skill aliases and learned related names, retaining missing targets', async t => {
  const f = await fixture(t)
  await f.put('memory/custom/topic.md', [
    '# Topic', '[Session](../sessions/one.md#history)', '[Missing](memory/custom/missing.md)',
    '[Alias](v:memory/custom/topic.md)', '[Learned](v:skills/learned)',
    '[Reference][ref]', '[ref]: ../custom/missing.md "Title"',
    '![image](memory/image.md)', '`[not a link](memory/example.md)`',
    '```markdown', '[example](memory/example.md)', '```',
    '[external](https://example.com)', '[anchor](#here)',
  ].join('\n'))
  await f.put('memory/sessions/one.md', '# Session')
  await f.put('memory/events/2026-09-20.jsonl',
    JSON.stringify({ refs: ['memory/custom/topic.md', 'v:memory/missing.md', 3] }) + '\n')
  await f.put('skills/learned/SKILL.md', '---\nname: learned\ndescription: Knowledge\nmetadata:\n  related: cron, absent\n---\n# Learned')
  await f.skills.load()
  const catalog = f.service.catalog()
  const entryIds = new Set(catalog.entries.map(entry => entry.id))
  assert.ok(catalog.links.every(link => entryIds.has(link.source)))
  assert.ok(catalog.links.some(link => !entryIds.has(link.target)))
  const targets = catalog.links.filter(link => link.source === 'memory/custom/topic.md').map(link => link.target)
  assert.deepEqual(targets, [
    'memory/sessions/one.md', 'memory/custom/missing.md', 'memory/custom/topic.md',
    'skills/learned/SKILL.md', 'memory/custom/missing.md',
  ])
  assert.ok(catalog.links.some(link => link.source === 'skills/learned/SKILL.md'
    && link.target === 'builtin:skills/cron' && link.label === 'related'))
  assert.ok(catalog.links.some(link => link.target === 'skills/absent/SKILL.md'))
  assert.ok(catalog.links.some(link => link.target === 'memory/missing.md' && link.label === 'refs'))
})

test('delete persists just the selected file, preserves incoming links, rejects stale content, and deletes whole daily logs', async t => {
  const f = await fixture(t)
  const selected = 'memory/custom/topic.md'
  await f.put(selected, '# Topic')
  await f.put('memory/custom/referrer.md', '[Topic](topic.md)')
  const detail = f.service.detail(selected)
  await f.put(selected, '# Changed')
  assert.throws(() => f.service.delete(selected, detail.entry.revision), { status: 409 })
  assert.equal(await readFile(join(f.root, selected), 'utf8'), '# Changed')
  const current = f.service.detail(selected)
  assert.deepEqual(f.service.delete(selected, current.entry.revision), { deleted: selected })
  assert.equal(existsSync(join(f.root, selected)), false)
  assert.equal(await readFile(join(f.root, 'memory/custom/referrer.md'), 'utf8'), '[Topic](topic.md)')
  assert.ok(f.service.catalog().links.some(link => link.target === selected))
  const events = 'memory/events/2026-09-20.jsonl'
  await f.put(events, '{"what":"first"}\n{"what":"second"}\n')
  f.service.delete(events, f.service.detail(events).entry.revision)
  assert.equal(existsSync(join(f.root, events)), false)
})

test('project skill delete invalidates renamed skill cache immediately, retains resources, and restores readonly builtin', async t => {
  const f = await fixture(t)
  await f.put('skills/custom-directory/SKILL.md', '---\nname: cron\ndescription: override\nadmin: true\n---\n# Override')
  await f.put('skills/custom-directory/resource.ts', 'export const resource = true')
  await f.skills.load()
  const staleSkill = f.skills.getSkill('cron', true)!
  assert.equal(f.skills.getSkill('cron'), undefined)
  const before = f.service.catalog()
  const entry = before.entries.find(entry => entry.id === 'skills/custom-directory/SKILL.md')!
  assert.match(entry.description!, /restores.*built-in/)
  assert.equal(before.entries.some(entry => entry.id === 'builtin:skills/cron'), false)
  f.service.delete(entry.id, entry.revision)
  assert.equal(existsSync(join(f.root, entry.id)), false)
  assert.equal(existsSync(join(f.root, 'skills/custom-directory/resource.ts')), true)
  assert.notEqual(f.skills.getSkillBody('cron'), staleSkill.body)
  f.skills.setSkill('cron', staleSkill)
  assert.notEqual(f.skills.getSkillBody('cron'), staleSkill.body)
  f.skills.replaceSkills(new Map([['cron', staleSkill]]))
  assert.notEqual(f.skills.getSkillBody('cron'), staleSkill.body)
  const builtin = f.service.catalog().entries.find(entry => entry.id === 'builtin:skills/cron')!
  assert.equal(builtin.source, 'builtin')
  assert.equal(builtin.deletable, false)
  assert.throws(() => f.service.delete(builtin.id, builtin.revision), { status: 403 })
  assert.match(f.service.detail(builtin.id).content, /cron/i)
  await f.put('skills/custom-directory/SKILL.md', '---\nname: cron\ndescription: recreated\n---\n# Recreated')
  await f.skills.load()
  assert.match(f.skills.getSkillBody('cron')!, /Recreated/)
})

test('rejects malformed IDs and arbitrary files without trusting client paths', async t => {
  const f = await fixture(t)
  await f.put('memory/custom/topic.md', '# Topic')
  await f.put('skills/custom/resource.md', 'private')
  for (const id of [
    '../memory/custom/topic.md', '/memory/custom/topic.md', 'memory/../secret.md',
    'memory\\custom\\topic.md', 'memory/%2e%2e/secret.md', 'memory/.hidden.md',
    'memory/foo.md:stream', 'memory//custom/topic.md', 'memory/foo. /x.md',
    'skills/custom/resource.md', 'skills/custom/SKILL.md/extra', 'builtin:skills/../cron',
    'bot.config.json', '', undefined,
  ]) {
    assert.throws(() => f.service.detail(id), KnowledgeError)
  }
  assert.throws(() => f.service.detail('memory/custom/absent.md'), { status: 404 })
  assert.throws(() => f.service.delete('memory/custom/topic.md', 'not-a-revision'), { status: 400 })
})

test('symlink and ancestor junction escapes are never browsed or deleted', async t => {
  const f = await fixture(t)
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'private.md'), '# Private')
  await mkdir(join(f.root, 'memory'))
  await symlink(outside, join(f.root, 'memory', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(f.service.catalog().entries.length, 0)
  assert.throws(() => f.service.detail('memory/escape/private.md'), { status: 403 })
  assert.throws(() => f.service.delete('memory/escape/private.md', '0'.repeat(64)), { status: 403 })
  assert.equal(await readFile(join(outside, 'private.md'), 'utf8'), '# Private')
  const linkedWorkspace = join(f.root, 'alias')
  await symlink(f.root, linkedWorkspace, process.platform === 'win32' ? 'junction' : 'dir')
  const linkedService = new KnowledgeService(linkedWorkspace, new SkillsManager(linkedWorkspace))
  assert.throws(() => linkedService.catalog(), { status: 403 })
})

test('project skills behind junctions are denied even if the runtime discovered them', async t => {
  const f = await fixture(t)
  await f.put('outside/SKILL.md', '---\nname: escape\n---\n# Private')
  await mkdir(join(f.root, 'skills'))
  await symlink(join(f.root, 'outside'), join(f.root, 'skills', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await f.skills.load()
  assert.throws(() => f.service.catalog(), { status: 403 })
  assert.throws(() => f.service.detail('skills/escape/SKILL.md'), { status: 403 })
})

test('limits and malformed event data fail explicitly instead of returning an incomplete graph', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.service.catalog(), { entries: [], links: [] })
  await f.put('memory/large.md', 'x'.repeat(KNOWLEDGE_LIMITS.fileBytes + 1))
  assert.throws(() => f.service.catalog(), { status: 413 })
  await rm(join(f.root, 'memory/large.md'))
  await f.put('memory/events/broken.jsonl', '{"refs":')
  assert.throws(() => f.service.catalog(), { status: 422 })
  assert.equal(f.service.detail('memory/events/broken.jsonl').content, '{"refs":')
})

test('content revisions hash persisted bytes, including distinct invalid UTF-8 sequences', async t => {
  const f = await fixture(t)
  const path = await f.put('memory/raw.md', '')
  await writeFile(path, Buffer.from([0xff]))
  const before = f.service.detail('memory/raw.md')
  await writeFile(path, Buffer.from([0xfe]))
  const after = f.service.detail('memory/raw.md')
  assert.equal(before.content, after.content)
  assert.notEqual(before.entry.revision, after.entry.revision)
  assert.throws(() => f.service.delete(before.entry.id, before.entry.revision), { status: 409 })
})

test('separate project workspaces never share knowledge entries or deletions', async t => {
  const first = await fixture(t)
  const second = await fixture(t)
  await first.put('memory/topic.md', '# First project')
  await second.put('memory/topic.md', '# Second project')
  const entry = first.service.detail('memory/topic.md').entry
  assert.throws(() => second.service.delete(entry.id, entry.revision), { status: 409 })
  first.service.delete(entry.id, entry.revision)
  assert.equal(second.service.detail(entry.id).content, '# Second project')
  assert.equal(first.service.catalog().entries.length, 0)
})

test('HTTP routes authorize every operation and validate delete bodies and revisions', async t => {
  const f = await fixture(t)
  await f.put('memory/topic.md', '# Topic')
  const app = new Hono()
  registerKnowledgeRoutes(app, {
    workspace: f.root, skills: f.skills,
    authorize: request => request.headers.get('authorization') === 'owner-fixture',
  })
  const request = (path: string, method = 'GET', body?: string, authorized = true) => app.request('/api/knowledge' + path, {
    method, body, headers: {
      ...(authorized ? { authorization: 'owner-fixture' } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
  })
  for (const [path, method] of [['', 'GET'], ['/entry?id=memory%2Ftopic.md', 'GET'], ['/entry', 'DELETE']]) {
    assert.equal((await request(path, method, undefined, false)).status, 401)
  }
  const catalog = await request('')
  assert.equal(catalog.status, 200)
  assert.equal(catalog.headers.get('cache-control'), 'no-store')
  const detail = await (await request('/entry?id=memory%2Ftopic.md')).json()
  assert.equal(detail.content, '# Topic')
  assert.equal((await request('/entry?id=..%2Fsecrets.md')).status, 400)
  assert.equal((await request('/entry', 'DELETE', '{')).status, 400)
  assert.equal((await request('/entry', 'DELETE', JSON.stringify({ id: 'memory/topic.md', revision: detail.entry.revision, path: 'secret' }))).status, 400)
  assert.equal((await request('/entry', 'DELETE', JSON.stringify({ id: 'memory/topic.md', revision: '0'.repeat(64) }))).status, 409)
  assert.equal((await request('/entry', 'DELETE', 'x'.repeat(4097))).status, 413)
  const deleted = await request('/entry', 'DELETE', JSON.stringify({ id: detail.entry.id, revision: detail.entry.revision }))
  assert.equal(deleted.status, 200)
  assert.deepEqual(await deleted.json(), { deleted: 'memory/topic.md' })
  assert.equal((await request('/entry?id=memory%2Ftopic.md')).status, 404)
})

test('markdown parser ignores code/images, supports balanced paths and reference links', () => {
  assert.deepEqual(markdownReferences([
    '[one](memory/a(b).md "title")', '[two](<memory/a b.md>)',
    '![picture][ref]', '[ref]: memory/ref.md', '[ref]',
    '~~~', '[code](memory/code.md)', '~~~', '    [indented](memory/code.md)',
    '<!-- [comment](memory/comment.md) -->',
  ].join('\n')), [
    { label: 'one', target: 'memory/a(b).md' },
    { label: 'two', target: 'memory/a b.md' },
    { label: 'ref', target: 'memory/ref.md' },
  ])
  assert.equal(canonicalReference('../../../outside.md', 'memory/topic.md', resolve('.'), new Map()), undefined)
  assert.equal(canonicalReference('mailto:person@example.com', 'memory/topic.md', resolve('.'), new Map()), undefined)
  assert.equal(canonicalReference('../ref.md#section', 'memory/topics/topic.md', resolve('.'), new Map()), 'memory/ref.md')
})
