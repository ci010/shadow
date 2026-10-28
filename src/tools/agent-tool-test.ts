import { z } from 'zod'
import { authoredModuleCall } from '../agent-authoring/tool-runtime.ts'
import { evaluateScriptCases } from '../script-runtime/evaluate.ts'
import { ScriptImportsSchema, assertImportPolicy, importedModules } from '../script-runtime/module-policy.ts'
import { CapabilityError, validateJsonSchema } from '../agent-authoring/capabilities.ts'
import { createMockResponder, validateMockResult } from '../agent-authoring/mock-results.ts'
import type { Tool } from './tool.ts'

const grantSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  kind: z.enum(['http', 'inbox', 'proposal-inbox']),
}).strict()
const inputSchema = z.object({
  code: z.string().min(1).max(256 * 1024),
  parameters: z.record(z.unknown()),
  source: z.string().regex(/^[a-zA-Z0-9_-]+\.(?:js|ts)$/).default('tool.js'),
  grants: z.array(grantSchema).max(32),
  imports: ScriptImportsSchema.default([]),
  allowedModules: ScriptImportsSchema,
  cases: z.array(z.object({
    name: z.string().min(1).max(160),
    args: z.record(z.unknown()),
    capabilityResults: z.record(z.unknown()).default({}),
    expected: z.unknown(),
  }).strict()).min(1).max(12),
}).strict()
export const agentToolTest: Tool = {
  name: 'agent_tool_test',
  description: 'Test exact ESM run(args) source with the shared engine before staging or publication. Supply imports, agent allowedModules, parameter schema, grant mock types and expected cases. HTTP mocks are {status,body} (non-2xx throws like the broker); inbox mocks are {status:"admitted",sessionId,inputId}. Use {throws:{code,status?}} for failures or {sequence:[receipts/errors]} for repeated calls. Pure native modules and mocked @shadow imports only; no credentials or delivery. Returns source hash and actual/expected evidence; mocks do not prove live permissions.',
  readonly: true,
  parameters: {
    type: 'object', properties: {
      code: { type: 'string', description: 'Exact ESM source exporting async function run(args).' },
      source: { type: 'string', description: 'Source filename ending in .js or .ts; defaults to tool.js. TypeScript supports erasable syntax only.' },
      imports: { type: 'array', items: { type: 'string' }, description: 'Exact imports declared on the skill tool.' },
      allowedModules: { type: 'array', items: { type: 'string' }, description: 'Exact authored agent module ceiling; required, [] grants no imports.' },
      parameters: { type: 'object', description: 'The authored tool parameter JSON schema.' },
      grants: { type: 'array', description: 'Mock result types for imported @shadow modules; not permission grants.', items: { type: 'object', properties: {
        id: { type: 'string' }, kind: { type: 'string' },
      }, required: ['id', 'kind'] } },
      cases: { type: 'array', description: '1-12 objects: {name, args, capabilityResults: {capabilityId: mockReceipt}, expected: <any JSON value>}. Each expected value is required.',
        items: { type: 'object' } },
    }, required: ['code', 'parameters', 'grants', 'allowedModules', 'cases'], additionalProperties: false,
  },
  async execute(args, context) {
    const input = inputSchema.parse(args)
    assertImportPolicy(input.imports, input.allowedModules)
    for (const name of importedModules(input.imports)) {
      if (!input.grants.some(grant => grant.id === name)) throw new Error(`Imported module requires synthetic grant metadata: ${name}`)
    }
    if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw new Error('Synthetic test input exceeds 1 MiB.')
    if (new Set(input.grants.map(grant => grant.id)).size !== input.grants.length) {
      throw new Error('Synthetic grants must have distinct names.')
    }
    for (const scenario of input.cases) {
      if (!Object.hasOwn(scenario, 'expected')) throw new Error('Each test requires explicit expected JSON output.')
      validateJsonSchema(input.parameters, scenario.args)
      for (const [name, result] of Object.entries(scenario.capabilityResults)) {
        const grant = input.grants.find(grant => grant.id === name)
        if (!grant) throw new Error(`Synthetic result has no grant metadata: ${name}`)
        validateMockResult(grant.kind === 'proposal-inbox' ? 'inbox' : grant.kind, result)
      }
    }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(60_000)])
    let callBytes = 0
    const calls = input.cases.map(() => [] as Array<{ name: string; input: Record<string, unknown> }>)
    const responders = input.cases.map(scenario => createMockResponder(scenario.capabilityResults))
    const evaluation = await evaluateScriptCases({
      code: input.code, signal, filename: input.source, entry: 'run',
      policy: { kind: 'restricted', mode: 'test', imports: input.imports },
    }, input.cases.map((scenario, index) => ({
      name: scenario.name, args: scenario.args, expected: scenario.expected,
      callModule: authoredModuleCall(async (name, args, signal) => {
        signal.throwIfAborted()
        if (!input.imports.includes(`@shadow/${name}`)) {
          throw new CapabilityError('capability_denied', 'Undeclared synthetic module.')
        }
        const call = { name, input: structuredClone(args) }
        callBytes += Buffer.byteLength(JSON.stringify(call))
        if (callBytes > 256 * 1024) throw new CapabilityError('response_too_large', 'Synthetic call recording exceeds 256 KiB.')
        calls[index].push(call)
        return responders[index](name)
      }),
    })))
    const results = evaluation.cases.map((result, index) => ({
      ...result, expected: input.cases[index].expected, calls: calls[index],
    }))
    if (Buffer.byteLength(JSON.stringify(results)) > 512 * 1024) {
      throw new Error('Synthetic test report exceeds 512 KiB. Split the cases or reduce their output.')
    }
    return JSON.stringify({
      synthetic: true, sourceHash: `sha256:${evaluation.sourceHash}`,
      source: input.source,
      policy: { ...evaluation.policy, allowedModules: input.allowedModules },
      grants: input.grants,
      passed: evaluation.passed, results,
      limitation: 'Mock-only execution. Real grant matching, credentials, HTTP access and message delivery are not verified.',
    })
  },
}
