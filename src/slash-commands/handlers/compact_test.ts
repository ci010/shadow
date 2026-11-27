import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentApp } from '../../agent/app.ts'
import { BackgroundTaskManager } from '../../agent/background-task.ts'
import { ContextBuilder } from '../../agent/context/builder.ts'
import { IdentityManager } from '../../agent/identity.ts'
import { AgentTypesManager } from '../../agent/types/manager.ts'
import { Bus } from '../../bus/bus.ts'
import { EventService } from '../../events/service.ts'
import { McpManager } from '../../mcp/manager.ts'
import type { ChatMessage, LLMProvider } from '../../providers/provider.ts'
import { HandoffManager } from '../../sessions/handoff/manager.ts'
import { physicalSessionId } from '../../sessions/session-identity.ts'
import { SessionManager } from '../../sessions/session-manager.ts'
import { JsonlSessionStore } from '../../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../../sessions/session-store-sqlite.ts'
import { SkillsManager } from '../../skills/loader.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { WriteTool } from '../../tools/filesystem.ts'
import { InvokeTool } from '../../tools/invoke-tool.ts'
import { ReadTool } from '../../tools/read.ts'
import { Tools } from '../../tools/registry.ts'
import type { ToolDefinition } from '../../tools/tool.ts'
import { CommandDispatcher } from '../index.ts'
import { createCompactCommand } from './compact.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`typed /compact safely wakes a dormant conversation (${Store.name})`, { timeout: 10_000 }, async () => {
    await withTempWorkspace(async workspace => {
      const llm = { model: 'project-model', contextWindow: 100_000, temperature: 0 }
      const store = new Store(join(workspace, 'sessions'))
      await store.init()
      const bus = new Bus()
      const events = new EventService(workspace, bus, async () => assert.fail('Unexpected event delivery'))
      const agentTypes = new AgentTypesManager(workspace)
      const tools = new Tools(workspace)
      tools.register(new ReadTool(workspace))
      tools.register(new WriteTool(workspace, true))
      tools.register(new InvokeTool())
      const calls: Array<{ model: string; messages: ChatMessage[]; tools: ToolDefinition[] }> = []
      const provider: LLMProvider = {
        name: 'compact-fixture', listModels: () => [],
        async chat(messages, tools, options) {
          calls.push({ model: options.model, messages: structuredClone(messages), tools: structuredClone(tools) })
          if (calls.length === 1) return { content: '', toolCalls: [{ id: 'draft-write', name: 'write', arguments: {
            path: 'v:handoff/draft.md',
            content: '## Summary\nRetained synthetic context\n\n## Current Objective\nNo action remains',
          } }] }
          return { content: '', toolCalls: [{ id: 'draft-submit', name: 'invoke_tool', arguments: { name: 'handoff_submit', args: {} } }] }
        },
      }
      let accessRevoked = false
      const sessions = new SessionManager({
        workspace, bus, store, events, provider, agentTypes, projectId: 'fixture',
        tools, context: new ContextBuilder(workspace), identity: new IdentityManager(workspace),
        handoffManager: new HandoffManager(provider, llm.contextWindow, { autoHandoff: false, compactV2: true }, workspace, store),
        backgroundTasks: new BackgroundTaskManager(bus, events), getLlmRuntimeConfig: () => llm,
        assertSessionFolder(state) {
          if (state.sessionId === 'web:dormant' && accessRevoked) throw new Error('Workspace access revoked')
        },
      })
      const commandDispatcher = new CommandDispatcher()
      commandDispatcher.register(createCompactCommand(sessions))
      const agent = new AgentApp({ bus, sessions, agentTypes, commandDispatcher, getLlmRuntimeConfig: () => llm,
        skills: new SkillsManager(workspace), mcpManager: new McpManager(async () => {}),
      })
      const timestamp = new Date().toISOString()
      const command = (chatId: string, admin = true) => ({ channel: 'web', chatId, admin, senderId: 'fixture',
        messageId: crypto.randomUUID(), timestamp, content: '/compact',
      })
      const prepare = async (id: string) => {
        await sessions.prepareCommandSession(id)
        return physicalSessionId(sessions.getSessionState(id)!)
      }
      const receive = (chatId: string, admin = true) => agent.receiveChannelMessage(command(chatId, admin))
      try {
        await agent.start()
        const source = await prepare('web:dormant')
        await store.appendMessages(source, [
          { role: 'user', content: 'Remember the saved conversation', timestamp },
          { role: 'assistant', content: 'Acknowledged', timestamp },
        ])
        await sessions.setSessionConfig('web:dormant', { model: 'session-model' })
        const interruptedPhysical = await prepare('web:interrupted')
        await store.appendMessages(interruptedPhysical, [
          { role: 'user', content: 'Interrupted question', timestamp },
          { role: 'assistant', content: null, timestamp, tool_calls: [
            { id: 'unfinished', type: 'function', function: { name: 'probe', arguments: '{}' } },
          ] },
        ])
        await sessions.recoverIncompleteSessions()
        const recovery = sessions.getSessionRecovery('web:interrupted')
        assert.equal(recovery?.pendingToolCalls, 1)

        assert.equal(await sessions.requestCommandCompact('web:unknown', command('unknown'), llm), 'unsupported')
        assert.equal(sessions.getSessionState('web:unknown'), null)
        await prepare('web:empty') // Web ingress can prepare an identity before dispatch.
        assert.match((await receive('empty')).commandReceipt?.output ?? '', /no model history/)
        await sessions.buildSession('web:one-shot', undefined, { mode: 'task' })
        assert.match((await receive('one-shot')).commandReceipt?.output ?? '', /persistent conversation/)
        assert.match((await receive('interrupted')).commandReceipt?.output ?? '', /Continue it before compacting/)
        assert.deepEqual(sessions.getSessionRecovery('web:interrupted'), recovery)
        assert.equal(physicalSessionId(sessions.getSessionState('web:interrupted')!), interruptedPhysical)
        assert.match((await receive('dormant', false)).commandReceipt?.output ?? '', /Permission denied/)
        accessRevoked = true
        await assert.rejects(receive('dormant'), /Workspace access revoked/)
        accessRevoked = false
        assert.deepEqual(sessions.listActiveSessions(), [])
        assert.equal(calls.length, 0)

        const handoff = Promise.withResolvers<string>()
        let turns = 0
        let admissions = 0
        bus.on('session.turn.finished', () => { turns++ })
        bus.on('session.input.accepted', () => { admissions++ })
        bus.on('session.handoff', event => { if (event.sessionId === 'web:dormant') handoff.resolve(event.targetSessionId) })
        const { commandReceipt } = await receive('dormant')
        assert.equal(commandReceipt?.failed, false)
        assert.equal(commandReceipt?.output, 'Compaction queued.')
        const target = await handoff.promise
        assert.notEqual(target, source)
        assert.equal(physicalSessionId(sessions.getSessionState('web:dormant')!), target)
        assert.equal(turns, 0)
        assert.equal(admissions, 1, 'Only the command path acknowledges its input')
        assert.equal(calls.length, 2)
        for (const call of calls) {
          assert.equal(call.model, 'session-model')
          assert.deepEqual(call.tools, tools.getDefinitions())
          const messages = JSON.stringify(call.messages)
          assert.match(messages, /Remember the saved conversation/)
          assert.match(messages, /session\.compact/)
          assert.doesNotMatch(messages, /\/compact|Compaction queued/)
        }
        assert.deepEqual(calls[1].messages.slice(0, calls[0].messages.length), calls[0].messages)
        assert.match(String((await store.readFirstRecord(target))?.summary_context), /Retained synthetic context/)
        const history = JSON.stringify((await sessions.getHistory('web:dormant')).messages)
        assert.doesNotMatch(history, /\/compact|Compaction queued|draft-write|draft-submit/)
      } finally {
        await agent.shutdown()
        bus.stopAll()
        if (store instanceof SqliteSessionStore) store.close()
      }
    })
  })
}
