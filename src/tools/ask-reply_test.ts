import { requireToolText } from './tool.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from './context.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { YieldError, YieldManager } from '../sessions/yield.ts'
import { SessionTools, Tools } from './registry.ts'
import { AskTool } from './ask.ts'
import { ReplyTool } from './reply.ts'
import { InputRequests } from '../sessions/input-requests.ts'
import { decisionBrief } from '../testing/decision.ts'

const question = { kind: 'decision', question: 'Choose?', options: ['A', 'B', 'C'], default_option: 'B', brief: decisionBrief }
const context = (sessionId: string, signal = new AbortController().signal) => ({ sessionId, signal }) as ExecutionContext
const invalid = (error: unknown) => error instanceof YieldError && error.code === 'invalid_request'

function fixture() {
  const states: Record<string, SessionState> = {
    root: { sessionId: 'root', segmentIndex: 0 },
    parent: { sessionId: 'parent', segmentIndex: 0 },
    child: { sessionId: 'child', segmentIndex: 0, parent: { id: 'parent' }, reportTo: 'root' },
  }
  const yields = new YieldManager({
    getState: id => states[id], getPolicy: () => ({ timeoutMs: null }),
    notifyUser: async () => {}, notifyParent: async () => {},
  })
  const inputs = new InputRequests({
    getState: id => states[id], assertAccess: () => {}, hasDecision: id => !!yields.get(id),
    timeout: () => null, changed: () => {}, write: async () => {}, notify: async () => {},
  })
  return { yields, inputs, tool: new AskTool(yields, inputs), reply: new ReplyTool(yields, inputs) }
}

test('ask decision waits for the human and returns a JSON answer receipt', async () => {
  const { tool, reply, yields } = fixture()
  assert.equal(tool.name, 'ask')
  assert.equal(tool.readonly, false)
  const schema = tool.parameters.properties.options as Record<string, unknown>
  assert.equal(schema.minItems, 2)
  assert.equal(schema.maxItems, 2)
  assert.equal(schema.uniqueItems, true)
  assert.equal(tool.parameters.additionalProperties, false)
  const waiting = tool.execute(question, context('root'))
  let settled = false
  void waiting.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  const request = yields.get('root')!
  assert.deepEqual(request.recipient, { kind: 'user', sessionId: 'root' })
  const receipt = await yields.answerUser('root', request.id, 'C')
  assert.deepEqual(JSON.parse(await waiting), receipt)
})

test('input asks return plain text and A2A callers cannot request local human decisions', async () => {
  const { tool, inputs } = fixture()
  await assert.rejects(tool.execute({ kind: 'input', question: 'Path?', options: ['A', 'B'] }, context('root')), invalid)
  await assert.rejects(tool.execute({ action: 'answer', request_id: 'old', option: 'A' }, context('root')), invalid)
  await assert.rejects(tool.execute(question, { ...context('root'), channel: 'a2a' }), /not a local human decision authority/)
  const waiting = tool.execute({ kind: 'input', question: 'Which path?' }, context('root'))
  await new Promise(resolve => setImmediate(resolve))
  const request = inputs.get('root')!
  const answer = await inputs.replyUser('root', request.id, 'fixture-path')
  assert.deepEqual(JSON.parse(await waiting), answer)
  assert.equal('approved' in answer, false)
})

test('reply answers a real child request and releases both calls with the same receipt', async () => {
  const { tool, reply, yields } = fixture()
  const waiting = tool.execute({ action: 'ask', ...question }, context('child'))
  const request = yields.get('child')!
  assert.deepEqual(request.recipient, { kind: 'parent', sessionId: 'parent' })
  const answer = await reply.execute({ request_id: request.id, text: 'A' }, context('parent'))
  assert.deepEqual(JSON.parse(await waiting), JSON.parse(answer))
  assert.equal(JSON.parse(answer).answeredBy, 'parent')
  await assert.rejects(reply.execute({ request_id: request.id, text: 'A' }, context('parent')),
    error => error instanceof YieldError && error.code === 'not_found')
})

