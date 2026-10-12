import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Tools, SessionTools } from './registry.ts'
import { allowedSubagentModes, executionModeAllowsTool, type ExecutionMode } from '../sessions/execution-mode.ts'
import type { ExecutionContext } from './context.ts'

const names = ['read', 'write', 'exec', 'ask', 'reply', 'message', 'cancel', 'subagent',
  'session', 'work', 'initiative', 'continuation', 'cron', 'cron_add', 'cron_list', 'cron_remove',
  'event_source', 'event_subscribe', 'skill_read', 'skill_save']

for (const mode of ['session', 'task', 'call'] as ExecutionMode[]) {
  test(`${mode}: mode ceiling applies to definitions, static execution, dynamic import and gateway`, async () => {
    let effects = 0
    const base = new Tools(process.cwd())
    for (const name of names) base.register({ name, description: name,
      parameters: { type: 'object', properties: {} }, execute: async () => { effects++; return 'ok' } })
    // Explicit allowlists must not override a mode ceiling.
    const tools = new SessionTools(base, process.cwd(), [...names, 'invoke_tool'])
    tools.setExecutionScope(mode, allowedSubagentModes(mode, true))
    const context = { tools, signal: new AbortController().signal } as ExecutionContext
    for (const name of names) {
      const allowed = executionModeAllowsTool(mode, name)
      assert.equal(tools.has(name), allowed, name)
      assert.equal(tools.getDefinitions().some(def => def.function.name === name), allowed, name)
      tools.registerDynamic(base.get(name)!)
      assert.equal(tools.canUseDynamic(name), allowed, name)
      assert.equal(tools.activeDynamicTools().some(tool => tool.name === name), allowed, name)
      if (allowed) continue
      const before = effects
      assert.match(String(await tools.execute(name, {}, context)), /unavailable|not available/)
      assert.match(String(await tools.executeDynamic(name, {}, context)), /unavailable|not available/)
      assert.match(tools.executionDenial('invoke_tool', { name, args: {} })!, /unavailable/)
      assert.equal(effects, before, `${name} had side effects`)
      const snapshot = tools.snapshot()
      assert.equal(snapshot.canUseDynamic(name), false)
      assert.equal(snapshot.has(name), false)
    }
  })
}

test('scope metadata cannot widen the delegation modes of a task or leaf', () => {
  const base = new Tools(process.cwd())
  base.register({ name: 'subagent', description: '',
    parameters: { type: 'object', properties: { mode: { type: 'string' } } }, execute: async () => 'ok' })
  const task = new SessionTools(base, process.cwd())
  task.setExecutionScope('task', ['session', 'task', 'call'])
  const definition = task.getDefinitions()[0].function
  assert.deepEqual(definition.parameters.properties.mode.enum, ['call'])
  assert.match(task.executionDenial('subagent', { mode: 'task' })!, /only: call/)
  assert.match(task.executionDenial('subagent', { mode: 'session' })!, /only: call/)
  const call = new SessionTools(base, process.cwd())
  call.setExecutionScope('call', ['task', 'call'])
  assert.equal(call.has('subagent'), false)
  assert.match(call.executionDenial('subagent', { mode: 'call' })!, /unavailable/)
})
