import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { agentToolTest } from './agent-tool-test.ts'
import type { ExecutionContext } from './context.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { SessionTools, Tools } from './registry.ts'

const context = { signal: new AbortController().signal } as ExecutionContext
const code = 'import request from "@shadow/issues"; export async function run(args) { const result = await request({ method: "GET", path: "/issues" }); return { count: result.body.length }; }'
const request = () => ({
  code, parameters: { type: 'object', properties: {}, additionalProperties: false },
  grants: [{ id: 'issues', kind: 'http' }],
  imports: ['@shadow/issues'], allowedModules: ['@shadow/issues'],
  cases: [{ name: 'one issue', args: {}, capabilityResults: { issues: { status: 200, body: [{ number: 42 }] } }, expected: { count: 1 } }],
})

test('worker tests use the shared published engine and report exact-source assertions without live requests', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not use network') })
  const result = JSON.parse(await agentToolTest.execute(request(), context))
  assert.equal(result.synthetic, true)
  assert.equal(result.passed, true)
  assert.equal(result.sourceHash, `sha256:${createHash('sha256').update(code).digest('hex')}`)
  assert.deepEqual(result.results[0], {
    name: 'one issue', passed: true, expected: { count: 1 }, actual: { count: 1 },
    calls: [{ name: 'issues', input: { method: 'GET', path: '/issues' } }],
  })
  assert.match(result.limitation, /not verified/)
})

test('Node module tests run exact ESM with the authored ceiling and synthetic named modules', async () => {
  const input = {
    ...request(), imports: ['node:path', '@shadow/issues'],
    allowedModules: ['node:path', '@shadow/issues'],
    code: 'import path from "node:path"; import {call} from "@shadow/issues"; export async function run() { const result = await call({method:"GET",path:"/" + path.posix.basename("/service/issues")}); return {count:result.body.length}; }',
  }
  const result = JSON.parse(await agentToolTest.execute(input, context))
  assert.equal(result.passed, true)
  assert.equal(result.policy.kind, 'restricted')
  assert.deepEqual(result.policy.imports, input.imports)
  assert.deepEqual(result.policy.allowedModules, input.allowedModules)
  assert.equal(result.sourceHash, `sha256:${createHash('sha256').update(input.code).digest('hex')}`)
  assert.deepEqual(result.results[0].calls, [{ name: 'issues', input: { method: 'GET', path: '/issues' } }])
  await assert.rejects(agentToolTest.execute({ ...input, allowedModules: [] }, context), /Module not allowed/)
  await assert.rejects(agentToolTest.execute({ ...input, allowedModules: undefined }, context), /allowedModules/)
  await assert.rejects(agentToolTest.execute({ ...input, grants: [] }, context), /synthetic grant metadata/)
  const denied = JSON.parse(await agentToolTest.execute({
    ...input, code: 'export function run() { return {count:1}; }',
    imports: ['node:fs'], allowedModules: ['node:fs'],
  }, context))
  assert.equal(denied.passed, false)
  assert.match(denied.results[0].error, /module|test|synthetic/i)
})

test('bad assertions and missing mocks are explicit failures, not a successful test receipt', async () => {
  const input = request()
  input.cases[0]!.expected.count = 9
  assert.equal(JSON.parse(await agentToolTest.execute(input, context)).passed, false)
  const missing = { ...request(), cases: [{ name: 'missing mock', args: {}, expected: null }] }
  const result = JSON.parse(await agentToolTest.execute(missing, context))
  assert.equal(result.passed, false)
  assert.match(result.results[0].error, /mock_missing/)
})

test('shared mocks exercise sequences, HTTP failures and transport errors without another VM harness', async () => {
  const input = {
    ...request(),
    code: 'import request from "@shadow/issues"; export async function run() { const outcomes = []; for (let i=0;i<3;i++) { try { outcomes.push((await request({method:"GET",path:"/issues"})).body); } catch (error) { outcomes.push({code:error.code,status:error.status ?? null}); } } return outcomes; }',
    cases: [{
      name: 'realistic repeated requests', args: {},
      capabilityResults: { issues: { sequence: [
        { status: 200, body: 'first response' },
        { status: 401, body: { message: 'not exposed to the script' } },
        { throws: { code: 'network_error' } },
      ] } },
      expected: ['first response', { code: 'http_status', status: 401 }, { code: 'network_error', status: null }],
    }],
  }
  const result = JSON.parse(await agentToolTest.execute(input, context))
  assert.equal(result.passed, true, JSON.stringify(result.results))
  assert.equal(result.results[0].calls.length, 3)
  const exhausted = JSON.parse(await agentToolTest.execute({
    ...input, code: 'import request from "@shadow/issues"; export async function run() { for(let i=0;i<4;i++) await request({method:"GET",path:"/issues"}); }',
    cases: [{ ...input.cases[0], capabilityResults: { issues: { sequence: [{ status: 200, body: [] }] } } }],
  }, context))
  assert.equal(exhausted.passed, false)
  assert.match(exhausted.results[0].error, /mock_missing/)
})

