import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { Bus } from '../bus/bus.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { IdentityManager } from '../agent/identity.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { EventService } from '../events/service.ts'
import { HandoffManager } from './handoff/manager.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { Tools } from '../tools/registry.ts'
import { SessionManager } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { channelSessionId } from '../bus/events.ts'
import { YieldManager } from './yield.ts'
import { createOrganizationScope, getOrganizationScope } from '../organizations/scope.ts'

test('organization manager persists ownership and rejects foreign lineage, projects, input and bot addresses', async t => {
  await withTempWorkspace(async root => {
    const workspace = join(root, 'home')
    const bus = new Bus()
    const store = new JsonlSessionStore(join(workspace, '.sessions'))
    await store.init()
    const provider: LLMProvider = {
      name: 'fixture', listModels: () => [],
      chat: async () => { throw new Error('No model call expected') },
    }
    const events = new EventService(workspace, bus, async () => { throw new Error('No delivery expected') })
    const backgroundTasks = new BackgroundTaskManager(bus, events)
    const handoffManager = new HandoffManager(provider, 100000, {}, workspace, store)
    const agentTypes = new AgentTypesManager(workspace)
    await agentTypes.load()
    const context = new ContextBuilder(workspace)
    let observedAddress: unknown
    context.register({
      name: 'fixture',
      getPromptSection: ctx => {
        observedAddress = ctx.channelAddress
        return ''
      },
    })
    const scope = createOrganizationScope('org-a')
    const manager = new SessionManager({
      organizationId: 'org-a', scope, ownsProject: id => ['project-a', 'project-b'].includes(id),
      ownsWorkdir: () => true,
      workspace, store, bus, provider, events, backgroundTasks, handoffManager, agentTypes,
      identity: new IdentityManager(workspace), context, tools: new Tools(workspace),
    })
    try {
      await manager.start()
      await manager.buildSession('web:root', undefined, { projectId: 'project-a' })
      await manager.buildSession('web:child', { id: 'web:root', index: 0 })
      assert.equal((await store.getState('web:child'))?.organizationId, 'org-a')
      assert.equal((await store.getState('web:child'))?.projectId, 'project-a')
      for (const fields of [{ reportTo: 'web:foreign' }, { workspaceRoot: 'web:foreign' }, { projectId: 'foreign-project' }]) {
        await assert.rejects(manager.buildSession('web:rejected', undefined, fields), /organization/)
      }
      await assert.rejects(manager.buildSession('web:rejected', { id: 'web:foreign' }), /organization/)
      await assert.rejects(manager.buildSession('web:rejected', { id: 'web:root' }, { projectId: 'project-b' }), /switch projects/)
      const foreignBot = channelSessionId({ organizationId: 'org-b', botInstanceId: 'bot', platform: 'qq', conversationId: 'room' })
      await assert.rejects(manager.buildSession(foreignBot), /organization/)
      const ownAddress = { organizationId: 'org-a', botInstanceId: 'bot-a', platform: 'qq', conversationId: 'room' }
      const ownBot = channelSessionId(ownAddress)
      await manager.buildSession(ownBot)
      await manager.getContext({ sessionId: ownBot })
      assert.deepEqual(observedAddress, ownAddress)
      await manager.buildSession('web:reporter', undefined, { reportTo: 'web:root' })
      const reportScope = Promise.withResolvers<string | undefined>()
      t.mock.method(events, 'emit', async () => { reportScope.resolve(getOrganizationScope()?.organizationId) })
      bus.emit('session.turn.finished', {
        sessionId: 'web:reporter', turnId: 'fixture-turn', inputId: 'fixture-input',
        source: { kind: 'session', sessionId: 'web:root' }, status: 'completed', content: 'Scoped completion',
      })
      assert.equal(await reportScope.promise, 'org-a')
      assert.equal(manager.canSendSessionMessage('web:foreign', 'web:root'), false)
      assert.equal(manager.canReceiveSessionMessage('web:foreign'), false)
      await assert.rejects(manager.addChild('web:root', 'web:foreign'), /organization/)
      await assert.rejects(manager.deliver('web:root', {
        kind: 'message', id: 'foreign', timestamp: new Date().toISOString(), policy: 'queue', content: 'blocked',
        source: { kind: 'session', sessionId: 'web:foreign' },
      }), /organization/)
      assert.equal((await store.getState('web:root'))?.organizationId, 'org-a')
      const controller = new AbortController()
      const buildSession = manager.buildSession.bind(manager)
      t.mock.method(manager, 'buildSession', async (...args: Parameters<typeof buildSession>) => {
        const session = await buildSession(...args)
        controller.abort()
        return session
      })
      await assert.rejects(manager.startSession({
        agentType: 'reflector', chatId: 'cancelled-learning', task: 'Do not dispatch', signal: controller.signal,
      }), { name: 'AbortError' })
      assert.equal((await store.getState('heartbeat:cancelled-learning'))?.executionStatus, 'cancelled')
    } finally {
      await manager.stop()
      await handoffManager.stop()
      await backgroundTasks.stop()
      await events.stop()
      bus.stopAll()
      scope.close()
    }
  })
})

test('multi-instance bot yield decisions retain the exact bot session and platform', async () => {
  const id = channelSessionId({ organizationId: 'org-a', botInstanceId: 'qq-a', platform: 'qq', conversationId: 'shared-room' })
  const other = channelSessionId({ organizationId: 'org-a', botInstanceId: 'qq-b', platform: 'qq', conversationId: 'shared-room' })
  const manager = new YieldManager({
    getState: sessionId => ({ sessionId, segmentIndex: 0, organizationId: 'org-a' }),
    getPolicy: () => ({ timeoutMs: null }), notifyUser: async () => {}, notifyParent: async () => {},
  })
  const question = { question: 'Continue?', options: ['Yes', 'No', 'Stop'] as [string, string, string], defaultOption: 'Yes' }
  const pending = manager.ask(id, question, new AbortController().signal, { channel: 'qq', senderId: 'user' })
  const request = manager.get(id)!
  assert(request)
  assert.throws(() => manager.answerChannel(other, request.id, 'Yes', 'qq', 'user'), /session/)
  manager.answerChannel(id, request.id, 'Yes', 'qq', 'user')
  assert.equal((await pending).option, 'Yes')
  await assert.rejects(manager.ask(id, question, new AbortController().signal), /initiating human/)
  manager.stop()
})
