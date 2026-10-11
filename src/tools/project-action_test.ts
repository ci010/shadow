import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { ProjectActionTool } from './project-action.ts'
import { SessionTools, Tools } from './registry.ts'
import type { ExecutionContext } from './context.ts'
import type { ProjectActions } from '../projects/actions.ts'

test('importable project action management guards project/local/session ownership and never runs', async () => {
  let calls = 0
  const service = {
    list: () => { calls++; return [] },
    create: async (definition: unknown) => { calls++; return definition },
    patch: async (_id: string, patch: unknown) => { calls++; return patch },
    delete: async () => { calls++ },
    scripts: async () => { calls++; return { scripts: [] } },
  } as unknown as ProjectActions
  const tool = new ProjectActionTool(service, 'owner', id => id === 'web:owner')
  const tools = new SessionTools(new Tools(process.cwd()), process.cwd())
  const context: ExecutionContext = { channel: 'web', messageId: 'test', senderId: 'test', chatId: 'test', sessionId: 'web:owner', physicalSessionId: 'test', cwd: process.cwd(), projectId: 'owner', signal: new AbortController().signal, tools }
  for (const override of [{ projectId: 'other' }, { sessionId: 'discord:private' }, { sessionId: 'web:managed' }, { remoteWorkdir: {} as ExecutionContext['remoteWorkdir'] }]) {
    await assert.rejects(tool.execute({ action: 'list' }, { ...context, ...override }), /owning local durable Web/)
  }
  assert.equal(calls, 0)
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'list' }, context)), { actions: [] })
  const definition = { name: 'test', command: 'echo hello', folderId: randomUUID() }
  const created = JSON.parse(await tool.execute({ action: 'create', definition }, context))
  assert.equal(created.action.pinned, false)
  await tool.execute({ action: 'patch', id: randomUUID(), patch: { pinned: true } }, context)
  await tool.execute({ action: 'scripts', folderId: definition.folderId }, context)
  await tool.execute({ action: 'delete', id: randomUUID() }, context)
  await assert.rejects(tool.execute({ action: 'run', id: randomUUID() }, context), /Invalid project action/)
  await assert.rejects(tool.execute({ action: 'create', definition: { ...definition, prompt: 'extra' } }, context), /Invalid project action/)
  assert.equal(calls, 5)
})
