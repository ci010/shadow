import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SendMessageRequest, TaskState, Task } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { withTempWorkspace } from '../testing/workspace.ts'
import { A2aConfigSchema } from './config.ts'
import { A2aStore } from './store.ts'
import { A2aService } from './service.ts'
import { A2aClientTools, type A2aCallContext } from './client.ts'

const owner = (userName = 'caller') => new ServerCallContext({ user: { isAuthenticated: true, userName } })
const send = (text: string, extra: Record<string, string> = {}) => SendMessageRequest.fromJSON({
  message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra },
})
const config = A2aConfigSchema.parse({
  server: { url: 'http://127.0.0.1/projects/p/a2a', agentType: 'a2a-text', callers: { caller: 'TOKEN' } },
  agents: { peer: { cardUrl: 'https://peer.invalid/card', endpointUrl: 'https://peer.invalid/a2a' } },
})
const context: A2aCallContext = {
  projectId: 'p', sessionId: 'web:owner', physicalSessionId: 'owner_0', messageId: 'input', toolCallId: 'send',
  signal: new AbortController().signal,
}

test('input-required ends a blocking response, resumes the same task, and deduplicates durable replies', async () => {
  await withTempWorkspace(async root => {
    const store = new A2aStore(root); store.init()
    let runs = 0
    const service = new A2aService('p', config.server!, store, {
      async run(_record, _message, _signal, interaction) {
        runs++
        const first = await interaction.ask('Choose a language.')
        const second = await interaction.ask('Choose a name.')
        return { status: 'completed', content: `${first}: ${second}` }
      },
    })
    try {
      const initial = await service.sendMessage(send('work'), owner())
      assert.equal(initial.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED)
      const firstReply = send('TypeScript', { taskId: initial.id, contextId: initial.contextId })
      await assert.rejects(service.sendMessage(firstReply, owner('stranger')), /not found/i)
      await assert.rejects(service.sendMessage(send('wrong', { taskId: initial.id, contextId: randomUUID() }), owner()), /does not match/)
      const question = await service.sendMessage(firstReply, owner())
      assert.equal(question.id, initial.id)
      assert.equal(question.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED)
      assert.match(String(question.status.message?.parts[0].content?.value), /name/)
      const duplicate = await service.sendMessage(firstReply, owner())
      assert.equal(duplicate.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED)
      const done = await service.sendMessage(send('Shadow', { taskId: initial.id }), owner())
      assert.equal(done.status?.state, TaskState.TASK_STATE_COMPLETED)
      assert.equal(done.artifacts[0].parts[0].content?.value, 'TypeScript: Shadow')
      assert.equal(done.history.length, 3)
      assert.equal(runs, 1)
      const restored = new A2aStore(root); restored.init()
      assert.equal(restored.inbound.get(done.id)?.replies?.length, 2)
      const restarted = new A2aService('p', config.server!, restored, { run: async () => { throw new Error('No replay') } })
      try { assert.equal((await restarted.sendMessage(firstReply, owner())).status?.state, TaskState.TASK_STATE_COMPLETED) }
      finally { await restarted.close() }
      await assert.rejects(service.sendMessage(send('late', { taskId: initial.id }), owner()), /not waiting/)
    } finally { await service.close() }
  })
})

test('pending input is canceled without another message; unfinished input is not resumed after restart', async () => {
  await withTempWorkspace(async root => {
    const store = new A2aStore(root); store.init()
    const service = new A2aService('p', config.server!, store, {
      async run(_record, _message, _signal, interaction) {
        return { status: 'completed', content: await interaction.ask('Waiting') }
      },
    })

    try {
      const task = await service.sendMessage(send('start'), owner())
      const recoveredStore = new A2aStore(root); recoveredStore.init()
      const recovered = new A2aService('p', config.server!, recoveredStore, { run: async () => { throw new Error('No replay') } })
      assert.equal((await recovered.getTask({ id: task.id, tenant: '' }, owner())).status?.state, TaskState.TASK_STATE_FAILED)
      await recovered.close()
      const canceled = await service.cancelTask({ id: task.id, tenant: '', metadata: undefined }, owner())
      assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED)
    } finally { await service.close() }
  })
})

