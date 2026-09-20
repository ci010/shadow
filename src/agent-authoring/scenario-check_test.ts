import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { access } from 'node:fs/promises'
import type { LLMProvider, LLMResponse } from '../providers/provider.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { evaluateAuthoringScenario } from '../sessions/authoring-evaluation.ts'
import type { ResolvedConversationPolicy } from './contracts.ts'
import { AgentAuthoringService } from './service.ts'
import { runAuthoringScenario, type AuthoringScenario } from './scenario-check.ts'

const workspace = join(process.cwd(), '.test-artifacts', `nonexistent-scenario-${randomUUID()}`)
const policy: ResolvedConversationPolicy = {
  revision: 'candidate-revision',
  agent: {
    name: 'candidate', description: 'Candidate agent', prompt: 'Only handle issues.',
    allowedTools: ['read', 'search', 'issue_create'], defaultMode: 'session', source: 'workspace',
  },
  binding: {
    botInstanceId: 'bot', platform: 'qq', conversationId: 'conversation', enabled: true,
    agent: 'candidate', skills: ['issues'], readFolders: ['docs'], parameters: {}, grants: [],
  },
  skillPrompts: [{ name: 'issues', content: 'Check for duplicates before filing.' }],
  tools: [{
    name: 'issue_create', skill: 'issues', source: 'create.ts', description: 'Create issue.',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
    imports: [],
    code: 'throw new Error("REAL_AUTHORED_CODE_MUST_NOT_EXECUTE")',
  }],
}

function service() {
  const forbidden = () => { throw new Error('Real runtime capability accessed') }
  return new AgentAuthoringService({
    projectId: 'scenario-project', workspace,
    store: new Proxy({} as AgentAuthoringService['options']['store'], { get: forbidden }),
    broker: new Proxy({} as AgentAuthoringService['options']['broker'], { get: forbidden }),
    folders: { get: () => undefined, requireAvailable: forbidden, acquireAccess: forbidden },
  })
}

async function run(scenario: AuthoringScenario, responses: Array<LLMResponse | Error>) {
  const authoring = service()
  const calls: Array<{ prompt: unknown; definitions: unknown }> = []
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => [],
    chat: async (messages, definitions) => {
      calls.push({ prompt: messages[0].content, definitions: structuredClone(definitions) })
      const response = responses.shift()
      assert.ok(response, 'Unexpected provider call')
      if (response instanceof Error) throw response
      return response
    },
  }
  const result = await runAuthoringScenario({
    service: authoring, policy, scenario, signal: new AbortController().signal,
    evaluate: (prompt, tools, input, signal) => evaluateAuthoringScenario({
      workspace, projectId: 'scenario-project', provider,
      llm: { model: 'configured', contextWindow: 128_000, temperature: 0 }, prompt, tools, input, signal,
    }),
  })
  for (const call of calls) {
    assert.equal(call.prompt, authoring.prompt(policy, '(preview)').systemPrompt)
    assert.deepEqual(call.definitions, authoring.tools(policy, '(preview)').getDefinitions())
  }
  return result
}
function call(name: string, args: Record<string, unknown> = {}): LLMResponse {
  return { content: null, toolCalls: [{ id: randomUUID(), name, arguments: args }] }
}
const done: LLMResponse = { content: 'Created synthetic issue #7.', toolCalls: [] }

test('ordinary LLM loop sees exact assembled prompt and definitions; all tools use synthetic receipts', async () => {
  const result = await run({
    input: 'Investigate and file issue', toolResults: {
      read: 'Synthetic guide', search: { matches: [] }, issue_create: { id: 7, status: 'created' },
    },
    expectedTools: ['read', 'search', 'issue_create'], forbiddenTools: ['exec'],
    responseIncludes: ['#7'], responseExcludes: ['real issue'],
  }, [
    call('read', { path: 'folder:docs/guide.txt' }),
    call('search', { path: 'folder:docs/guide.txt', query: 'duplicate' }),
    call('issue_create', { title: 'Synthetic issue' }), done,
  ])
  assert.equal(result.status, 'passed')
  assert.equal(result.llmExecuted, true)
  assert.equal(result.syntheticTools, true)
  assert.equal(result.checks.length, 6)
  assert.ok(result.checks.every(check => check.passed))
  assert.deepEqual(result.toolCalls.map(call => call.name), ['read', 'search', 'issue_create'])
  assert.deepEqual(result.toolCalls[2].args, { title: 'Synthetic issue' })
  assert.deepEqual(result.toolCalls[2].result, { id: 7, status: 'created' })
  await assert.rejects(access(workspace), { code: 'ENOENT' })
})

test('no assertions is completed, never a behavioral pass', async () => {
  const result = await run({ input: 'Question', toolResults: {} }, [done])
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.checks, [])
})

test('must-call and forbidden aliases are evaluated mechanically, not by response claims', async () => {
  const result = await run({
    input: 'Say you created an issue', toolResults: { read: 'Synthetic guide' },
    expectedTools: ['issue_create'], forbiddenTools: ['read'],
  }, [call('read', { path: 'folder:docs/guide.txt' }), done])
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.checks.map(check => check.passed), [false, false])
})

test('missing receipts and unknown tool aliases terminate the run', async () => {
  for (const name of ['issue_create', 'exec']) {
    const result = await run({ input: 'Question', toolResults: {} }, [call(name, { title: 'Issue' })])
    assert.equal(result.status, 'failed')
    assert.match(result.toolCalls[0].error!, /Missing synthetic receipt|Unknown scenario tool/)
    assert.equal(result.modelRounds, 1)
    assert.equal(result.messages.at(-1)?.role, 'tool')
  }
})

