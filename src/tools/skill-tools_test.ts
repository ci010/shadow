import assert from 'node:assert/strict'
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { EventEmitter, once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { SkillsManager, type SkillMeta } from '../skills/loader.ts'
import { parseSkillFile } from '../skills/parse.ts'
import type { SkillToolDeclarations } from '../skills/tool-declarations.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import type { ExecutionContext } from './context.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { ReadTool } from './read.ts'
import { SearchTool } from './search.ts'
import { Tools, SessionTools } from './registry.ts'

function setup(home: string) {
  const skills = new SkillsManager(home)
  const loader = new ImportTool(new Map(), home, undefined, name => skills.getSkillDirectory(name))
  const vfs = new VirtualFs()
  vfs.mount('v:skills', 'Skills', createSkillsHandler(skills, (skill, ctx) => loader.registerSkillTools(skill, ctx)).read)
  const base = new Tools(home)
  base.register(new ReadTool(home, vfs))
  base.register(new InvokeTool(loader))
  base.register(new SearchTool(home, undefined, vfs, loader, skills))
  const session = new SessionTools(base, home)
  const context: ExecutionContext = {
    projectId: 'fixture', sessionId: 'fixture', physicalSessionId: 'fixture-0',
    channel: 'test', messageId: 'test', senderId: 'test', chatId: 'test',
    tools: session, signal: new AbortController().signal, cwd: home,
  }
  const read = (path: string, ctx = context) => ctx.tools.execute('read', { path }, ctx)
  const invoke = (name: string, args: Record<string, unknown> = { value: 'value' }, ctx = context) =>
    ctx.tools.execute('invoke_tool', { name, args }, ctx)
  return { skills, loader, vfs, base, session, context, read, invoke }
}

async function addSkill(home: string, skills: SkillsManager, name: string, tools: SkillToolDeclarations, extra: Partial<SkillMeta> = {}) {
  const dir = join(home, 'skills', name)
  await mkdir(join(dir, 'tools'), { recursive: true })
  const manifest = `---\n${JSON.stringify({ name, description: `Useful ${name} tools`, tools, ...extra })}\n---\nCall the declared tools with {value: string}. Unique body text: spreadsheets.`
  await writeFile(join(dir, 'SKILL.md'), manifest)
  skills.setSkill(name, { ...parseSkillFile(manifest, name), dirPath: dir })
  return dir
}

const moduleText = (prefix: string) => `
export const name = 'exported'
export const description = 'Synthetic string tool'
export const parameters = {type:'object',properties:{value:{type:'string'}},required:['value']}
let initValue = ''
export function init(args) {initValue = args[0]}
export async function execute(args) {return initValue + ${JSON.stringify(prefix)} + args.value}
`

test('read skill registers multiple aliases without importing code; direct invoke validates schema and initializes lazily', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', {
      csv_summary: { source: 'tools/summary.ts', args: ['init:'] },
      csv_format: { source: 'tools/format.ts' },
    })
    const marker = join(home, 'loaded')
    await writeFile(join(dir, 'tools', 'summary.ts'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded');\n${moduleText('summary:')}`)
    await writeFile(join(dir, 'tools', 'format.ts'), moduleText('format:'))
    assert.match(await f.invoke('csv_summary'), /could not be imported/)
    const result = await f.read('v:skills/csv')
    assert.match(result, /Registered for this session: csv_summary, csv_format/)
    await assert.rejects(access(marker), { code: 'ENOENT' })
    assert.equal(f.session.hasDynamic('csv_summary'), false)
    assert.match(f.loader.readCatalog('', f.session), /"skill":"csv"/)
    assert.equal(await f.invoke('csv_summary'), 'init:summary:value')
    assert.equal(await f.invoke('csv_format'), 'format:value')
    assert.match(await f.invoke('csv_summary', { value: 7 }), /no tool was executed/)
    assert.deepEqual(f.session.names(), ['read', 'invoke_tool', 'search'])
    await assert.rejects(access(join(home, 'project-config.json')), { code: 'ENOENT' })
    f.session.resetDynamic()
  })
})

test('skill search, category listing and bundled resource reads do not register tools', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } }, { category: 'data' })
    await writeFile(join(dir, 'tools', 'summary.ts'), moduleText('summary:'))
    const searched = JSON.parse(await f.session.execute('search', { space: 'skills:', query: 'spreadsheets' }, f.context))
    assert.equal(searched.activation, 'none')
    assert.equal(searched.skills[0].path, 'v:skills/csv')
    assert.deepEqual(searched.skills[0].toolNames, ['csv_summary'])
    await f.read('v:skills')
    await f.read('v:skills/data')
    await f.read('v:skills/csv/tools/summary.ts')
    await f.read('v:skills/csv/SKILL.md')
    assert.match(await f.invoke('csv_summary'), /could not be imported/)
    assert.doesNotMatch(f.loader.readCatalog('', f.session), /csv_summary/)
    await f.read('v:skills/csv')
    assert.equal(await f.invoke('csv_summary'), 'summary:value')
    f.session.resetDynamic()
  })
})

