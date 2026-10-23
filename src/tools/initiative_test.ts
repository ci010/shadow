import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InitiativeTool, type InitiativeDatabase } from './initiative.ts'

function fixture() {
  const calls: Array<{ sql: string; actor: string; signal?: AbortSignal }> = []
  const database: InitiativeDatabase = {
    query(sql, actor, signal) {
      calls.push({ sql, actor, signal })
      return { changes: 1 }
    },
  }
  const tool = new InitiativeTool(database, 'alpha', 'initiatives(id, title, goal)')
  const context = { projectId: 'alpha', sessionId: 'web:owner', signal: new AbortController().signal }
  return { calls, tool, context }
}

test('initiative binds SQL to the runtime Project and logical session', async () => {
  const { calls, tool, context } = fixture()
  assert.deepEqual(JSON.parse(await tool.execute({ query: 'SELECT id FROM initiatives' }, context)), { changes: 1 })
  assert.deepEqual(calls, [{ sql: 'SELECT id FROM initiatives', actor: 'web:owner', signal: context.signal }])
  assert.match(tool.description, /initiatives\(id, title, goal\)/)
})

test('initiative rejects missing or different Project contexts before touching storage', async () => {
  const { calls, tool, context } = fixture()
  for (const projectId of [undefined, 'beta', '']) {
    await assert.rejects(tool.execute({ query: 'SELECT id FROM initiatives' }, { ...context, projectId }), /owning Project/)
  }
  assert.equal(calls.length, 0)
})

test('initiative validates SQL arguments and cannot accept a model-supplied actor or scope', async () => {
  const { calls, tool, context } = fixture()
  for (const args of [{}, { query: '' }, { query: 1 }, { query: 'SELECT 1', projectId: 'beta' },
    { query: 'SELECT 1', actorSessionId: 'web:other' }]) {
    await assert.rejects(tool.execute(args, context), TypeError)
  }
  assert.equal(calls.length, 0)
})

test('initiative propagates aborts and database errors rather than returning success-shaped results', async () => {
  const { calls, tool, context } = fixture()
  const controller = new AbortController()
  controller.abort(new Error('stopped'))
  await assert.rejects(tool.execute({ query: 'SELECT 1' }, { ...context, signal: controller.signal }), /stopped/)
  assert.equal(calls.length, 0)
  const broken = new InitiativeTool({ query() { throw new Error('conflict') } }, 'alpha', '')
  await assert.rejects(broken.execute({ query: 'SELECT 1' }, context), /conflict/)
})

test('initiative data stays Home-scoped when the caller has a remote working directory', async () => {
  const { calls, tool, context } = fixture()
  const remoteContext = {
    ...context,
    cwd: 'not-a-local-path',
    remoteWorkdir: { nodeId: 'child', capabilityId: 'folder', executor: {
      execute() { throw new Error('Initiative records must not execute against remote files') },
    } },
  }
  assert.equal(tool.supportsRemoteWorkdir, true)
  await tool.execute({ query: 'SELECT id FROM initiatives' }, remoteContext)
  assert.equal(calls[0].actor, context.sessionId)
})