test('tool never impersonates user, reportTo or another parent', async () => {
  const { tool, reply, yields } = fixture()
  const root = tool.execute(question, context('root'))
  const child = tool.execute(question, context('child'))
  for (const [request, sessionId] of [[yields.get('root')!, 'root'], [yields.get('child')!, 'root'], [yields.get('child')!, 'child']] as const) {
    await assert.rejects(reply.execute({ request_id: request.id, text: 'A' }, context(sessionId)),
      error => error instanceof YieldError && error.code === 'forbidden')
  }
  yields.answerUser('root', yields.get('root')!.id, 'A')
  await reply.execute({ request_id: yields.get('child')!.id, text: 'A' }, context('parent'))
  await Promise.all([root, child])
})

test('tool validates action-specific inputs and forbids model overrides of routing or timeout', async () => {
  const { tool, reply, yields } = fixture()
  for (const args of [
    {}, { action: 'invalid' }, { action: null }, { ...question, options: ['A'] },
    { ...question, options: [, 'B', 'C'] },
    { ...question, options: ['A', 'B', 'B'] }, { ...question, default_option: 'b' },
    { ...question, timeoutMs: 1 }, { ...question, timeout: 1 }, { ...question, recipient: 'root' },
    { ...question, sessionId: 'parent' }, { ...question, request_id: 'other' },
    { action: 'answer' }, { action: 'answer', request_id: 1, text: 'A' },
    { action: 'answer', request_id: '', text: 'A' }, { action: 'answer', request_id: 'id', option: 1 },
    { action: 'answer', request_id: 'id', text: 'A', question: 'Extra' },
    { action: 'answer', request_id: 'id', text: 'A', recipient: 'parent' },
  ]) await assert.rejects(tool.execute(args, context('root')), invalid)
  assert.equal(yields.get('root'), null)
})

test('binary decisions wait for an explicit authorized answer without an artificial third option', async () => {
  const { tool, reply, yields } = fixture()
  const waiting = tool.execute({ kind: 'decision', question: 'Continue?', options: ['Yes', 'No'], default_option: 'No', brief: decisionBrief }, context('root'))
  const request = yields.get('root')!
  assert.deepEqual(request.options, ['Yes', 'No'])
  await assert.rejects(reply.execute({ request_id: request.id, text: 'Yes' }, context('root')),
    error => error instanceof YieldError && error.code === 'forbidden')
  yields.answerUser('root', request.id, 'No')
  assert.equal(JSON.parse(await waiting).option, 'No')
})

test('abort propagates for ask and prevents an aborted parent from answering', async () => {
  const { tool, reply, yields } = fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute(question, context('root', controller.signal)), { name: 'AbortError' })
  assert.equal(yields.get('root'), null)
  const later = new AbortController()
  const waiting = tool.execute(question, context('child', later.signal))
  const request = yields.get('child')!
  await assert.rejects(reply.execute({ request_id: request.id, text: 'A' }, context('parent', controller.signal)), { name: 'AbortError' })
  assert.ok(yields.get('child'))
  const rejected = assert.rejects(waiting, { name: 'AbortError' })
  later.abort()
  await rejected
  assert.equal(yields.get('child'), null)
})

test('remote workdir context uses local coordination without touching executor or filesystem', async () => {
  const { tool, reply, yields } = fixture()
  assert.equal(tool.supportsRemoteWorkdir, true)
  const registry = new Tools('unused-no-filesystem')
  registry.register(tool)
  assert.equal(registry.isReadonly('ask'), false)
  const remote = context('child')
  remote.tools = new SessionTools(registry, 'unused-no-filesystem')
  remote.cwd = 'opaque remote path'
  remote.remoteWorkdir = {
    nodeId: 'remote-node', capabilityId: 'remote-workdir',
    executor: new Proxy({}, { get: () => { throw new Error('Yield must not invoke the remote executor') } }) as NonNullable<ExecutionContext['remoteWorkdir']>['executor'],
  }
  const waiting = registry.execute('ask', question, remote)
  // Registry awaits beforeExecute hooks before invoking the tool.
  await new Promise(resolve => setImmediate(resolve))
  const request = yields.get('child')!
  if (!request) assert.fail(`Expected pending ask: ${requireToolText(await waiting)}`)
  yields.answerParent('parent', request.id, 'C')
  assert.equal(JSON.parse(requireToolText(await waiting)).option, 'C')
})
