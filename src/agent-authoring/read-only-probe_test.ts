import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { ResolvedConversationPolicy } from './contracts.ts'
import { CapabilityError } from './capabilities.ts'
import { probeTool } from './read-only-probe.ts'

const revision = `sha256:${'a'.repeat(64)}`
const address = { projectId: 'a', botInstanceId: 'bot', platform: 'qq', conversationId: 'group:room' }
const context = () => ({
  projectId: 'a', sessionId: 'web:orchestrator', channel: 'web', inputSource: 'user' as const,
  admin: true, isGroup: false, messageId: randomUUID(), signal: new AbortController().signal,
})
function fixture() {
  const calls: Array<unknown> = []
  let current = true
  const policy: ResolvedConversationPolicy = {
    revision,
    binding: {
      botInstanceId: 'bot', platform: 'qq', conversationId: 'group:room', enabled: true,
      agent: 'support', skills: ['issues'], readFolders: [], parameters: {},
      grants: [
        { id: 'issues', kind: 'http', origin: 'https://example.com', routes: [{ method: 'GET', path: '/issues' }, { method: 'POST', path: '/issues' }] },
        { id: 'notify', kind: 'inbox', sessionId: 'web:worker' },
      ],
    },
    agent: { name: 'support', description: '', source: 'workspace', defaultMode: 'session', prompt: '', allowedTools: ['issues'], allowedModules: ['@shadow/issues', '@shadow/notify'] },
    skillPrompts: [],
    tools: [{
      name: 'issues', skill: 'issues', source: 'issues.js', description: 'Issues',
      parameters: { type: 'object', properties: { method: { type: 'string' }, cap: { type: 'string' } }, required: ['method'], additionalProperties: false },
      imports: ['@shadow/issues', '@shadow/notify'],
      code: 'import request from "@shadow/issues"; import notify from "@shadow/notify"; export async function run(args) { return await (args.cap === "notify" ? notify : request)({ method: args.method, path: "/issues" }); }',
    }],
  }
  const dependencies: Parameters<typeof probeTool>[0] = {
    projectId: 'a', resolve: () => policy,
    assertCurrent: () => { if (!current) throw new Error('Published revision changed.') },
    broker: { execute: async (grant, input, ctx) => {
      calls.push({ grant, input, sessionId: ctx.sessionId })
      ctx.onHttpProgress?.({ stage: 'request' })
      ctx.onHttpProgress?.({ stage: 'response', status: 200 })
      return { status: 200, body: [{ number: 42 }] }
    } },
  }
  const input = { address, target: 'published' as const, revision, toolName: 'issues', args: { method: 'GET' } }
  return { policy, calls, dependencies, input, revoke: () => { current = false } }
}

test('explicit published probes record source, authorization and successful HTTP evidence without bot messages', async () => {
  const f = fixture()
  const result = await probeTool(f.dependencies, f.input, context())
  assert.deepEqual(result.calls, [{
    capability: 'issues', method: 'GET', path: '/issues', phase: 'response', outcome: 'succeeded',
    requestAttempted: true, responseReceived: true, httpStatus: 200,
  }])
  assert.equal(result.synthetic, false)
  assert.equal(result.target, 'published')
  assert.equal(result.execution, 'completed')
  assert.equal(result.httpVerified, true)
  assert.equal(result.revision, revision)
  assert.equal(result.authorizationRevision, revision)
  assert.deepEqual(result.result, { status: 200, body: [{ number: 42 }] })
  assert.deepEqual(f.calls, [{
    grant: f.policy.binding.grants[0], input: { method: 'GET', path: '/issues' }, sessionId: 'web:orchestrator',
  }])
})

test('probes reject stale/missing policies and non-owner contexts before any capability is invoked', async () => {
  const f = fixture()
  for (const change of [
    { admin: false }, { sessionId: 'web:worker' }, { inputSource: 'session' as const },
    { inputSource: 'event' as const }, { projectId: 'b' }, { channel: 'qq' },
  ]) await assert.rejects(probeTool(f.dependencies, f.input, { ...context(), ...change }), /direct owner/)
  await assert.rejects(probeTool(f.dependencies, { ...f.input, revision: 'draft' }, context()), /exact revision/)
  f.policy.binding.enabled = false
  await assert.rejects(probeTool(f.dependencies, f.input, context()), /enabled published/)
  assert.equal(f.calls.length, 0)
})

test('granted writes and inbox delivery remain failed, even if script code catches the denial', async () => {
  const f = fixture()
  for (const args of [{ method: 'POST' }, { method: 'GET', cap: 'notify' }]) {
    const result = await probeTool(f.dependencies, { ...f.input, args }, context())
    assert.equal(result.execution, 'failed')
    assert.equal(result.error?.code, 'route_denied')
    assert.equal(result.calls[0].outcome, 'denied')
    assert.equal(result.calls[0].requestAttempted, false)
  }
  f.policy.tools[0].code = 'import request from "@shadow/issues"; export async function run() { try { await request({ method: "POST", path: "/issues" }); } catch {} return "pretend success"; }'
  const caught = await probeTool(f.dependencies, f.input, context())
  assert.equal(caught.result, 'pretend success')
  assert.equal(caught.execution, 'failed')
  assert.equal(caught.error?.code, 'route_denied')
  assert.equal(f.calls.length, 0)
})

