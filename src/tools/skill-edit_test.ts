import { requireToolText } from './tool.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import assert from 'node:assert/strict'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { getBuiltinAgentTypes } from '../agent/types/builtins.ts'
import { SkillEditStore } from '../skills/edit-store.ts'
import { SkillsManager } from '../skills/loader.ts'
import { createProjectScope } from '../projects/scope.ts'
import { EvalBridgeRuntime } from '../script-runtime/bridge.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import type { ExecutionContext } from './context.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { ReadTool } from './read.ts'
import { SessionTools, Tools } from './registry.ts'
import { SkillEditing, SkillReadTool, SkillSaveTool } from './skill-edit.ts'

const manifest = (body: string) => `---\nname: learned\nlearnedAt: 2026-01-01\n---\n${body}`

function setup(home: string) {
  const skills = new SkillsManager(home)
  const editing = new SkillEditing({
    projectId: 'p', skills, store: new SkillEditStore(home, skills),
    canEdit: id => id.startsWith('web:'),
  })
  const base = new Tools(home)
  const evalBridge = new EvalBridgeRuntime({ projectId: 'p', scope: createProjectScope('p') })
  const importer = new ImportTool(new Map(), home, undefined, name => skills.getSkillDirectory(name))
  const vfs = new VirtualFs()
  vfs.mount('v:skills', 'Skills', createSkillsHandler(skills, (skill, context) => importer.registerSkillTools(skill, context)).read)
  for (const tool of [new SkillReadTool(editing), new SkillSaveTool(editing)]) {
    base.register(tool)
    importer.registerBuiltin(tool.name, tool)
  }
  base.register(new InvokeTool(importer))
  base.register(new ReadTool(home, vfs))
  const context = (id: string, tools = new SessionTools(base, home)): ExecutionContext => ({
    projectId: 'p', sessionId: id, physicalSessionId: `${id}-0`, tools,
    channel: 'web', chatId: id, senderId: 'user', messageId: 'input',
    signal: new AbortController().signal, cwd: home, evalBridge,
  })
  const invoke = (ctx: ExecutionContext, name: string, args: Record<string, unknown>) =>
    ctx.tools.execute('invoke_tool', { name, args }, ctx)
  return { skills, editing, base, importer, context, invoke }
}

test('ordinary Skills save directly; hidden baselines detect other sessions and external writes', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const a = f.context('web:a')
    const b = f.context('web:b')
    assert.deepEqual(a.tools.names(), ['invoke_tool', 'read'])
    const saved = JSON.parse(requireToolText(await f.invoke(a, 'skill_save', { name: 'learned', files: { 'SKILL.md': manifest('First') } })))
    assert.equal(saved.status, 'saved')
    assert.equal('revision' in saved, false)
    assert.match(requireToolText(await f.invoke(b, 'skill_save', { name: 'learned', files: { 'SKILL.md': manifest('B') } })), /Read the existing Skill/)
    const read = JSON.parse(requireToolText(await f.invoke(b, 'skill_read', { name: 'learned' })))
    assert.equal(read.content, manifest('First'))
    assert.equal('revision' in read, false)
    assert.match(requireToolText(await f.invoke(a, 'skill_save', { name: 'learned', files: { 'SKILL.md': manifest('Second') } })), /"saved"/)
    assert.match(requireToolText(await f.invoke(b, 'skill_save', { name: 'learned', files: { 'SKILL.md': manifest('Stale') } })), /conflict|changed|stale/i)
    assert.equal(f.skills.getSkill('learned')?.body, 'Second')
    await f.invoke(b, 'skill_read', { name: 'learned' })
    await writeFile(projectStoragePath(home, 'skills', 'learned', 'SKILL.md'), manifest('External'))
    assert.match(requireToolText(await f.invoke(b, 'skill_save', { name: 'learned', files: { 'SKILL.md': manifest('Stale again') } })), /conflict|changed|stale/i)
    assert.equal(await readFile(projectStoragePath(home, 'skills', 'learned', 'SKILL.md'), 'utf8'), manifest('External'))
    a.tools.resetDynamic()
    b.tools.resetDynamic()
  })
})

test('administrator can edit tool-bearing Skills without activating or executing their tools', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const role = (await getBuiltinAgentTypes()).find(role => role.name === 'general')!
    const administrator = f.context('web:chat-admin', new SessionTools(f.base, home, role.allowedTools))
    const text = `---\nname: learned\ntools:\n  learned_tool:\n    source: tools/run.ts\n    description: Synthetic tool\n    parameters: {type: object, properties: {}}\n---\nUse learned_tool.`
    assert.match(requireToolText(await f.invoke(administrator, 'skill_save', {
      name: 'learned', files: { 'SKILL.md': text, 'tools/run.ts': 'export function run() { return "fixture" }' },
    })), /"saved"/)
    const raw = JSON.parse(requireToolText(await f.invoke(administrator, 'skill_read', { name: 'learned' })))
    assert.equal(raw.content, text)
    assert.deepEqual(raw.files, ['SKILL.md', 'tools/run.ts'])
    assert.equal(administrator.tools.has('invoke_tool'), true)
    assert.equal(administrator.tools.has('write'), false)
    assert(!administrator.tools.activeDynamicTools().some(tool => tool.name === 'learned_tool'))
    const user = f.context('web:user')
    assert.match(requireToolText(await f.invoke(user, 'learned_tool', {})), /could not be imported/)
    await user.tools.execute('read', { path: 'v:skills/learned' }, user)
    assert.equal(await f.invoke(user, 'learned_tool', {}), 'fixture')
    user.tools.resetDynamic()
  })
})

