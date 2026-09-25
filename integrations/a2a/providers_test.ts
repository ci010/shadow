import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { SendMessageRequest, TaskState } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
import type { SessionConfig } from '@github/copilot-sdk'
import type { Options as ClaudeOptions } from '@anthropic-ai/claude-agent-sdk'
import { withTempWorkspace } from '../../src/testing/workspace.ts'
import { A2aStore } from '../../src/a2a/store.ts'
import { A2aService } from '../../src/a2a/service.ts'
import { CodingBridgeConfigSchema, bridgeEnvironment } from './config.ts'
import { codingRunner, officialCodingSdks, type CodingSdks } from './providers.ts'
import { startCodingBridge } from './cli.ts'
import { CodingContexts } from './contexts.ts'

const owner = new ServerCallContext({ user: { isAuthenticated: true, userName: 'caller' } })
const request = (text: string, extra: Record<string, string> = {}) => SendMessageRequest.fromJSON({
  message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra },
})
const configFor = (root: string, type: 'claude' | 'codex' | 'copilot') => {
  const cwd = join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  return CodingBridgeConfigSchema.parse({
    projectId: 'p', stateDirectory: join(root, 'state'), cwd, port: 39000,
    server: { url: 'http://127.0.0.1:39000/projects/p/a2a', callers: { caller: 'A2A_BRIDGE_FIXTURE_TOKEN' } },
    backend: { type },
  })
}

test('all pinned official SDK modules load without starting a paid agent or FFI host', async () => {
  for (const backend of ['claude', 'codex', 'copilot'] as const) {
    assert.equal(typeof (await officialCodingSdks.load(backend))[backend], 'function')
  }
})

test('Claude adapter preserves native context, narrows tools, maps questions, and rejects permission escalation', async () => {
  await withTempWorkspace(async root => {
    const config = configFor(root, 'claude')
    const options: ClaudeOptions[] = []
    let closed = 0
    const nativeId = randomUUID()
    const sdk: CodingSdks['claude'] = input => {
      options.push(input.options)
      return {
        close() { closed++ },
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', session_id: nativeId }
          const decision = await input.options.canUseTool!('AskUserQuestion', {
            questions: [{ question: 'Language?', options: [{ label: 'TypeScript' }] }],
          }, { signal: new AbortController().signal, toolUseID: 'ask', requestId: 'ask' })
          assert.equal(decision?.behavior, 'allow')
          if (decision?.behavior !== 'allow') throw new Error('Missing input answer')
          assert.deepEqual(decision.updatedInput?.answers, { 'Language?': 'TypeScript' })
          yield { type: 'result', subtype: 'success', is_error: false, result: 'Claude result', session_id: nativeId }
        },
      }
    }
    const store = new A2aStore(config.stateDirectory); store.init()
    const service = new A2aService('p', { ...config.server, agentType: 'claude' }, store, codingRunner(config, { claude: sdk }))
    try {
      const first = await service.sendMessage(request('work'), owner)
      assert.equal(first.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED)
      const done = await service.sendMessage(request('TypeScript', { taskId: first.id }), owner)
      assert.equal(done.status?.state, TaskState.TASK_STATE_COMPLETED)
      const next = await service.sendMessage(request('follow up', { contextId: first.contextId }), owner)
      await service.sendMessage(request('TypeScript', { taskId: next.id }), owner)
      assert.equal(options[1].resume, nativeId)
      assert.deepEqual(options[0].tools, ['AskUserQuestion'])
      assert.deepEqual(options[0].allowedTools, [])
      assert.deepEqual(options[0].settingSources, [])
      assert.equal(options[0].env?.CLAUDE_CONFIG_DIR, join(config.stateDirectory, 'claude'))
      const denied = await options[0].canUseTool!('Bash', { command: 'ignored' }, { signal: new AbortController().signal, toolUseID: 'shell', requestId: 'shell' })
      assert.equal(denied?.behavior, 'deny')
      assert.equal(closed, 2)
      const record = store.inbound.get(first.id)!
      assert.throws(() => new CodingContexts(config).get({ ...record, owner: 'another' }), /owner or policy/)
      assert.throws(() => new CodingContexts({ ...config, model: 'different' }).get(record), /owner or policy/)
    } finally { await service.close() }
  })
})