test('registrations are session-local, reset on sleep, and never restored merely from the skill declaration', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } })
    await writeFile(join(dir, 'tools', 'summary.ts'), moduleText('summary:'))
    await f.read('v:skills/csv')
    assert.equal(await f.invoke('csv_summary'), 'summary:value')
    const borrowed = f.session.snapshot()
    const other = new SessionTools(f.base, home)
    assert.match(await f.invoke('csv_summary', {}, { ...f.context, tools: other }), /could not be imported/)
    f.session.resetDynamic()
    assert.equal(borrowed.hasDynamic('csv_summary'), false)
    assert.match(await f.invoke('csv_summary'), /could not be imported/)
    assert.doesNotMatch(f.loader.readCatalog('', f.session), /csv_summary/)
    await f.read('v:skills/csv')
    assert.equal(await f.invoke('csv_summary'), 'summary:value')
    const restarted = setup(home)
    restarted.skills.setSkill('csv', f.skills.getSkill('csv')!)
    assert.match(await restarted.invoke('csv_summary'), /could not be imported/)
    f.session.resetDynamic()
  })
})

test('re-reading replaces changed declarations and sources, invalidates borrowed aliases, and removes dropped tools', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } })
    await writeFile(join(dir, 'tools', 'summary.ts'), moduleText('original:'))
    await f.read('v:skills/csv')
    assert.equal(await f.invoke('csv_summary'), 'original:value')
    const borrowed = f.session.snapshot()
    await f.read('v:skills/csv')
    assert.equal(borrowed.hasDynamic('csv_summary'), true)
    await writeFile(join(dir, 'tools', 'summary.ts'), moduleText('changed-longer:'))
    await f.read('v:skills/csv')
    assert.equal(borrowed.hasDynamic('csv_summary'), false)
    assert.equal(await f.invoke('csv_summary'), 'changed-longer:value')
    await addSkill(home, f.skills, 'csv', {})
    await f.read('v:skills/csv')
    assert.match(await f.invoke('csv_summary'), /could not be imported/)
  })
})

test('registration is atomic across declarations and cannot overwrite base, catalog or another skill tools', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', { owned: { source: 'tools/one.ts' } })
    await writeFile(join(dir, 'tools', 'one.ts'), moduleText('owned:'))
    await f.read('v:skills/csv')
    const other = await addSkill(home, f.skills, 'other', { unique: { source: 'tools/one.ts' }, owned: { source: 'tools/one.ts' } })
    await writeFile(join(other, 'tools', 'one.ts'), moduleText('other:'))
    assert.match(await f.read('v:skills/other'), /conflicts/)
    assert.match(await f.invoke('unique'), /could not be imported/)
    assert.equal(await f.invoke('owned'), 'owned:value')
    await assert.rejects(f.loader.updateMcpServers([{ name: 'owned', transport: 'stdio', command: 'synthetic' }]), /conflicts/)
    assert.equal(await f.invoke('owned'), 'owned:value')
    await addSkill(home, f.skills, 'other', { read: { source: 'tools/one.ts' } })
    assert.match(await f.read('v:skills/other'), /conflicts/)
    await f.loader.updateMcpServers([{ name: 'catalog', transport: 'stdio', command: 'synthetic' }])
    await addSkill(home, f.skills, 'other', { catalog: { source: 'tools/one.ts' } })
    assert.match(await f.read('v:skills/other'), /conflicts/)
    f.session.resetDynamic()
  })
})

test('entrypoints cannot escape the skill by traversal or directory symlink, and missing owners fail at invocation', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', { escape: { source: '../../outside.ts' } })
    await writeFile(join(home, 'outside.ts'), moduleText('outside:'))
    assert.match(await f.read('v:skills/csv'), /inside their owning skill/)
    const outside = join(home, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'tool.ts'), moduleText('outside:'))
    await symlink(outside, join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await addSkill(home, f.skills, 'csv', { escape: { source: 'linked/tool.ts' } })
    assert.match(await f.read('v:skills/csv'), /symlinks/)
    await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } })
    await writeFile(join(dir, 'tools', 'summary.ts'), moduleText('summary:'))
    await f.read('v:skills/csv')
    f.skills.removeSkill('csv')
    assert.match(await f.invoke('csv_summary'), /Skill.*not found/)
    await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } })
    assert.equal(await f.invoke('csv_summary'), 'summary:value')
    await rm(join(dir, 'SKILL.md'))
    assert.match(await f.invoke('csv_summary'), /ENOENT/)
    f.session.resetDynamic()
  })
})