test('editing rejects project, role, remote, temporary, malformed and aborted requests', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const current = f.context('web:topic')
    const args = { name: 'learned', files: { 'SKILL.md': manifest('Fixture') } }
    await assert.rejects(f.editing.save(args, { ...current, projectId: 'other' }), /durable local/)
    await assert.rejects(f.editing.save(args, { ...current, sessionId: 'managed:bot' }), /durable local/)
    await assert.rejects(f.editing.save(args, {
      ...current, remoteWorkdir: { nodeId: 'remote', capabilityId: 'folder',
        get executor(): never { throw new Error('Must not access remote executor') } },
    }), /durable local/)
    const call = f.context('web:call')
    call.tools.setExecutionScope('call', ['call'])
    await assert.rejects(f.editing.save(args, call), /durable local/)
    const task = f.context('web:task')
    task.tools.setExecutionScope('task', ['task', 'call'])
    await assert.rejects(f.editing.save(args, task), /durable local/)
    const restricted = f.context('web:restricted', new SessionTools(f.base, home, undefined, ['skill_save']))
    assert.match(requireToolText(await f.invoke(restricted, 'skill_save', args)), /not available|not allowed|could not be imported/i)
    await assert.rejects(f.editing.save({ ...args, revision: 'opaque' }, current), /unrecognized|Unrecognized/)
    await assert.rejects(f.editing.save({ ...args, files: {} }, current), /at least one/)
    await assert.rejects(f.editing.save(args, { ...current, signal: AbortSignal.abort() }), /abort/i)
    assert.equal(f.skills.getSkill('learned'), undefined)
    current.tools.resetDynamic()
  })
})

test('raw Skill reads paginate and missing baselines cannot overwrite a newly created Skill', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const a = f.context('web:a')
    const b = f.context('web:b')
    const missing = JSON.parse(f.editing.read({ name: 'learned' }, a))
    assert.equal(missing.source, 'missing')
    await f.editing.save({ name: 'learned', files: { 'SKILL.md': manifest('X'.repeat(9000)) } }, b)
    await assert.rejects(f.editing.save({ name: 'learned', files: { 'SKILL.md': manifest('A') } }, a), /conflict|changed|stale/i)
    const first = JSON.parse(f.editing.read({ name: 'learned', limit: 10 }, a))
    const second = JSON.parse(f.editing.read({ name: 'learned', offset: first.nextOffset, limit: 10 }, a))
    assert.equal(first.content + second.content, manifest('X'.repeat(9000)).slice(0, 20))
    assert.throws(() => f.editing.read({ name: 'learned', path: '../outside' }, a), /does not exist/)
    assert.throws(() => f.editing.read({ name: 'learned', offset: 10000 }, a), /Offset exceeds/)
    await f.editing.save({ name: 'learned', files: { 'SKILL.md': manifest('Updated') } }, b)
    assert.throws(() => f.editing.read({ name: 'learned', offset: first.nextOffset }, a), /changed between reads/)
    f.editing.read({ name: 'learned' }, a)
    a.tools.resetDynamic()
    await assert.rejects(f.editing.save({ name: 'learned', files: { 'SKILL.md': manifest('After sleep') } }, a), /Read the existing Skill/)
  })

})

test('a Skill whose manifest was deleted can be restored without losing retained resources', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const a = f.context('web:restore')
    await f.editing.save({ name: 'learned', files: { 'SKILL.md': manifest('First'), 'notes.txt': 'Preserved' } }, a)
    await unlink(projectStoragePath(home, 'skills', 'learned', 'SKILL.md'))
    f.skills.forgetSkillDirectory(projectStoragePath(home, 'skills', 'learned'))
    const current = JSON.parse(f.editing.read({ name: 'learned' }, a))
    assert.equal(current.content, null)
    assert.deepEqual(current.files, ['notes.txt'])
    await f.editing.save({ name: 'learned', files: { 'SKILL.md': manifest('Restored') } }, a)
    assert.equal(f.skills.getSkill('learned')?.body, 'Restored')
    assert.equal(await readFile(projectStoragePath(home, 'skills', 'learned', 'notes.txt'), 'utf8'), 'Preserved')
  })
})
