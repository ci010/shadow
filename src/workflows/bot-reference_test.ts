import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkflowRuntime } from './runtime.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { DirectoryBots } from '../bots/runtime.ts'
import { botFiles } from '../bots/sdk-test-fixture.ts'

test('Workflow BOT reference only narrows existing BOT realtime execution; no filters or recoverable/replayable input runs', async () => {
  await withTempWorkspace(async home => {
    const deployments = new BotDeployments({ projectId: 'p', directory: join(home, 'bots'), runGit: async () => { throw Error('No git') } })
    const files = botFiles('throw Error("Must not execute source")', { bindings: [{ platform: 'qq', botInstanceId: 'connection', conversationId: 'group:one', enabled: true, trigger: 'all', tools: [] }] })
    await deployments.deploy({ id: 'demo', source: { folderId: 'source', directory: '' }, ...deployments.freeze(files) })
    const bots = new DirectoryBots(deployments), workflows = new WorkflowRuntime(home, 'p', { canUse: id => id === 'web:owner', deliver: async () => { throw Error('No synthetic BOT invocation') } })
    workflows.start(); workflows.bindBots(id => bots.inspect(id)?.state === 'valid'); bots.setExecutionPolicy(id => workflows.botExecution(id))
    try {
      const address = { projectId: 'p', platform: 'qq' as const, botInstanceId: 'connection', conversationId: 'group:one' }
      const initial = bots.resolve(address)!.generation
      const definition = { id: 'role-workflow', name: 'Role', source: { kind: 'bot', id: 'demo' }, nodes: [{ kind: 'bot-reference', botId: 'demo' }], enabled: true }
      workflows.author('web:owner', definition)
      assert.equal(bots.inputListeners().length, 1)
      assert.notEqual(bots.resolve(address)!.generation, initial)
      assert.throws(() => workflows.author('web:owner', { ...definition, id: 'duplicate' }), /already has/)
      assert.throws(() => workflows.author('web:owner', { ...definition, id: 'bad', binding: { demand: {} } }))
      assert.throws(() => workflows.admit([{ workflow: 'role-workflow', source: { kind: 'bot', id: 'demo' }, observations: [{ id: 'old', data: 'REPLAY' }] }]), /live guarded/)
      workflows.control('web:owner', 'role-workflow', 'pause')
      assert.equal(bots.inputListeners().length, 0); assert.equal(bots.resolve(address)?.binding.enabled, false)
      assert.throws(() => bots.assertExecution('demo'), /paused/)
      const disabled = workflows.snapshot('web:owner').definitions.find(d => d.id === 'role-workflow')!
      workflows.author('web:owner', { ...definition, enabled: true }, disabled.revision)
      assert.equal(bots.inputListeners().length, 1)
      const updated = workflows.snapshot('web:owner').definitions.find(d => d.id === 'role-workflow')!
      workflows.retire('web:owner', updated.id, updated.revision)
      assert.notEqual(bots.resolve(address)!.generation, initial, 'Removing a reference cannot revive old arrival guards')
      assert.deepEqual(workflows.snapshot('web:owner').runs, [])
      assert.deepEqual(bots.definition('demo')!.bindings[0]?.enabled, true, 'Workflow never rewrites BOT subscription policy')
    } finally { await workflows.stop() }
  })
})