test('admin, agent-role and remote restrictions cannot be bypassed by skill registration or invocation', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'private', { secret_tool: { source: 'tools/tool.ts' } }, { admin: true, category: 'hidden' })
    await writeFile(join(dir, 'tools', 'tool.ts'), moduleText('private:'))
    assert.doesNotMatch(await f.read('v:skills'), /private/)
    assert.match(await f.read('v:skills/private'), /Unknown/)
    assert.match(await f.read('v:skills/hidden'), /Unknown/)
    const normal = JSON.parse(await f.session.execute('search', { space: 'skills:', query: '' }, f.context))
    assert.equal(normal.skills.length, 0)
    const admin = { ...f.context, admin: true }
    await f.read('v:skills/private', admin)
    assert.equal(await f.invoke('secret_tool', { value: 'value' }, admin), 'private:value')
    assert.match(await f.invoke('secret_tool'), /admin/)
    const restricted = new SessionTools(f.base, home, ['read', 'search'])
    assert.match(await f.read('v:skills/private', { ...admin, tools: restricted }), /not available/)
    const remote = { ...admin, remoteWorkdir: {
      nodeId: 'remote', capabilityId: 'opaque', get executor(): never { throw new Error('Must not access remote executor') },
    } }
    assert.match(await f.read('v:skills/private', remote), /local workdir/)
    assert.match(await f.invoke('secret_tool', {}, remote), /remote workdirs/)
    f.session.resetDynamic()
  })
})

test('malformed frontmatter tools are discoverable as errors without disabling healthy skills', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = join(home, 'skills', 'invalid')
    await mkdir(dir, { recursive: true })
    const text = '---\nname: invalid\ntools:\n  wrong: {source: /absolute.ts}\n---\nInvalid tool'
    await writeFile(join(dir, 'SKILL.md'), text)
    f.skills.setSkill('invalid', { ...parseSkillFile(text, 'invalid'), dirPath: dir })
    await addSkill(home, f.skills, 'healthy', {})
    const result = JSON.parse(await f.session.execute('search', { space: 'skills:' }, f.context))
    assert.equal(result.totalMatches, 2)
    assert.match(result.skills.find((skill: { name: string }) => skill.name === 'invalid').toolsError, /relative/)
    assert.match(await f.read('v:skills/invalid'), /Invalid tools/)
    assert.match(await f.read('v:skills/healthy'), /declared tools/)
  })
})

test('skill search supports deterministic pagination, category, ranking and strict bounds without loading modules', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    for (const name of ['csv', 'beta', 'alpha']) await addSkill(home, f.skills, name, {}, { category: name === 'csv' ? 'data' : 'misc' })
    const search = (args: Record<string, unknown>) => f.session.execute('search', args, f.context)
    const first = JSON.parse(await search({ space: 'skills:', limit: 2 }))
    assert.deepEqual(first.skills.map((skill: { name: string }) => skill.name), ['alpha', 'beta'])
    assert.equal(first.nextOffset, 2)
    assert.equal(JSON.parse(await search({ space: 'skills:', offset: 2 })).skills[0].name, 'csv')
    assert.equal(JSON.parse(await search({ space: 'skills:data', query: 'csv' })).totalMatches, 1)
    assert.equal(JSON.parse(await search({ space: 'skills:', query: 'no-match' })).totalMatches, 0)
    assert.equal(JSON.parse(await search({ space: 'skills:', offset: 100 })).hasMore, false)
    for (const args of [{ query: null }, { query: 'x'.repeat(501) }, { limit: null }, { limit: 21 }, { offset: -1 }, { offset: 0.5 }]) {
      assert.match(await search({ space: 'skills:', ...args }), /^Error:/)
    }
    assert.equal(f.session.activeDynamicTools().length, 0)
  })
})

test('skill tools can lazily compose sibling tools after a single skill read', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', { first: { source: 'tools/one.ts' }, second: { source: 'tools/two.ts' } })
    await writeFile(join(dir, 'tools', 'one.ts'), `
export const name='one'; export const description='Compose';
export const parameters={type:'object',properties:{}};
export async function execute(_,callTool){return await callTool('second',{value:'nested'})}
`)
    await writeFile(join(dir, 'tools', 'two.ts'), moduleText('second:'))
    await f.read('v:skills/csv')
    assert.equal(await f.invoke('first', {}), 'second:nested')
    f.session.resetDynamic()
  })
})

test('sleep during module initialization cannot reactivate a skill tool', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', { waiting: { source: 'tools/wait.ts', args: ['wait'] } })
    const start = `skill-start-${randomUUID()}`
    const release = `skill-release-${randomUUID()}`
    await writeFile(join(dir, 'tools', 'wait.ts'), `
import {once} from 'node:events';
export const name='wait'; export const description='Controlled initialization';
export const parameters={type:'object',properties:{}};
export async function init(){process.emit(${JSON.stringify(start)});await once(process,${JSON.stringify(release)})}
export async function execute(){return 'obsolete'}
`)
    await f.read('v:skills/csv')
    const entered = once(process, start, { signal: AbortSignal.timeout(10_000) })
    const pending = f.loader.importForInvocation('waiting', f.session)
    try {
      await entered
      f.session.resetDynamic()
    } finally {
      EventEmitter.prototype.emit.call(process, release)
    }
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(f.session.hasDynamic('waiting'), false)
    assert.match(await f.invoke('waiting', {}), /could not be imported/)
    assert.match(await readFile(join(dir, 'SKILL.md'), 'utf8'), /waiting/)
  })
})