test('withdrawing one input clears protocol waiting state and permits a later question', async () => {
  await withTempWorkspace(async root => {
    const store = new A2aStore(root); store.init()
    const controller = new AbortController()
    const withdrawn = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const asked = Promise.withResolvers<void>()
    const service = new A2aService('p', config.server!, store, {
      async run(_record, _message, _signal, interaction) {
        await assert.rejects(interaction.ask('Old question', controller.signal), /input expired/)
        withdrawn.resolve()
        await proceed.promise
        const answer = interaction.ask('New question')
        asked.resolve()
        return { status: 'completed', content: await answer }
      },
    })
    try {
      const task = await service.sendMessage(send('start'), owner())
      controller.abort(new Error('input expired'))
      await withdrawn.promise
      assert.equal((await service.getTask({ id: task.id, tenant: '' }, owner())).status?.state, TaskState.TASK_STATE_WORKING)
      await assert.rejects(service.sendMessage(send('late', { taskId: task.id }), owner()), /not waiting/)
      proceed.resolve()
      await asked.promise
      const result = await service.sendMessage(send('new answer', { taskId: task.id }), owner())
      assert.equal(result.status?.state, TaskState.TASK_STATE_COMPLETED)
      assert.equal(result.artifacts[0].parts[0].content?.value, 'new answer')
    } finally { proceed.resolve(); await service.close() }
  })
})

test('outbound tracking resumes after restart, reports requested input and completion once, and journals replies', async t => {
  await withTempWorkspace(async root => {
    const remote = Task.fromJSON({ id: randomUUID(), contextId: randomUUID(), status: { state: 'TASK_STATE_WORKING' } })
    let sends = 0
    const messages: unknown[] = []
    t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
      if (url.href.endsWith('/card')) return Response.json({
        supportedInterfaces: [{ url: config.agents.peer.endpointUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      })
      const rpc = JSON.parse(String(options.body))
      if (rpc.method === 'SendMessage') {
        sends++
        messages.push(rpc.params.message)
        if (rpc.params.message.taskId) remote.status!.state = TaskState.TASK_STATE_COMPLETED
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id,
        result: rpc.method === 'SendMessage' ? { task: Task.toJSON(remote) } : Task.toJSON(remote) })
    })
    const store = new A2aStore(root); store.init()
    let client = new A2aClientTools('p', config, store)
    const notifications: string[] = []
    try {
      const initial = JSON.parse(await client.call('a2a_send', { agent: 'peer', message: 'work' }, context))
      await client.close()
      const recovered = new A2aStore(root); recovered.init()
      client = new A2aClientTools('p', config, recovered, { notify: async call => { notifications.push(call.status) } })
      remote.status!.state = TaskState.TASK_STATE_INPUT_REQUIRED
      await Promise.all([client.poll(), client.poll()])
      await client.poll()
      assert.deepEqual(notifications, ['input-required'])
      const waiting = JSON.parse(await client.call('a2a_get', { handle: initial.handle }, context))
      const args = { request_id: waiting.request.request_id, text: 'answer' }
      const reply = JSON.parse(await client.call('reply', args, { ...context, toolCallId: 'reply' }))
      assert.equal(reply.status, 'completed')
      assert.notEqual(reply.handle, initial.handle)
      assert.equal(JSON.parse(await client.call('reply', args, { ...context, toolCallId: 'reply' })).handle, reply.handle)
      await client.poll()
      await client.poll()
      assert.deepEqual(notifications, ['input-required', 'completed'])
      assert.equal(sends, 2)
      await assert.rejects(client.call('reply', args, { ...context, toolCallId: 'second-reply' }), /already has a reply/)
      assert.deepEqual(messages, [
        { messageId: store.outbound.get(initial.handle)!.messageId, role: 'ROLE_USER', parts: [{ text: 'work', mediaType: 'text/plain' }] },
        { messageId: recovered.outbound.get(reply.handle)!.messageId, role: 'ROLE_USER', contextId: remote.contextId,
          taskId: remote.id, parts: [{ text: 'answer', mediaType: 'text/plain' }] },
      ])
      const calls = JSON.parse(await client.call('a2a_calls', {}, context))
      assert.equal(calls.length, 2)
      assert.deepEqual(JSON.parse(await client.call('a2a_calls', {}, { ...context, sessionId: 'web:other' })), [])
    } finally { await client.close() }
  })
})

test('notification crashes never replay uncertain delivery and polling failures remain visible', async t => {
  await withTempWorkspace(async root => {
    const store = new A2aStore(root); store.init()
    const id = randomUUID()
    store.saveCall({
      version: 1, id, owner: context.sessionId, agent: 'peer', key: 'key', fingerprint: 'a'.repeat(64),
      messageId: randomUUID(), endpointUrl: config.agents.peer.endpointUrl,
      taskId: randomUUID(), status: 'completed', notification: 'delivering',
    })
    let notifications = 0
    const client = new A2aClientTools('p', config, store, { notify: async () => { notifications++ } })
    try {
      await client.poll()
      assert.equal(store.outbound.get(id)?.notification, 'uncertain')
      assert.equal(notifications, 0)
      store.saveCall({ ...store.outbound.get(id)!, status: 'submitted' })
      t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
      await client.poll()
      assert.equal(store.outbound.get(id)?.status, 'submitted')
      assert.match(store.outbound.get(id)?.trackingError ?? '', /failed/)
      assert.equal(notifications, 0)
    } finally { await client.close() }
  })
})