test('TypeScript uses the shared entrypoint while legacy non-exported functions fail', async () => {
  const source = 'typed.ts'
  const code = 'export async function run(args: { value: number }): Promise<number> { return args.value + 1; }'
  const input = {
    source, code, parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    grants: [], imports: [], allowedModules: [],
    cases: [{ name: 'typed entrypoint', args: { value: 2 }, expected: 3 }],
  }
  const receipt = JSON.parse(await agentToolTest.execute(input, context))
  assert.equal(receipt.passed, true)
  assert.equal(receipt.source, source)
  assert.equal(receipt.results[0].expected, 3)
  assert.equal(receipt.results[0].actual, 3)
  const legacy = JSON.parse(await agentToolTest.execute({
    ...input, code: 'async function run(args, capabilities) { return 3; }',
  }, context))
  assert.equal(legacy.passed, false)
  assert.match(legacy.results[0].error, /invalid_entry/)
})

test('inbox mocks preserve typed admission receipts without sending messages', async () => {
  const input = {
    code: 'import send from "@shadow/wake"; export async function run() { return await send({content:"investigate"}); }',
    parameters: { type: 'object' }, imports: ['@shadow/wake'], allowedModules: ['@shadow/wake'],
    grants: [{ id: 'wake', kind: 'inbox' }],
    cases: [{ name: 'admitted', args: {}, capabilityResults: {
      wake: { status: 'admitted', sessionId: 'web:worker', inputId: 'b7a3d5d8-2676-4f5f-bb4e-8906431a3aa5' },
    }, expected: { status: 'admitted', sessionId: 'web:worker', inputId: 'b7a3d5d8-2676-4f5f-bb4e-8906431a3aa5' } }],
  }
  assert.equal(JSON.parse(await agentToolTest.execute(input, context)).passed, true)
  await assert.rejects(agentToolTest.execute({
    ...input, cases: [{ ...input.cases[0], capabilityResults: { wake: { admitted: true } } }],
  }, context))
})

test('raw API mock payloads are rejected in favor of the actual status/body envelope', async () => {
  const input = request()
  await assert.rejects(agentToolTest.execute({
    ...input, cases: [{ ...input.cases[0], capabilityResults: { issues: [{ number: 42 }] } }],
  }, context))
  await assert.rejects(agentToolTest.execute({
    ...input, cases: [{ name: 'missing expected', args: {}, capabilityResults: {} }],
  }, context), /explicit expected/)
  await assert.rejects(agentToolTest.execute({
    ...input, cases: [{ ...input.cases[0], args: { unexpected: true } }],
  }, context))
  for (const expected of [undefined, NaN, Infinity]) {
    await assert.rejects(agentToolTest.execute({
      ...input, cases: [{ ...input.cases[0], expected }],
    }, context), /JSON|finite|undefined/i)
  }
})

test('developer test runner exposes no ambient Node/network globals and preserves cancellation', async () => {
  const result = JSON.parse(await agentToolTest.execute({
    code: 'export function run() { return [typeof process, typeof require, typeof fetch]; }',
    parameters: { type: 'object', properties: {} }, grants: [], allowedModules: [],
    cases: [{ name: 'globals', args: {}, expected: ['undefined', 'undefined', 'undefined'] }],
  }, context))
  assert.equal(result.passed, true)
  const aborted = AbortSignal.abort()
  await assert.rejects(agentToolTest.execute(request(), { ...context, signal: aborted }))
})

test('worker tooling does not publish, edit drafts or accept credential/live execution options', async () => {
  for (const extra of [{ live: true }, { credentials: {} }, { publish: true }, { expectedRevision: 'fake' }, { runtime: 'quickjs' }, { runtime: 'node-vm' }, { capabilities: [] }]) {
    await assert.rejects(agentToolTest.execute({ ...request(), ...extra }, context))
  }
})

test('test batches bound aggregate fixture and report sizes', async () => {
  const input = request()
  await assert.rejects(agentToolTest.execute({
    ...input, cases: [{ ...input.cases[0], expected: 'x'.repeat(1024 * 1024) }],
  }, context), /input exceeds 1 MiB/)
  await assert.rejects(agentToolTest.execute({
    code: 'export function run() { return "x".repeat(200000); }',
    parameters: { type: 'object' }, grants: [], allowedModules: [],
    cases: [1, 2, 3].map(number => ({ name: String(number), args: {}, expected: null })),
  }, context), /report exceeds 512 KiB/)
})

test('developer sessions can import the tester without granting it to the coordinator', async () => {
  const home = process.cwd()
  const importer = new ImportTool(new Map([['agent_tool_test', agentToolTest]]), home)
  const tools = new SessionTools(new Tools(home), home)
  assert.doesNotMatch(await importer.importSource({ source: 'v:tools/agent_tool_test' }, tools), /^Error/)
  const result = await new InvokeTool(importer).execute({ name: 'agent_tool_test', args: request() }, { ...context, tools })
  assert.equal(JSON.parse(result).passed, true)
})
