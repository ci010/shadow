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
  assert.match(skill.body, /Reading this\s+Skill grants no authority/)
  assert.match(skill.body, /native Deploy\/Cancel confirmation/)
  assert.match(skill.body, /Never request\/pass secret values through chat/)
  assert.match(skill.body, /credential_request/)
  assert.doesNotMatch(skill.body, /`authoring_change`|`project_config`|v:authoring/)
})

test('administration builtins use existing dynamic catalog and invoke gateway, not full resident schemas', async () => {
  const base = new Tools('.')
  let calls = 0
  const tool = { name: 'fixture_admin_tool', optIn: true, description: 'fixture',
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
  assert(!tools.getDefinitions().some(def => def.function.name === 'fixture_admin_tool'))
  assert.match(importer.readCatalog('fixture_admin_tool', tools), /v:tools\/fixture_admin_tool/)
  await tools.execute('invoke_tool', { name: 'fixture_admin_tool', args: {} }, context)
  assert.equal(calls, 0, 'invalid arguments return contract without execution')
  assert.equal(await tools.execute('invoke_tool', { name: 'fixture_admin_tool', args: { action: 'schema' } }, context), 'schema')
  assert.equal(calls, 1)
  assert(!tools.getDefinitions().some(def => def.function.name === 'fixture_admin_tool'))
  await tools.resetDynamicAndWait()
  assert.equal(tools.hasDynamic('fixture_admin_tool'), false)
})
