import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createModelsHandler, type ModelsSnapshot } from './models.ts'
import { VirtualFs } from './virtual-fs.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { validateInferenceCapabilities } from '../agent/llm-config.ts'

const context = { signal: new AbortController().signal } as ExecutionContext
const defaults = { model: 'custom@local', reasoningEffort: 'medium' as const, temperature: 0.7, contextWindow: 400000 }

test('models projects configured selectable metadata only, excluding secrets and unknown guesses', async () => {
  const models = [
    { id: 'custom@local', apiKey: 'SECRET_KEY', baseUrl: 'SECRET_URL', supportedEndpoints: ['SECRET_ENDPOINT'] },
    { id: 'hidden@local', selectable: false },
    { id: 'gpt-4o@openai', vision: true, maxOutputTokens: 8192, reasoningEfforts: ['low', 'high', 'none'] },
  ]
  const handler = createModelsHandler(async () => ({ models, defaults }))
  const root = await handler.read('', context)
  assert.doesNotMatch(root, /SECRET|hidden@local|claude-/)
  assert.match(root, /Omit model\/effort/)
  const unknown = JSON.parse(await handler.read('custom@local', context))
  assert.equal(unknown.contextTokens, 'unknown')
  assert.equal(unknown.parameterCount, 'unknown')
  assert.equal(unknown.measuredPerformance, 'unknown')
  assert.equal(unknown.reasoningEfforts, 'unknown')
  const known = JSON.parse(await handler.read('gpt-4o@openai', context))
  assert.equal(known.contextTokens, 128000)
  assert.match(known.contextProvenance, /registry/)
  assert.deepEqual(known.reasoningEfforts, ['low', 'high'])
  assert.equal(known.maxOutputTokens, 8192)
  await assert.rejects(async () => handler.read('hidden@local', context), /non-selectable/)
})

test('models read/list/search paths track live catalog, overrides and defaults', async () => {
  let current: ModelsSnapshot = { models: [{ id: 'org/custom@local', contextWindow: 1000 }], defaults,
    contextOverride: () => 2000 }
  const handler = createModelsHandler(async () => current)
  const vfs = new VirtualFs()
  vfs.mount('v:models', 'read v:models for exact IDs', handler.read, handler.list)
  assert.match(vfs.prefixes()[0].description, /read v:models/)
  const detail = JSON.parse((await vfs.resolve('v:models/org/custom@local', context))!)
  assert.equal(detail.contextTokens, 2000)
  assert.match(detail.contextProvenance, /override/)
  assert.deepEqual((await vfs.list('v:models/org', context, { content: false }))?.map(e => [e.path, e.content]),
    [['v:models/org/custom@local', '']])
  assert.match((await vfs.list('v:models', context))![0].content, /custom@local/)
  current = { models: [{ id: 'new@local', reasoningEfforts: [] }], defaults: { model: 'new@local', reasoningEffort: 'high' } }
  assert.deepEqual((await handler.list(context)).map(e => e.name), ['new@local'])
  assert.equal(JSON.parse(await handler.read('new@local', context)).projectDefaultEffort, 'high')
  assert.deepEqual(JSON.parse(await handler.read('new@local', context)).reasoningEfforts, [])
})

test('catalog guidance reflects existing effort validation and inherited defaults', () => {
  const models = [{ id: 'custom@local', reasoningEfforts: ['low', 'high'] }, { id: 'unknown@local' }]
  assert.throws(() => validateInferenceCapabilities({ model: 'custom@local' }, defaults, models), /medium/)
  assert.doesNotThrow(() => validateInferenceCapabilities({ model: 'custom@local', reasoningEffort: 'low' }, defaults, models))
  assert.doesNotThrow(() => validateInferenceCapabilities({ model: 'unknown@local' }, defaults, models))
  assert.doesNotThrow(() => validateInferenceCapabilities({}, defaults, models))
})
