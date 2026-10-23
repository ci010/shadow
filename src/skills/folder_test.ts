import { EvalBridgeRuntime } from '../script-runtime/bridge.ts'
import { createProjectScope } from '../projects/scope.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { SkillsManager } from './loader.ts'
import { parseSkillFile } from './parse.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { ReadTool } from '../tools/read.ts'
import { SearchTool } from '../tools/search.ts'
import { UseProjectTool } from '../tools/use-project.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import { requireToolText } from '../tools/tool.ts'
import type { ExecutionContext } from '../tools/context.ts'

test('switching selects folder skill discovery, resources and lazy activation without replacing Project skills', async () => {
  await withTempWorkspace(async home => {
    const folders = new FolderRegistry(home); await folders.init()
    for (const name of ['app', 'docs']) {
      const dir = join(home, name, '.agents', 'skills', `${name}-guide`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), `---\n${JSON.stringify({ name: `${name}-guide`, description: `${name} scoped skill`, tools: { [`${name}_tool`]: { source: 'tool.ts', description: 'fixture', parameters: { type: 'object', properties: {} }, imports: ['node:fs'] } } })}\n---\n${name} body`)
      await writeFile(join(dir, 'reference.md'), `${name} resource`)
      await writeFile(join(dir, 'tool.ts'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(home, `${name}-executed`))}, 'yes'); export function run() { return '${name} result' }`)
      await folders.register(join(home, name))
    }
    const skills = new SkillsManager(home)
    const globalDir = join(home, 'global-guide'); await mkdir(globalDir)
    const globalBody = '---\nname: global-guide\ndescription: Project guide\n---\nGlobal body'
    await writeFile(join(globalDir, 'SKILL.md'), globalBody)
    skills.setSkill('global-guide', { ...parseSkillFile(globalBody, 'global-guide'), dirPath: globalDir })
    const overlapDir = join(home, 'app-guide'); await mkdir(overlapDir)
    const overlap = `---\n${JSON.stringify({ name: 'app-guide', description: 'Global same-name skill', tools: { global_app: { source: 'tool.ts', description: 'global', parameters: { type: 'object', properties: {} }, imports: [] } } })}\n---\nGlobal overlapping body`
    await writeFile(join(overlapDir, 'SKILL.md'), overlap)
    await writeFile(join(overlapDir, 'tool.ts'), "export function run() { return 'global app result' }")
    skills.setSkill('app-guide', { ...parseSkillFile(overlap, 'app-guide'), dirPath: overlapDir })
    const loader = new ImportTool(new Map(), home, undefined, name => skills.getSkillDirectory(name))
    let selected: { folderId: string; path: string } | undefined
    const vfs = new VirtualFs()
    const handlers = createSkillsHandler(skills, (skill, ctx) => loader.registerSkillTools(skill, ctx), () => selected)
    vfs.mount('v:skills', 'Skills', handlers.read, handlers.list)
    const base = new Tools(home)
    base.register(new ReadTool(home, vfs)); base.register(new InvokeTool(loader)); base.register(new SearchTool(home, undefined, vfs))
    const tools = new SessionTools(base, home)
    const ctx = { projectId: 'p', evalBridge: new EvalBridgeRuntime({ projectId: 'p', scope: createProjectScope('p') }), sessionId: 'fixture', physicalSessionId: 'fixture-0', channel: 'test', chatId: 'fixture', senderId: 'test', messageId: 'test',
      tools, signal: new AbortController().signal, toolCallName: 'use_project',
      switchProjectFolder: async prepared => { const folder = folders.get(prepared.folderId)!; selected = { folderId: folder.id, path: folder.path }; ctx.folderId = folder.id; ctx.cwd = folder.path; return prepared.content },
    } as ExecutionContext
    const switcher = new UseProjectTool({ projectId: 'p', folders, switched: ctx => loader.clearFolderSkillTools(ctx.tools) })
    const read = async (path: string) => requireToolText(await tools.execute('read', { path }, ctx))
    const invoke = async (name: string, context = ctx) => requireToolText(await context.tools.execute('invoke_tool', { name, args: {} }, context))
    try {
      assert.equal(new ReadTool(home).readonly({ path: 'v:skills/folder/app-guide' }), false)
      assert.equal(new ReadTool(home).readonly({ path: 'v:skills/folder' }), true)
      await read('v:skills/app-guide')
      assert.equal(await invoke('global_app'), 'global app result')
      const app = await switcher.execute({ folder: 'app' }, ctx)
      assert.match(app, /v:skills\/folder\/app-guide/)
      assert.doesNotMatch(app, /global-guide|Global same-name skill|available_skills/)
      assert.doesNotMatch(app, /app body/)
      assert.doesNotMatch(app, /docs-guide/)
      const index = await read('v:skills')
      assert.match(index, /global-guide/); assert.match(index, /app-guide/); assert.doesNotMatch(index, /docs-guide/)
      const search = requireToolText(await tools.execute('search', { handler: 'grep', path: 'v:skills/folder', query: 'app body' }, ctx))
      assert.match(search, /folder\/app-guide/)
      assert.equal(await read('v:skills/folder/app-guide/reference.md'), 'app resource')
      assert.doesNotMatch(loader.readCatalog('', tools), /app_tool/)
      assert.match(await read('v:skills/folder/app-guide'), /Registered for this session: app_tool/)
      await assert.rejects(access(join(home, 'app-executed')), { code: 'ENOENT' })
      assert.equal(await invoke('app_tool'), 'app result')
      const captured = { ...ctx, tools: tools.snapshot() }
      const docs = await switcher.execute({ folder: 'docs' }, ctx)
      assert.match(docs, /docs-guide/); assert.doesNotMatch(docs, /app-guide/)
      assert.doesNotMatch(await read('v:skills/folder'), /app-guide/)
      assert.equal(await invoke('global_app'), 'global app result', 'same-name Project skills survive folder activation and switching')
      assert.match(await read('v:skills/folder/app-guide'), /Unknown selected-folder skill/)
      assert.doesNotMatch(loader.readCatalog('', tools), /app_tool/)
      assert.match(await invoke('app_tool'), /could not be imported/)
      assert.equal(await invoke('app_tool', captured), 'app result', 'captured child tools retain their original scope')
      assert.equal(await read('v:skills/global-guide'), 'Global body')
      await read('v:skills/folder/docs-guide')
      await assert.rejects(access(join(home, 'docs-executed')), { code: 'ENOENT' })
      assert.equal(await invoke('docs_tool'), 'docs result')
    } finally { tools.resetDynamic() }
  })
})