test('Codex adapter requires an actual completed turn, retains context and uses a non-escalating sandbox', async () => {
  await withTempWorkspace(async root => {
    const config = configFor(root, 'codex')
    const nativeId = randomUUID()
    let resumed = false
    let fail = false
    const sdk: CodingSdks['codex'] = clientOptions => {
      assert.equal(clientOptions.env?.CODEX_HOME, join(config.stateDirectory, 'codex'))
      const start: ReturnType<CodingSdks['codex']>['startThread'] = options => {
        assert.equal(options.approvalPolicy, 'never')
        assert.equal(options.sandboxMode, 'read-only')
        assert.equal(options.networkAccessEnabled, false)
        return {
          id: nativeId,
          async runStreamed(_prompt, turn) {
            assert(turn?.signal)
            return { events: (async function* () {
              yield { type: 'thread.started' as const, thread_id: nativeId }
              yield { type: 'item.completed' as const, item: { type: 'agent_message' as const, id: 'text', text: 'Codex result' } }
              if (fail) yield { type: 'turn.failed' as const, error: { message: 'synthetic failure' } }
              else yield { type: 'turn.completed' as const, usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } }
            })() }
          },
        }
      }
      return { startThread: start, resumeThread: (id, options) => { assert.equal(id, nativeId); resumed = true; return start(options) } }
    }
    const store = new A2aStore(config.stateDirectory); store.init()
    const service = new A2aService('p', { ...config.server, agentType: 'codex' }, store, codingRunner(config, { codex: sdk }))
    try {
      const first = await service.sendMessage(request('work'), owner)
      assert.equal(first.status?.state, TaskState.TASK_STATE_COMPLETED)
      fail = true
      const second = await service.sendMessage(request('follow up', { contextId: first.contextId }), owner)
      assert.equal(second.status?.state, TaskState.TASK_STATE_FAILED)
      assert.equal(resumed, true)
      assert.deepEqual(second.artifacts, [])
    } finally { await service.close() }
  })
})

test('Copilot adapter maps input, denies permissions, closes its runtime and resumes only its native session', async () => {
  await withTempWorkspace(async root => {
    const config = configFor(root, 'copilot')
    const nativeId = randomUUID()
    let stop = 0
    let disconnect = 0
    let resumed = false
    let requirePermission = false
    const sdk: CodingSdks['copilot'] = options => {
      assert.equal(options.mode, 'empty')
      assert.equal(options.baseDirectory, join(config.stateDirectory, 'copilot'))
      const session = (settings: SessionConfig) => ({
        sessionId: nativeId,
        async sendAndWait() {
          assert.deepEqual(settings.availableTools, ['ask_user'])
          if (requirePermission) {
            const decision = await settings.onPermissionRequest!({
              kind: 'read', path: join(root, 'private'), intention: 'Synthetic permission check', managedApprovalRequired: true,
            }, { sessionId: nativeId })
            assert.equal(decision.kind, 'reject')
          } else {
            const answer = await settings.onUserInputRequest!({ question: 'Name?', choices: ['Shadow'], allowFreeform: false }, { sessionId: nativeId })
            assert.deepEqual(answer, { answer: 'Shadow', wasFreeform: false })
          }
          return { data: { content: 'Copilot result' } }
        },
        async abort() {},
        async disconnect() { disconnect++ },
      })
      return {
        async createSession(settings) { return session(settings) },
        async resumeSession(id, settings) { assert.equal(id, nativeId); resumed = true; return session(settings) },
        async stop() { stop++; return [] },
      }
    }
    const store = new A2aStore(config.stateDirectory); store.init()
    const service = new A2aService('p', { ...config.server, agentType: 'copilot' }, store, codingRunner(config, { copilot: sdk }))
    try {
      const first = await service.sendMessage(request('work'), owner)
      assert.equal(first.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED)
      assert.equal((await service.sendMessage(request('Shadow', { taskId: first.id }), owner)).status?.state, TaskState.TASK_STATE_COMPLETED)
      requirePermission = true
      const denied = await service.sendMessage(request('again', { contextId: first.contextId }), owner)
      assert.equal(denied.status?.state, TaskState.TASK_STATE_FAILED)
      assert.equal(resumed, true)
      assert.equal(disconnect, 2)
      assert.equal(stop, 2)
    } finally { await service.close() }
  })
})

