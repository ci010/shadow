import assert from 'node:assert/strict'
import test from 'node:test'
import { getBuiltinAgentTypes } from '../agent/types/builtins.ts'
import { getBuiltinSkills } from '../skills/builtins.ts'
import { SessionTools, Tools } from './registry.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import type { ExecutionContext } from './context.ts'

test('ordinary Web sessions discover administration on demand', async () => {
  const roles = await getBuiltinAgentTypes()
  for (const name of ['general']) {
    const role = roles.find(role => role.name === name)!
    assert.doesNotMatch(role.prompt, /For Discord, use|single Project coordinator|request_secret|Coordinator Capability Boundary/)
    assert.equal(role.allowedTools, undefined)
  }
  const skill = (await getBuiltinSkills()).get('project-administration')!
  assert.equal(skill.meta.admin, true)
  assert.match(skill.body, /Reading this Skill grants no authority/)
  assert.match(skill.body, /Only the owner's Publish\/Cancel/)
  assert.match(skill.body, /Never put secrets in chat or source/)
})

test('administration builtins use existing dynamic catalog and invoke gateway, not full resident schemas', async () => {
  const base = new Tools('.')
  let calls = 0
  const tool = { name: 'project_config', optIn: true, description: 'fixture',
    parameters: { type: 'object' as const, properties: { action: { type: 'string' } }, required: ['action'] },
    execute: async () => { calls++; return 'schema' } }
  base.register(tool)
  base.register({ name: 'read', description: 'read', parameters: { type: 'object', properties: {} }, execute: async () => '' })
  const importer = new ImportTool(new Map([[tool.name, tool]]), '.')
  base.register(new InvokeTool(importer))
  const tools = new SessionTools(base, '.')
  tools.setExecutionScope('session', ['task', 'call'])
  const context: ExecutionContext = { projectId: 'p', sessionId: 'web:ordinary', physicalSessionId: 'ordinary-0',
    channel: 'web', chatId: 'ordinary', senderId: 'owner', messageId: 'input', inputSource: 'user', admin: true,
    tools, signal: new AbortController().signal }
  assert(!tools.getDefinitions().some(def => def.function.name === 'project_config'))
  assert.match(importer.readCatalog('project_config', tools), /v:tools\/project_config/)
  await tools.execute('invoke_tool', { name: 'project_config', args: {} }, context)
  assert.equal(calls, 0, 'invalid arguments return contract without execution')
  assert.equal(await tools.execute('invoke_tool', { name: 'project_config', args: { action: 'schema' } }, context), 'schema')
  assert.equal(calls, 1)
  assert(!tools.getDefinitions().some(def => def.function.name === 'project_config'))
  await tools.resetDynamicAndWait()
  assert.equal(tools.hasDynamic('project_config'), false)
})
