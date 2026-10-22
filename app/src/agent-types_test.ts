import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentContext, parseAgentTypes } from './agent-types.ts'

test('agent browser accepts the catalog contract without invented legacy capability flags', () => {
  const agents = [{ name: 'general', description: 'General assistant', source: 'builtin', defaultMode: 'session' },
    { name: 'review', description: 'Project review', source: 'workspace', defaultMode: 'task',
      model: 'model@provider', temperature: 0, maxTokens: 2048, allowedTools: ['read', 'search'], blockedTools: ['write'] }]
  assert.deepEqual(parseAgentTypes(agents), agents)
  assert.deepEqual(parseAgentTypes([]), [])
  for (const value of [null, {}, [{ name: 'general' }], [...agents, agents[0]],
    [{ ...agents[0], defaultMode: ['session'] }], [{ ...agents[0], source: 'unknown' }],
    [{ ...agents[0], allowedTools: 'read' }], [{ ...agents[0], maxTokens: Infinity }]]) {
    assert.throws(() => parseAgentTypes(value), /Cannot read agent type definitions/)
  }
})

test('agent browser validates assembled previews while retaining complete tool schemas for JSON export', () => {
  const tools = [{ name: 'read', description: 'Read a file', parameters: {
    type: 'object', required: ['path'], additionalProperties: false,
    properties: { path: { type: 'string', description: 'Path', enum: ['C:\\synthetic'] },
      options: { type: ['object', 'null'], oneOf: [{ type: 'object' }, { type: 'null' }] } },
  } }]
  const prompt = '# Role\n\n<available_skills>\nExact raw input\n</available_skills>'
  assert.deepEqual(parseAgentContext({ systemPrompt: prompt, tools }), { systemPrompt: prompt, tools })
  assert.deepEqual(parseAgentContext({ systemPrompt: '', tools: [] }), { systemPrompt: '', tools: [] })
  for (const value of [null, {}, { systemPrompt: null, tools: [] },
    { systemPrompt: prompt, tools: [{ name: 'read', description: 3 }] },
    { systemPrompt: prompt, tools: [...tools, tools[0]] },
    { systemPrompt: prompt, tools: [{ ...tools[0], parameters: { properties: { path: { type: 3 } } } }] }]) {
    assert.throws(() => parseAgentContext(value), /Cannot read the assembled agent preview/)
  }
})
