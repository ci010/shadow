import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TopicService, type TopicServiceOptions } from '../sessions/topics.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { SessionTool } from './session.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { Tools, SessionTools } from './registry.ts'
import { requireToolText } from './tool.ts'
import type { ExecutionContext } from './context.ts'

test('session lazy invocation preserves local, remote and execution-mode boundaries', async () => {
  const states = new Map<string, SessionState>([['web:actor', {
    sessionId: 'web:actor', projectId: 'p', segmentIndex: 0, mode: 'session',
  }]])
  const sessions: TopicServiceOptions['sessions'] = {
    getSessionState: id => states.get(id) ?? null,
    assertFolderAccess: id => { assert(states.has(id)) },
    assertInitiativeAccess() {},
    async validateExecutionInference() {},
    async updateConversationMetadata() {},
    async buildSession(id, _parent, fields) {
      states.set(id, { sessionId: id, projectId: 'p', segmentIndex: 0, ...fields })
    },
    async deliver() { throw new Error('No kickoff requested') },
  }
  const service = new TopicService({
    projectId: 'p', sessions, listStates: async () => [...states.values()],
    resolveAgent: () => ({ defaultMode: 'session' }), changed() {},
    folders: {
      list: () => [], acquireAccess: () => () => {},
      async register() { throw new Error('Must not register on Main') },
      async requireAvailable() { throw new Error('No folder requested') },
    },
  })
  const base = new Tools(process.cwd())
  const importer = new ImportTool(new Map(), process.cwd())
  importer.registerBuiltin('session', new SessionTool(service))
  base.register(new InvokeTool(importer))
  const tools = new SessionTools(base, process.cwd())
  const dynamicContext = {
    projectId: 'p', sessionId: 'web:actor', signal: new AbortController().signal,
    tools, remoteWorkdir: { nodeId: 'child' },
  } as ExecutionContext
  assert(!tools.names().includes('session'))
  assert.equal(importer.canInvokeFromRemote('session'), true)
  const invoke = async (args: Record<string, unknown>, ctx = dynamicContext) =>
    requireToolText(await tools.execute('invoke_tool', { name: 'session', args }, ctx))
  const created = JSON.parse(await invoke({ action: 'create', title: 'Lazy peer', model: 'synthetic', effort: 'low' }))
  assert.deepEqual(states.get(created.sessionId)?.config, { model: 'synthetic', reasoningEffort: 'low' })
  assert(tools.hasDynamic('session'))
  assert(!tools.names().includes('session'))
  const local = JSON.parse(await invoke({ action: 'create', title: 'Local peer' }, { ...dynamicContext, remoteWorkdir: undefined }))
  assert.equal(states.get(local.sessionId)?.config, undefined)
  const taskTools = new SessionTools(base, process.cwd())
  taskTools.setExecutionScope('task', ['call'])
  assert.match(await invoke({ action: 'create', title: 'Not a peer' }, { ...dynamicContext, tools: taskTools }), /Task session metadata is parent-owned/)
  assert.match(await invoke({ action: 'update', sessionId: 'web:actor', title: 'No inference update', model: 'synthetic' }), /model/)
  assert.equal(JSON.parse(await invoke({ action: 'update', sessionId: 'web:actor', title: 'Actor' })).sessionId, 'web:actor')
  assert.match(await invoke({ action: 'register_folder', path: process.cwd() }), /remote session cannot register/)
  assert.match(await invoke({ action: 'create', title: 'Invalid', effort: 'invalid' }), /effort/)
  const denied = new SessionTools(base, process.cwd(), undefined, ['session'])
  assert.match(await invoke({ action: 'create', title: 'Denied' }, { ...dynamicContext, tools: denied }), /not available|could not be imported/)
  tools.resetDynamic()
  await importer.updateMcpServers([{ name: 'session', transport: 'stdio', command: 'must-not-run' }])
  assert.equal(importer.canInvokeFromRemote('session'), false)
  assert.match(await invoke({ action: 'create', title: 'Shadowed' }), /only the built-in/)
  await importer.updateMcpServers([])
  assert.equal(importer.canInvokeFromRemote('session'), true)
})
