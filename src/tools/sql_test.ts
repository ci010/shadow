import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ProjectConventions } from '../projects/conventions.ts'
import { SqlTool } from './sql.ts'
import { SessionTools, Tools } from './registry.ts'
import type { ExecutionContext } from './context.ts'

test('SQL binds Project/actor, permits read-only discovery, and denies delegated convention writes', async () => {
  await withTempWorkspace(async root => {
    const store = new ProjectConventions(root, () => [])
    const tools = new SessionTools(new Tools(root), root)
    let verifications = 0
    const tool = new SqlTool(store, 'project-a', async source => {
      verifications++
      if (source.kind !== 'user') throw new Error('fixture expects user evidence')
      return { source, quote: source.quote }
    })
    const context: ExecutionContext = {
      projectId: 'project-a', sessionId: 'web:owner', physicalSessionId: 'p', messageId: 'i',
      channel: 'web', chatId: 'owner', senderId: 'owner', admin: true, inputSource: 'user',
      tools, signal: new AbortController().signal,
    }
    const query = "INSERT INTO project_conventions (id,text) VALUES ('packages','Use pnpm')"
    const source = { kind: 'user', sessionId: context.sessionId, physicalId: 'p', id: 'i', quote: 'Use pnpm' }
    try {
      const schema = JSON.parse(await tool.execute({}, { ...context, admin: false }))
      assert(schema.tables.work_items.includes('boundaries'))
      assert.equal(tool.readonly({}), true)
      assert.equal(tool.readonly({ query: 'SELECT * FROM project_conventions' }), true)
      assert.equal(tool.readonly({ query }), false)
      assert.equal(tool.readonly({ query: 'PRAGMA x' }), false)
      for (const patch of [
        { projectId: 'project-b' }, { projectId: undefined }, { admin: false },
        { inputSource: 'session' as const }, { inputSource: 'event' as const }, { channel: 'a2a' },
      ]) await assert.rejects(tool.execute({ query, source }, { ...context, ...patch }))
      assert.equal(verifications, 0)
      await assert.rejects(tool.execute({ query, source, actor: 'web:other' }, context), /only query/)
      await assert.rejects(tool.execute({ query }, context))
      await tool.execute({ query, source }, context)
      const read = JSON.parse(await tool.execute({ query: "SELECT created_by_session_id FROM project_conventions WHERE id='packages'" }, { ...context, admin: false, inputSource: 'session' }))
      assert.equal(read.results[0].rows[0].created_by_session_id, 'web:owner')
      await assert.rejects(tool.execute({ query: 'SELECT * FROM project_conventions', source }, context), /does not take/)
    } finally { store.close() }
  })
})