test('real loopback bridge runs authenticated tasks and releases its journal on shutdown', async t => {
  await withTempWorkspace(async root => {
    const prior = process.env.A2A_BRIDGE_FIXTURE_TOKEN
    process.env.A2A_BRIDGE_FIXTURE_TOKEN = 'synthetic-bridge-token-at-least-32-characters'
    t.after(() => {
      if (prior === undefined) delete process.env.A2A_BRIDGE_FIXTURE_TOKEN
      else process.env.A2A_BRIDGE_FIXTURE_TOKEN = prior
    })
    const config = configFor(root, 'claude')
    const bridge = await startCodingBridge({ ...config, port: 0 }, {
      claude: () => ({
        close() {},
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'success', is_error: false, result: 'Through the bridge', session_id: randomUUID() }
        },
      }),
    })
    const url = `http://127.0.0.1:${bridge.port}/projects/p/a2a`
    try {
      assert.equal((await fetch(`${url}/.well-known/agent-card.json`)).status, 401)
      // The canonical advertised URL stays operator-controlled, not the Host header.
      const card = await fetch(`${url}/.well-known/agent-card.json`, { headers: { Authorization: `Bearer ${process.env.A2A_BRIDGE_FIXTURE_TOKEN}` } })
      assert.equal((await card.json()).supportedInterfaces[0].url, config.server.url)
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: `Bearer ${process.env.A2A_BRIDGE_FIXTURE_TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: SendMessageRequest.toJSON(request('work')) }),
      })
      const result = await response.json()
      assert.equal(result.result.task.status.state, 'TASK_STATE_COMPLETED')
      assert.equal(result.result.task.artifacts[0].parts[0].text, 'Through the bridge')
    } finally { await bridge.close() }
    const reopened = await startCodingBridge({ ...config, port: 0 }, { claude: () => { throw new Error('No execution') } })
    await reopened.close()
  })
})

test('bridge configuration rejects remote paths, dangerous bypass modes and ambient credentials', async t => {
  await withTempWorkspace(async root => {
    const config = configFor(root, 'codex')
    assert.throws(() => CodingBridgeConfigSchema.parse({ ...config, cwd: 'relative' }))
    assert.throws(() => CodingBridgeConfigSchema.parse({ ...config, backend: { type: 'codex', sandbox: 'danger-full-access' } }))
    const prior = process.env.A2A_PRIVATE_FIXTURE
    process.env.A2A_PRIVATE_FIXTURE = 'not-for-the-provider'
    t.after(() => {
      if (prior === undefined) delete process.env.A2A_PRIVATE_FIXTURE
      else process.env.A2A_PRIVATE_FIXTURE = prior
    })
    assert.equal(bridgeEnvironment([]).A2A_PRIVATE_FIXTURE, undefined)
    assert.equal(bridgeEnvironment(['A2A_PRIVATE_FIXTURE']).A2A_PRIVATE_FIXTURE, 'not-for-the-provider')
  })
})

for (const type of ['claude', 'codex', 'copilot'] as const) {
  test(`${type} cancellation waits for SDK cleanup and does not report a completed artifact`, { timeout: 10_000 }, async () => {
    await withTempWorkspace(async root => {
      const config = configFor(root, type)
      const entered = Promise.withResolvers<void>()
      let cleaned = false
      let aborted = false
      const sdk: Partial<CodingSdks> = {
        claude: options => ({
          close() { cleaned = true },
          async *[Symbol.asyncIterator]() {
            const controller = options.options.abortController!
            const stopped = Promise.withResolvers<never>()
            controller.signal.addEventListener('abort', () => { aborted = true; stopped.reject(controller.signal.reason) }, { once: true })
            entered.resolve()
            await stopped.promise
            yield { type: 'unexpected' }
          },
        }),
        codex: () => {
          const thread: ReturnType<CodingSdks['codex']>['startThread'] = () => ({
            id: randomUUID(),
            async runStreamed(_prompt, options) {
              return { events: (async function* () {
                const stopped = Promise.withResolvers<never>()
                options!.signal!.addEventListener('abort', () => { aborted = true; stopped.reject(options!.signal!.reason) }, { once: true })
                entered.resolve()
                try { await stopped.promise } finally { cleaned = true }
                yield { type: 'turn.started' as const }
              })() }
            },
          })
          return { startThread: thread, resumeThread: () => thread({}) }
        },
        copilot: () => {
          const create = async () => ({
            sessionId: randomUUID(),
            async sendAndWait() { entered.resolve(); return await new Promise<never>(() => {}) },
            async abort() { aborted = true },
            async disconnect() {},
          })
          return { createSession: create, resumeSession: create, async stop() { cleaned = true; return [] } }
        },
      }
      const store = new A2aStore(config.stateDirectory); store.init()
      const service = new A2aService('p', { ...config.server, agentType: type }, store, codingRunner(config, sdk))
      try {
        const input = request('work')
        input.configuration = { returnImmediately: true, acceptedOutputModes: [], taskPushNotificationConfig: undefined }
        const task = await service.sendMessage(input, owner)
        await entered.promise
        const canceled = await service.cancelTask({ id: task.id, tenant: '', metadata: undefined }, owner)
        assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED)
        assert.equal(aborted, true)
        assert.equal(cleaned, true)
        assert.deepEqual(canceled.artifacts, [])
      } finally { await service.close() }
    })
  })
}