test('revocation and abort prevent a stale live result from being reported as a current success', async () => {
  const f = fixture()
  f.dependencies.broker.execute = async () => { f.revoke(); return { status: 200, body: [] } }
  await assert.rejects(probeTool(f.dependencies, f.input, context()))
  await assert.rejects(probeTool(f.dependencies, f.input, { ...context(), signal: AbortSignal.abort() }))
})

test('draft code runs with existing approved grants; draft grant changes cannot acquire authority', async () => {
  const f = fixture()
  const draft = structuredClone(f.policy)
  draft.revision = `sha256:${'b'.repeat(64)}`
  draft.tools[0].code = 'import request from "@shadow/issues"; export async function run() { return {version:"new", response:await request({method:"GET",path:"/issues"})}; }'
  f.dependencies.resolve = (_id, target) => target === 'published' ? f.policy : draft
  const input = { ...f.input, target: 'draft' as const, revision: draft.revision }
  const result = await probeTool(f.dependencies, input, context())
  assert.equal(result.revision, draft.revision)
  assert.equal(result.authorizationRevision, revision)
  assert.deepEqual(result.result, { version: 'new', response: { status: 200, body: [{ number: 42 }] } })
  draft.binding.grants[0] = { ...draft.binding.grants[0], kind: 'http', origin: 'https://unapproved.example.com', routes: [{ method: 'GET', path: '/issues' }] }
  const denied = await probeTool(f.dependencies, input, context())
  assert.equal(denied.error?.code, 'grant_not_approved')
  assert.equal(denied.calls[0].requestAttempted, false)
  assert.equal(f.calls.length, 1)
})

test('caught capability failures keep safe error/status evidence; arbitrary transport details are not exposed', async () => {
  const f = fixture()
  f.policy.tools[0].code = 'import request from "@shadow/issues"; export async function run() { try {return await request({method:"GET",path:"/issues"});} catch (error) {return {ok:false,code:error.code,hasDiagnostics:error.diagnostics !== undefined};} }'
  const diagnostics = {
    source: 'untrusted-http-response' as const, message: 'Bad credentials',
    headers: { 'x-github-request-id': 'request-1' }, truncated: false,
  }
  f.dependencies.broker.execute = async (_grant, _input, ctx) => {
    ctx.onHttpProgress?.({ stage: 'request' })
    ctx.onHttpProgress?.({ stage: 'response', status: 401 })
    throw new CapabilityError('http_status', 'PRIVATE RESPONSE AND SECRET', 401, diagnostics)
  }
  const result = await probeTool(f.dependencies, f.input, context())
  assert.deepEqual(result.error, { code: 'http_status', httpStatus: 401 })
  assert.equal(result.calls[0].phase, 'response')
  assert.equal(result.calls[0].responseReceived, true)
  assert.equal(result.execution, 'failed')
  assert.deepEqual(result.calls[0].diagnostics, diagnostics)
  assert.deepEqual(result.result, { ok: false, code: 'http_status', hasDiagnostics: false })
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE RESPONSE AND SECRET/)
  f.dependencies.broker.execute = async () => { throw new CapabilityError('unknown_secret', 'PRIVATE SECRET REFERENCE') }
  const missing = await probeTool(f.dependencies, f.input, context())
  assert.equal(missing.calls[0].phase, 'credential')
  assert.equal(missing.calls[0].requestAttempted, false)
  assert.equal(missing.httpVerified, false)
  assert.equal(missing.calls[0].diagnostics, undefined)
  f.dependencies.broker.execute = async () => { throw new Error('PRIVATE TRANSPORT DETAILS') }
  const unexpected = await probeTool(f.dependencies, f.input, context())
  assert.equal(unexpected.error?.code, 'capability_failed')
  assert.doesNotMatch(JSON.stringify(unexpected), /PRIVATE TRANSPORT DETAILS/)
})

test('effectful native imports remain denied before any service invocation', async () => {
  const f = fixture()
  for (const name of ['node:fs', 'node:fs/promises', 'node:http', 'node:https', 'node:net']) {
    f.policy.tools[0].imports = [name]
    f.policy.agent.allowedModules = [name]
    f.policy.tools[0].code = 'export function run() { return "unused native import"; }'
    const result = await probeTool(f.dependencies, f.input, context())
    assert.equal(result.execution, 'failed')
    assert.equal(result.httpVerified, false)
    assert.deepEqual(result.calls, [])
  }
  assert.equal(f.calls.length, 0)
})
