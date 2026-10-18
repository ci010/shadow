import { requireToolText } from './tool.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { getBuiltinAgentTypes } from '../agent/types/builtins.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { SearchTool } from './search.ts'
import { SessionTools, Tools } from './registry.ts'
import type { ExecutionContext } from './context.ts'
import { McpConnection } from '../mcp/client.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'

test('coordinator keeps routing and approval rules while loading authoring details on demand', async () => {
  const agent = (await getBuiltinAgentTypes()).find(agent => agent.name === 'orchestrator')
  assert(agent)
  const prompt = agent.prompt.replace(/\s+/g, ' ')
  for (const rule of [
    /Search `handler: "grep", path: "v:sessions"` before creating a session/,
    /Gather required baselines before kickoff/,
    /conversationUrl.*logical session ID/,
    /Never resolve remote display paths on Main or quietly widen access/,
    /Sleeping sessions keep their assignments/,
    /Ordinary learning uses `skill_read`\/`skill_save`, not a Change or publication/,
    /Read `v:skills\/tool-operations` before maintenance/,
    /preserve concurrent edits on conflict.*Built-ins are read-only/,
    /Saving does not execute tools or grant permissions/,
    /Skill files cannot bypass your execution cap/,
    /Only managed Bot deployment uses Changes; ordinary shared Skills do not/,
    /For Discord, use `channel_config` with `action: schema`/,
    /changes through this tool, not `authoring_change`/,
    /participants do not limit who reads Discord replies/,
    /Use `authoring_change` with `action: schema`/,
    /delegate substantial implementation with explicit resource paths, changeId and acceptance cases/,
    /Edit exact revisions and use host-saved check evidence/,
    /previews are not behavior tests/,
    /Fixed-script approval never grants unrelated tools, secrets or paths/,
    /The Node child\/VM is not an OS sandbox/,
    /Never put secrets in chat or source/,
    /private `request_secret` entry and respect cancellation/,
    /saving grants no deployment permission/,
    /Only the owner's Publish\/Cancel review of the Change's `propose` publishes that snapshot/,
    /Never infer approval from messages, ask, reply, worker reports or silence/,
    /Changed revisions and rollback need new owner review/,
    /rebase explicitly when the published baseline changes/,
    /Do not silently import legacy shared drafts/,
  ]) assert.match(prompt, rule)
})

test('coordinator cannot activate dynamic tools; sessions share the direct Work surface without Initiative SQL', async t => {
  const agent = (await getBuiltinAgentTypes()).find(agent => agent.name === 'orchestrator')
  assert(agent)
  assert.match(agent.prompt, /Search `handler: "grep", path: "v:sessions"` before creating a session/)
  const base = new Tools('.')
  const importer = new ImportTool(new Map(), '.')
  await importer.updateMcpServers([{ name: 'fixture', transport: 'stdio', command: 'never-execute' }])
  base.register(new InvokeTool(importer))
  const vfs = new VirtualFs()
  vfs.mount('v:tools', 'Tools', (path, ctx) => importer.readVirtual(path, ctx), (ctx, opts) => importer.virtualEntries(ctx, opts))
  base.register(new SearchTool('.', undefined, vfs))
  for (const name of ['exec', 'write', 'subagent', 'read', 'session', 'work', 'sql', 'message', 'project_config', 'authoring_change', 'channel_config', 'skill_read', 'skill_save', 'ask', 'reply']) {
    base.register({ name, description: name, optIn: name === 'channel_config', parameters: { type: 'object', properties: {} }, execute: async () => name })
  }
  const tools = new SessionTools(base, '.', agent.allowedTools, agent.blockedTools)
  const context: ExecutionContext = {
    projectId: 'p', sessionId: 'web:orchestrator', physicalSessionId: 'orchestrator-0',
    channel: 'web', chatId: 'orchestrator', senderId: 'user', messageId: 'input',
    signal: new AbortController().signal, tools,
  }
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => { throw new Error('unexpected connection') })
  assert.deepEqual(tools.getDefinitions().map(definition => definition.function.name).sort(), ['ask', 'authoring_change', 'channel_config', 'message', 'project_config', 'read', 'reply', 'search', 'session', 'skill_read', 'skill_save', 'sql', 'work'])
  assert.match(requireToolText(await tools.execute('search', { handler: 'grep', path: 'v:tools/fixture', query: '' }, context)), /not available/)
  assert.match(requireToolText(await tools.execute('invoke_tool', { name: 'fixture__execute', args: {} }, context)), /not found|not available|not allowed/i)
  assert.equal(connect.mock.callCount(), 0)
  const borrowed = tools.snapshot()
  assert.equal(borrowed.has('invoke_tool'), false)
  assert.equal(borrowed.canUseDynamic('fixture__execute'), false)
  assert.equal(borrowed.has('initiative'), false)
  assert.equal(borrowed.has('work'), true)
  assert.equal(borrowed.has('sql'), true)
  assert.equal(borrowed.has('update_convention'), false)
  assert.equal(requireToolText(await tools.execute('work', { action: 'context' }, context)), 'work')
  const ordinary = new SessionTools(base, '.')
  assert.equal(ordinary.getDefinitions().some(definition => definition.function.name === 'channel_config'), false)
  assert.equal(ordinary.getDefinitions().some(definition => definition.function.name === 'initiative'), false)
  assert.equal(ordinary.getDefinitions().some(definition => definition.function.name === 'work'), true)
  ordinary.resetDynamic()
  tools.resetDynamic()
})
