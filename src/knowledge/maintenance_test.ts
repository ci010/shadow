import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs, { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { SkillsManager } from '../skills/loader.ts'
import { parseSkillFile } from '../skills/parse.ts'
import { KnowledgeService, KNOWLEDGE_LIMITS } from './service.ts'
import { markdownReferenceSpans } from './links.ts'
import { KnowledgeMaintenanceService, KNOWLEDGE_MAINTENANCE_INTERVAL_MS } from './maintenance.ts'
import { registerKnowledgeRoutes } from './routes.ts'

async function fixture(t: TestContext) {
  const root = resolve('.knowledge-maintenance-test-' + randomUUID())
  await mkdir(root)
  const skills = new SkillsManager(root)
  const maintenance = new KnowledgeMaintenanceService(root, skills)
  t.after(async () => {
    await maintenance.stop()
    await rm(root, { recursive: true, force: true })
  })
  const put = async (id: string, content: string | Buffer) => {
    const file = join(root, ...id.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
    return file
  }
  await maintenance.init()
  return { root, put, skills, maintenance, knowledge: new KnowledgeService(root, skills) }
}

test('scan distinguishes missing, present uncatalogued resources/directories, and unavailable targets without changing content', async t => {
  const f = await fixture(t)
  const source = 'memory/wiki/topic.md'
  const text = [
    '# Topic', '[missing](gone.md)', '[valid](present.md)',
    '[resource](skills/helper/assets/readme.txt)', '[file](data.txt)', '[directory](../data)',
    '[outside](../../../outside.md)', '[scope](v:sessions/one)',
    '[junction](memory/linked/private.md)', '[not-directory](data.txt/child.md)',
    '[hidden](memory/.private/secret.md)', '[external](https://example.com)', '[self](#section)',
  ].join('\n')
  await f.put(source, text)
  await f.put('memory/wiki/present.md', '# Present')
  await f.put('memory/wiki/data.txt', 'local uncatalogued data')
  await f.put('skills/helper/assets/readme.txt', 'bundled resource')
  await mkdir(join(f.root, 'memory', 'data'))
  await f.put('outside/private.md', '# Not inspectable via link')
  await symlink(join(f.root, 'outside'), join(f.root, 'memory', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const report = await f.maintenance.scan()
  const byLabel = new Map(report.findings.map(finding => [finding.label, finding]))
  assert.equal(report.entriesScanned, 2)
  assert.equal(byLabel.get('missing')?.reason, 'missing')
  assert.equal(byLabel.get('missing')?.repairable, true)
  assert.equal(byLabel.get('missing')?.target, 'memory/wiki/gone.md')
  for (const label of ['resource', 'file', 'directory']) {
    assert.equal(byLabel.get(label)?.reason, 'outside-catalog', label)
    assert.equal(byLabel.get(label)?.repairable, false, label)
  }
  for (const label of ['outside', 'scope', 'junction', 'not-directory', 'hidden']) {
    assert.equal(byLabel.get(label)?.reason, 'unavailable', label)
    assert.equal(byLabel.get(label)?.repairable, false, label)
  }
  for (const label of ['valid', 'external', 'self']) assert.equal(byLabel.has(label), false)
  assert.equal(await readFile(join(f.root, source), 'utf8'), text)
  assert.equal(await readFile(join(f.root, 'outside/private.md'), 'utf8'), '# Not inspectable via link')
  assert.equal(existsSync(join(f.root, '.knowledge-maintenance', 'report.json')), true)
  assert.equal(f.maintenance.status().intervalMs, KNOWLEDGE_MAINTENANCE_INTERVAL_MS)
  const originalFindings = structuredClone(report.findings)
  report.findings.length = 0
  assert.deepEqual(f.maintenance.status().report?.findings, originalFindings)
  const repeat = await f.maintenance.scan()
  assert.deepEqual(repeat.findings, originalFindings)
  assert.notEqual(repeat.id, report.id)
})

test('confirmed repair changes only selected Wiki links; spans preserve labels, CRLF, images, escapes, code, and definitions', async t => {
  const f = await fixture(t)
  const sourceId = 'memory/wiki/topic.md'
  const before = [
    '# Wiki',
    'Before [first](memory/missing.md#anchor "title") and [second][gone].',
    '[collapsed][] and [shortcut] and [escaped path](memory/a\\(b\\).md).',
    '[gone]: memory/absent.md',
    '[collapsed]: <memory/missing file.md>',
    '[shortcut]: memory/shortcut.md',
    '![image](memory/missing.md) ![reference image][gone]',
    '\\[escaped](memory/missing.md)',
    '`[inline](memory/missing.md)`',
    '`` code `[also inline](memory/missing.md)` ``',
    '~~~markdown', '[fenced](memory/missing.md)', '~~~',
    '<!-- [comment](memory/missing.md) -->',
    '    [indented](memory/missing.md)',
    '[nested [label]](memory/nested.md)',
    '[present file](data.txt)',
  ].join('\r\n') + '\r\n'
  await f.put(sourceId, before)
  await f.put('memory/wiki/data.txt', 'keep')
  await f.put('memory/other.md', '[other source](memory/missing.md)')
  const report = await f.maintenance.scan()
  const nested = report.findings.find(finding => finding.label === 'nested [label]')!
  assert.equal(nested.repairable, false)
  assert.match(nested.message, /unsupported/)
  const preview = f.maintenance.preview(report.id, sourceId)
  assert.equal(preview.before, before)
  assert.equal(preview.findingIds.length, 5)
  const expected = before
    .replace('[first](memory/missing.md#anchor "title")', 'first')
    .replace('[second][gone]', 'second')
    .replace('[collapsed][]', 'collapsed')
    .replace('[shortcut] and', 'shortcut and')
    .replace('[escaped path](memory/a\\(b\\).md)', 'escaped path')
  assert.equal(preview.after, expected)
  assert.equal(await readFile(join(f.root, sourceId), 'utf8'), before)
  assert.deepEqual(f.maintenance.apply(report.id, sourceId, preview.revision), { updated: sourceId })
  assert.equal(await readFile(join(f.root, sourceId), 'utf8'), expected)
  assert.equal(await readFile(join(f.root, 'memory/other.md'), 'utf8'), '[other source](memory/missing.md)')
  assert.equal(existsSync(join(f.root, 'memory/missing.md')), false)
  assert.throws(() => f.maintenance.apply(report.id, sourceId, preview.revision), { status: 409 })
  assert.equal(f.maintenance.status().report?.id, report.id)
})

test('effective skill aliases and Markdown entities never turn existing resources into missing-link repairs', async t => {
  const f = await fixture(t)
  const content = '---\nname: helper\n---\n# Helper'
  await f.put('skills/different-directory/SKILL.md', content)
  f.skills.setSkill('helper', { ...parseSkillFile(content, 'helper'), dirPath: join(f.root, 'skills/different-directory') })
  await f.put('skills/different-directory/assets/file.txt', 'present')
  await f.put('memory/a&b.txt', 'present')
  await f.put('memory/AB.txt', 'present')
  await f.put('memory/topic.md', [
    '[skill resource](v:skills/helper/assets/file.txt)',
    '[entity](a&amp;b.txt)', '[numeric](A&#66;.txt)',
    '[unknown entity](a&copy;b.txt)', '[escaped entity](a\\&amp;b.txt)',
  ].join('\n'))
  const report = await f.maintenance.scan()
  assert.equal(report.findings.find(finding => finding.label === 'skill resource')?.target,
    'skills/different-directory/assets/file.txt')
  for (const label of ['skill resource', 'entity', 'numeric']) {
    assert.equal(report.findings.find(finding => finding.label === label)?.reason, 'outside-catalog')
  }
  for (const label of ['unknown entity', 'escaped entity']) {
    assert.equal(report.findings.find(finding => finding.label === label)?.reason, 'unavailable')
  }
  assert.ok(report.findings.every(finding => !finding.repairable))
  const graph = f.knowledge.catalog()
  assert.ok(graph.links.some(link => link.target === 'skills/different-directory/assets/file.txt'))
})

test('filesystem permission errors are unavailable, never confirmed missing', async t => {
  const f = await fixture(t)
  await f.put('memory/topic.md', '[restricted](restricted.bin)')
  const restricted = await f.put('memory/restricted.bin', 'not readable')
  const original = fs.lstatSync
  const mocked = t.mock.method(fs, 'lstatSync', (path: fs.PathLike, ...args: unknown[]) => {
    if (path === restricted) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
    return Reflect.apply(original, fs, [path, ...args])
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  const report = await f.maintenance.scan()
  assert.equal(report.findings[0]?.reason, 'unavailable')
  assert.equal(report.findings[0]?.repairable, false)
})

test('session memories, conventions, JSONL history, project skills, and builtins are never repairable', async t => {
  const f = await fixture(t)
  const link = '[missing](memory/gone.md)'
  const sources = ['memory/sessions/one.md', 'memory/agent.conventions.md', 'memory/projects/test/conventions.md']
  for (const id of sources) await f.put(id, link)
  await f.put('memory/events/2026-09-20.jsonl', '{"refs":["memory/gone.md"]}\n')
  await f.put('memory/sessions/one.files.jsonl', '{"path":"memory/gone.md"}\n')
  const project = '---\nname: project\nmetadata:\n  related: absent\n---\n' + link
  await f.put('skills/project/SKILL.md', project)
  await f.put('bundled/SKILL.md', link)
  const parsed = parseSkillFile(project, 'project')
  const skill = { ...parsed, dirPath: join(f.root, 'skills', 'project') }
  const builtin = { ...parseSkillFile(link, 'bundled'), dirPath: join(f.root, 'bundled') }
  t.mock.method(f.skills, 'availableSkillSources', () => [
    { source: 'project' as const, shadowsBuiltin: false, skill },
    { source: 'builtin' as const, shadowsBuiltin: false, skill: builtin },
  ])
  const report = await f.maintenance.scan()
  assert.equal(report.entriesScanned, 7)
  assert.ok(report.findings.length >= 7)
  assert.ok(report.findings.every(finding => !finding.repairable))
  for (const finding of report.findings) {
    assert.throws(() => f.maintenance.preview(report.id, finding.sourceId), { status: 409 })
  }
  for (const id of sources) assert.equal(await readFile(join(f.root, id), 'utf8'), link)
  assert.equal(await readFile(join(f.root, 'memory/events/2026-09-20.jsonl'), 'utf8'), '{"refs":["memory/gone.md"]}\n')
  assert.equal(await readFile(join(f.root, 'skills/project/SKILL.md'), 'utf8'), project)
  assert.equal(await readFile(join(f.root, 'bundled/SKILL.md'), 'utf8'), link)
})

test('source changes, deleted sources, stale reports, wrong revisions, and resurrected targets reject repairs', async t => {
  const f = await fixture(t)
  const sourceId = 'memory/topic.md'
  const before = '[missing](memory/gone.md)'
  await f.put(sourceId, before)
  let report = await f.maintenance.scan()
  let preview = f.maintenance.preview(report.id, sourceId)
  assert.throws(() => f.maintenance.apply(report.id, sourceId, '0'.repeat(64)), { status: 409 })
  await f.put(sourceId, before + '\nchanged')
  assert.throws(() => f.maintenance.preview(report.id, sourceId), { status: 409 })
  assert.throws(() => f.maintenance.apply(report.id, sourceId, preview.revision), { status: 409 })
  await f.put(sourceId, before)
  await f.put('memory/gone.md', '# Recreated target')
  assert.throws(() => f.maintenance.apply(report.id, sourceId, preview.revision), { status: 409 })
  await rm(join(f.root, 'memory/gone.md'))
  const old = report
  report = await f.maintenance.scan()
  assert.throws(() => f.maintenance.preview(old.id, sourceId), { status: 409 })
  preview = f.maintenance.preview(report.id, sourceId)
  await rm(join(f.root, sourceId))
  assert.throws(() => f.maintenance.apply(report.id, sourceId, preview.revision), { status: 409 })
  assert.equal(existsSync(join(f.root, sourceId)), false)
})

test('a target becoming unsafe after preview is a conflict, never permission to remove its link', async t => {
  const f = await fixture(t)
  await f.put('memory/topic.md', '[missing](memory/future/file.md)')
  const report = await f.maintenance.scan()
  const preview = f.maintenance.preview(report.id, 'memory/topic.md')
  await f.put('outside/file.md', 'outside')
  await symlink(join(f.root, 'outside'), join(f.root, 'memory/future'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => f.maintenance.apply(report.id, preview.sourceId, preview.revision), { status: 409 })
  assert.equal(await readFile(join(f.root, 'memory/topic.md'), 'utf8'), preview.before)
})

test('repair refuses linked source ancestors and invalid UTF-8 instead of replacing unrelated bytes', async t => {
  const f = await fixture(t)
  await f.put('memory/wiki/topic.md', '[missing](memory/gone.md)')
  let report = await f.maintenance.scan()
  const preview = f.maintenance.preview(report.id, 'memory/wiki/topic.md')
  await rename(join(f.root, 'memory/wiki'), join(f.root, 'old-wiki'))
  await symlink(join(f.root, 'old-wiki'), join(f.root, 'memory/wiki'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => f.maintenance.apply(report.id, preview.sourceId, preview.revision), { status: 409 })
  assert.equal(await readFile(join(f.root, 'old-wiki/topic.md'), 'utf8'), preview.before)
  await f.put('memory/raw.md', Buffer.concat([Buffer.from('[missing](memory/gone.md)'), Buffer.from([0xff])]))
  report = await f.maintenance.scan()
  assert.equal(report.findings.find(finding => finding.sourceId === 'memory/raw.md')?.repairable, false)
  assert.throws(() => f.maintenance.preview(report.id, 'memory/raw.md'), { status: 409 })
})

test('persisted immutable reports survive reinitialization and external report replacement invalidates previews', async t => {
  const f = await fixture(t)
  await f.put('memory/topic.md', '[missing](memory/gone.md)')
  const report = await f.maintenance.scan()
  const restarted = new KnowledgeMaintenanceService(f.root, f.skills)
  t.after(() => restarted.stop())
  await restarted.init()
  assert.deepEqual(restarted.status().report, report)
  const preview = restarted.preview(report.id, 'memory/topic.md')
  assert.equal(preview.before, '[missing](memory/gone.md)')
  await restarted.scan()
  assert.throws(() => f.maintenance.apply(report.id, preview.sourceId, preview.revision), { status: 409 })
})

test('corrupt reports are nonfatal at startup and recover only after preserving the original bytes', async t => {
  const f = await fixture(t)
  await f.put('memory/topic.md', '[missing](memory/gone.md)')
  await f.maintenance.scan()
  const path = join(f.root, '.knowledge-maintenance/report.json')
  const original = await readFile(path, 'utf8')
  const corrupt = JSON.parse(original)
  corrupt.report.findings[0].label = 'corrupted'
  await writeFile(path, JSON.stringify(corrupt))
  const reader = new KnowledgeMaintenanceService(f.root, f.skills)
  t.after(() => reader.stop())
  await reader.init()
  assert.match(reader.status().lastError!, /integrity/)
  assert.equal(reader.status().report, null)
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(corrupt))
  await reader.scan()
  const directory = join(f.root, '.knowledge-maintenance')
  const archives = (await readdir(directory)).filter(name => name.startsWith('report.invalid-'))
  assert.equal(archives.length, 1)
  assert.equal(await readFile(join(directory, archives[0]), 'utf8'), JSON.stringify(corrupt))
  assert.equal(reader.status().lastError, undefined)
  const invalidBytes = Buffer.from([0xff, 0xfe, 0x7b])
  await writeFile(path, invalidBytes)
  const syntaxReader = new KnowledgeMaintenanceService(f.root, f.skills)
  t.after(() => syntaxReader.stop())
  await syntaxReader.init()
  assert.match(syntaxReader.status().lastError!, /invalid JSON/)
  await syntaxReader.scan()
  const nextArchives = (await readdir(directory)).filter(name => name.startsWith('report.invalid-') && !archives.includes(name))
  assert.equal(nextArchives.length, 1)
  assert.deepEqual(await readFile(join(directory, nextArchives[0])), invalidBytes)
})

test('unsafe or unreadable maintenance storage does not prevent startup and remains blocked until corrected', async t => {
  const f = await fixture(t)
  await f.put('memory/topic.md', '[missing](memory/gone.md)')
  await f.maintenance.scan()
  const path = join(f.root, '.knowledge-maintenance/report.json')
  const original = fs.lstatSync
  const mocked = t.mock.method(fs, 'lstatSync', (file: fs.PathLike, ...args: unknown[]) => {
    if (file === path) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
    return Reflect.apply(original, fs, [file, ...args])
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  const unreadable = new KnowledgeMaintenanceService(f.root, f.skills)
  t.after(() => unreadable.stop())
  await unreadable.init()
  assert.match(unreadable.status().lastError!, /Permission denied/)
  assert.equal(unreadable.status().report, null)
  await assert.rejects(unreadable.scan(), { code: 'EACCES' })
  mocked.mock.restore()
  syncBuiltinESMExports()
  await unreadable.scan()
  assert.equal(unreadable.status().lastError, undefined)
  await rm(join(f.root, '.knowledge-maintenance'), { recursive: true })
  await mkdir(join(f.root, 'outside'))
  await symlink(join(f.root, 'outside'), join(f.root, '.knowledge-maintenance'), process.platform === 'win32' ? 'junction' : 'dir')
  const unsafe = new KnowledgeMaintenanceService(f.root, f.skills)
  t.after(() => unsafe.stop())
  await unsafe.init()
  assert.match(unsafe.status().lastError!, /Linked knowledge/)
  assert.equal(unsafe.status().report, null)
  await assert.rejects(unsafe.scan(), { status: 403 })
  assert.equal(existsSync(join(f.root, 'outside/report.json')), false)
  await rm(join(f.root, '.knowledge-maintenance'), { recursive: true })
  await unsafe.scan()
  assert.equal(unsafe.status().lastError, undefined)
})

test('scan/apply admission is serialized; cancellation and shutdown preserve the last report', async t => {
  const f = await fixture(t)
  await f.put('memory/topic.md', '[missing](memory/gone.md)')
  const first = await f.maintenance.scan()
  const preview = f.maintenance.preview(first.id, 'memory/topic.md')
  const pending = f.maintenance.scan()
  assert.equal(f.maintenance.status().scanning, true)
  assert.throws(() => f.maintenance.scan(), { status: 409 })
  assert.throws(() => f.maintenance.apply(first.id, preview.sourceId, preview.revision), { status: 409 })
  const cancellation = assert.rejects(pending, { name: 'AbortError' })
  await f.maintenance.stop()
  await cancellation
  assert.equal(f.maintenance.status().scanning, false)
  assert.deepEqual(f.maintenance.status().report, first)
  assert.throws(() => f.maintenance.scan(), { status: 503 })
  assert.equal(await readFile(join(f.root, 'memory/topic.md'), 'utf8'), preview.before)
})

test('failed or aborted scans do not overwrite a good report, and reference limits are explicit', async t => {
  const f = await fixture(t)
  await f.put('memory/topic.md', '[missing](memory/gone.md)')
  const good = await f.maintenance.scan()
  await f.put('memory/events/broken.jsonl', '{')
  await assert.rejects(f.maintenance.scan(), { status: 422 })
  assert.deepEqual(f.maintenance.status().report, good)
  assert.match(f.maintenance.status().lastError!, /Invalid JSONL/)
  await rm(join(f.root, 'memory/events/broken.jsonl'))
  await f.put('memory/too-many.md', '[a](#)\n'.repeat(KNOWLEDGE_LIMITS.links + 1))
  await assert.rejects(f.maintenance.scan(), { status: 413 })
  assert.deepEqual(f.maintenance.status().report, good)
  await rm(join(f.root, 'memory/too-many.md'))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.maintenance.scan(controller.signal), { name: 'AbortError' })
  assert.deepEqual(f.maintenance.status().report, good)
  await f.maintenance.scan()
  assert.equal(f.maintenance.status().lastError, undefined)
})

test('report size is bounded incrementally rather than allocating an unbounded repeated-title result', async t => {
  const f = await fixture(t)
  await f.put('memory/large-title.md', '# ' + 'h'.repeat(8192) + '\n' + '[missing](memory/absent.md)\n'.repeat(5000))
  await assert.rejects(f.maintenance.scan(), { status: 413 })
  assert.equal(f.maintenance.status().report, null)
  assert.equal(existsSync(join(f.root, '.knowledge-maintenance/report.json')), false)
})

test('maintenance routes are authorized, strictly validate payloads, and require server-owned previews', async t => {
  const f = await fixture(t)
  await f.put('memory/topic.md', '[missing](memory/gone.md)')
  const app = new Hono()
  registerKnowledgeRoutes(app, {
    workspace: f.root, skills: f.skills, maintenance: f.maintenance,
    authorize: request => request.headers.get('authorization') === 'owner-fixture',
  })
  const request = (suffix: string, method = 'GET', body?: unknown, authorized = true) =>
    app.request('/api/knowledge/maintenance' + suffix, {
      method, ...(body !== undefined && method !== 'GET' ? { body: JSON.stringify(body) } : {}),
      headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'owner-fixture' } : {}) },
    })
  for (const [path, method] of [['', 'GET'], ['/scan', 'POST'], ['/preview', 'POST'], ['/apply', 'POST']]) {
    assert.equal((await request(path, method, {}, false)).status, 401)
  }
  assert.equal((await request('')).status, 200)
  assert.equal((await request('/scan', 'POST', { extra: true })).status, 400)
  assert.equal((await request('/scan', 'POST', 'x'.repeat(4097))).status, 413)
  assert.equal((await request('/preview', 'POST', { reportId: 'bad', sourceId: '../outside' })).status, 400)
  const scan = await request('/scan', 'POST', {})
  assert.equal(scan.status, 200)
  const report = await scan.json()
  const identity = { reportId: report.id, sourceId: 'memory/topic.md' }
  assert.equal((await request('/preview', 'POST', { ...identity, sourceId: 'memory/../outside.md' })).status, 400)
  const previewResponse = await request('/preview', 'POST', identity)
  assert.equal(previewResponse.status, 200)
  const preview = await previewResponse.json()
  assert.equal((await request('/apply', 'POST', { ...identity, revision: preview.revision, after: 'client patch' })).status, 400)
  assert.equal((await request('/apply', 'POST', { ...identity, revision: '0'.repeat(64) })).status, 409)
  const applied = await request('/apply', 'POST', { ...identity, revision: preview.revision })
  assert.equal(applied.status, 200)
  assert.deepEqual(await applied.json(), { updated: 'memory/topic.md' })
  assert.equal(await readFile(join(f.root, 'memory/topic.md'), 'utf8'), 'missing')
  const disabled = new Hono()
  registerKnowledgeRoutes(disabled, { workspace: f.root, skills: f.skills, authorize: () => true })
  assert.equal((await disabled.request('/api/knowledge/maintenance')).status, 503)
  assert.equal((await disabled.request('/api/knowledge')).status, 200)
})

test('the common Markdown parser preserves exact source positions and ignores escaped syntax', () => {
  const text = [
    '---', 'description: "[frontmatter](memory/ignore.md)"', '---',
    '\\[escaped](memory/ignore.md) [real](memory/a\\(b\\).md "title")',
    '![image [nested]](memory/ignore.md) [reference][Ref]',
    '[Ref]: <memory/reference target.md> "title"',
    '``[inline ` code](memory/ignore.md)``',
    '```', '[fence](memory/ignore.md)', '```',
    '<!-- [comment](memory/ignore.md) -->',
    '<code>[html code](memory/ignore.md)</code>',
    '<span title="[attribute](memory/ignore.md)">label</span>',
  ].join('\n')
  const refs = markdownReferenceSpans(text)
  assert.deepEqual(refs.map(ref => ref.target), ['memory/a(b).md', 'memory/reference target.md'])
  assert.deepEqual(refs.map(ref => text.slice(ref.start, ref.end)),
    ['[real](memory/a\\(b\\).md "title")', '[reference][Ref]'])
})