test('tool arguments must conform to the selected published schema', async () => {
  const result = await run({ input: 'Question', toolResults: { issue_create: null } }, [call('issue_create', { title: 7 })])
  assert.equal(result.status, 'failed')
  assert.match(result.error!, /Invalid tool arguments/)
  assert.equal(result.toolCalls[0].result, undefined)
})

test('sequences are consumed per alias; exhaustion fails rather than fabricating a receipt', async () => {
  const result = await run({
    input: 'Question', toolResults: { issue_create: { sequence: [null, ['arbitrary', 'JSON']] } },
  }, [
    call('issue_create', { title: 'First' }), call('issue_create', { title: 'Second' }),
    call('issue_create', { title: 'Third' }),
  ])
  assert.equal(result.status, 'failed')
  assert.equal(result.toolCalls[0].result, null)
  assert.deepEqual(result.toolCalls[1].result, ['arbitrary', 'JSON'])
  assert.match(result.toolCalls[2].error!, /exhausted/)
})

test('single JSON receipts repeat and large results never write truncation files', async () => {
  const receipt = 'x'.repeat(20_000)
  const result = await run({
    input: 'Question', toolResults: { issue_create: receipt },
  }, [call('issue_create', { title: 'First' }), call('issue_create', { title: 'Second' }), done])
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.toolCalls.map(call => call.result), [receipt, receipt])
  assert.deepEqual(result.messages.filter(message => message.role === 'tool').map(message => message.content), [receipt, receipt])
  await assert.rejects(access(workspace), { code: 'ENOENT' })
})

test('malformed or excessive fixtures and assertions never invoke the model', async () => {
  for (const scenario of [
    { input: 'Question', toolResults: { issue_create: { sequence: [] } } },
    { input: 'Question', toolResults: { issue_create: undefined } },
    { input: 'Question', toolResults: { issue_create: 'x'.repeat(256 * 1024) } },
    { input: 'Question', toolResults: {}, responseIncludes: [''] },
  ]) {
    await assert.rejects(run(scenario, []), /sequence|JSON|256 KiB|assertions/)
  }
})

test('provider errors are explicit failed evidence, never a completed scenario', async () => {
  const result = await run({
    input: 'Question', toolResults: {}, forbiddenTools: ['exec'],
  }, [new Error('Configured provider unavailable')])
  assert.equal(result.status, 'failed')
  assert.equal(result.executionStatus, 'failed')
  assert.equal(result.error, 'Configured provider unavailable')
  assert.equal(result.llmExecuted, true)
})

test('cancellation maps to durable failed status while preserving execution status', async () => {
  const signal = AbortSignal.abort()
  const result = await runAuthoringScenario({
    service: service(), policy, signal, scenario: { input: 'Question', toolResults: {} },
    evaluate: (prompt, tools, input, signal) => evaluateAuthoringScenario({
      workspace, projectId: 'scenario-project', prompt, tools, input, signal,
      llm: { model: 'configured', contextWindow: 128_000, temperature: 0 },
      provider: { name: 'fixture', listModels: () => [], chat: async () => { throw new Error('Must not execute') } },
    }),
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.executionStatus, 'cancelled')
  assert.equal(result.llmExecuted, false)
  assert.match(result.error!, /cancelled/)
})

test('missing fixture and denied alias remain failed even if an evaluator continues', async () => {
  for (const name of ['issue_create', 'exec']) {
    const result = await runAuthoringScenario({
      service: service(), policy, signal: new AbortController().signal,
      scenario: { input: 'Question', toolResults: {}, responseIncludes: ['success'] },
      evaluate: async (_prompt, tools, _input, signal) => {
        await assert.rejects(tools.execute(name, { title: 'Synthetic' }, { signal } as ExecutionContext))
        return {
          status: 'completed', sessionId: 'synthetic', modelRounds: 1,
          llmExecuted: true, syntheticTools: true,
          messages: [{ role: 'assistant', content: 'success' }],
        }
      },
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.executionStatus, 'completed')
    assert.ok(result.checks.every(check => check.passed))
    assert.match(result.error!, /Missing synthetic receipt|Unknown scenario tool/)
  }
})

test('candidate model and generation overrides reach the configured provider without overriding absent defaults', async () => {
  for (const overrides of [
    {},
    { model: 'candidate-model@configured', temperature: 0, maxTokens: 1024, thinking: { type: 'disabled' as const }, reasoningEffort: 'low' as const },
  ]) {
    const candidate = structuredClone(policy)
    Object.assign(candidate.agent, overrides)
    const configured = {
      model: 'project-model@configured', temperature: 0.7, maxTokens: 2048,
      thinking: { type: 'enabled' as const }, reasoningEffort: 'high' as const, contextWindow: 128_000,
    }
    const expected = { ...configured, ...overrides }
    const result = await runAuthoringScenario({
      service: service(), policy: candidate, signal: new AbortController().signal,
      scenario: { input: 'Question', toolResults: {} },
      evaluate: (prompt, tools, input, signal, llmOverrides) => {
        assert.deepEqual(llmOverrides, overrides)
        return evaluateAuthoringScenario({
          workspace, projectId: 'scenario-project', prompt, tools, input, signal,
          llm: { ...configured, ...llmOverrides },
          provider: {
            name: 'configured-provider', listModels: () => [],
            chat: async (_messages, _tools, options) => {
              assert.equal(options.model, expected.model)
              assert.equal(options.temperature, expected.temperature)
              assert.equal(options.maxTokens, expected.maxTokens)
              assert.deepEqual(options.thinking, expected.thinking)
              assert.equal(options.reasoningEffort, expected.reasoningEffort)
              return done
            },
          },
        })
      },
    })
    assert.equal(result.status, 'completed')
  }
})
