import assert from 'node:assert/strict'
import test from 'node:test'
import { getBuiltinAgentTypes } from '../agent/types/builtins.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { ReadTool } from '../tools/read.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { SearchTool } from '../tools/search.ts'
import { requireToolText } from '../tools/tool.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { getBuiltinSkills } from './builtins.ts'
import { SkillsManager } from './loader.ts'

test('Project knowledge Skill describes memory/Wiki aliases and retains persistence and safety rules', async () => {
  const skill = (await getBuiltinSkills()).get('project-knowledge')
  assert(skill)
  assert.match(skill.meta.description, /memory, Wiki, knowledge bases, remembering facts/)
  assert.equal(skill.meta.admin, false)
  assert.equal(skill.meta.tools, undefined, 'Knowledge guidance must not declare executable tools')
  for (const rule of [
    /canonical tool path is `v:memory\/`/,
    /`v:wiki` is not a mounted path/,
    /"Wiki, not Memory".*selects shared knowledge pages/,
    /empty listing or no matches.*not that Wiki access is/s,
    /Remote workdir sessions cannot write Project memory/,
    /Reading this Skill grants no permissions/,
    /coordinator may read\/search Wiki but cannot write/,
    /active `session` tool can create durable peer conversations/,
    /empty subagent delegation-mode list forbids temporary task\/call spawning/,
    /Tell the worker to read this Skill/,
    /Read back every created\/updated page/,
    /Files survive restarts; mental notes do not/,
    /explicit "remember this" requests/,
    /Stable personal preferences belong in the identified user profile/,
    /Temporary reply.*stay in conversation/s,
    /Record mistakes and lessons/,
    /use Markdown links.*not bare code spans/s,
    /fix write-validation issues reported by tools/,
    /external Wiki is a different target/,
  ]) assert.match(skill.body, rule)
})

test('coordinator can discover and read the instruction-only knowledge Skill without gaining worker tools', async () => {
  await withTempWorkspace(async home => {
    const skills = new SkillsManager(home)
    await skills.load()
    const vfs = new VirtualFs()
    const handlers = createSkillsHandler(skills)
    vfs.mount('v:skills', 'Skill instructions', handlers.read, handlers.list)
    const base = new Tools(home)
    base.register(new ReadTool(home, vfs))
    base.register(new SearchTool(home, undefined, vfs))
    const coordinator = (await getBuiltinAgentTypes()).find(agent => agent.name === 'orchestrator')
    assert(coordinator)
    const tools = new SessionTools(base, home, coordinator.allowedTools, coordinator.blockedTools)
    const context: ExecutionContext = {
      projectId: 'fixture', sessionId: 'web:orchestrator', physicalSessionId: 'fixture-0',
      channel: 'web', chatId: 'orchestrator', senderId: 'owner', messageId: 'request',
      signal: new AbortController().signal, tools,
    }
    for (const query of ['memory', 'Wiki', 'knowledge']) {
      const result = requireToolText(await tools.execute('search', {
        space: 'grep', path: 'v:skills/project-knowledge', query,
      }, context))
      assert.match(result, /v:skills\/project-knowledge/)
    }
    const definitions = tools.getDefinitions()
    const result = requireToolText(await tools.execute('read', { path: 'v:skills/project-knowledge' }, context))
    assert.match(result, /canonical tool path is `v:memory\/`/)
    assert.deepEqual(tools.getDefinitions(), definitions)
    assert.equal(tools.has('write'), false)
    assert.equal(tools.has('invoke_tool'), false)
  })
})
