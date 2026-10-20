import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelAccountLabel, modelOptionLabel, filterModelOptions, modelDisplayName, modelProvider, modelSelectionInput } from './model-selection.ts'

test('composer model choice preserves qualified model and provider semantics', () => {
  assert.deepEqual(modelSelectionInput('claude-sonnet-4.6@copilot', 'openai'), {
    provider: 'copilot',
    model: 'claude-sonnet-4.6@copilot',
  })
})

test('unqualified model choices retain the configured local provider', () => {
  assert.deepEqual(modelSelectionInput('local-model', 'openai-compatible'), {
    provider: 'openai-compatible',
    model: 'local-model',
  })
})

test('model menu separates display names from provider IDs without changing wire values', () => {
  assert.equal(modelDisplayName('claude-sonnet-4.6@copilot'), 'claude-sonnet-4.6')
  assert.equal(modelProvider('claude-sonnet-4.6@copilot'), 'copilot')
  assert.equal(modelDisplayName('local-model'), 'local-model')
  assert.equal(modelProvider('local-model'), '')
})

test('model search includes the current unavailable model, deduplicates and searches names and providers', () => {
  const options = ['gpt-5@copilot', 'local-model', 'gpt-5@copilot']
  assert.deepEqual(filterModelOptions(options, 'custom@openai', ''), ['gpt-5@copilot', 'local-model', 'custom@openai'])
  assert.deepEqual(filterModelOptions(options, '', ' COPILOT '), ['gpt-5@copilot'])
  assert.deepEqual(filterModelOptions(options, '', 'missing'), [])
})


test('same-type account labels and searches never change the qualified selection, including after rename', () => {
  const options = ['same@account-a', 'same@account-b']
  const providers = [{ id: 'account-a', type: 'deepseek', name: 'Personal' }, { id: 'account-b', type: 'deepseek', name: 'Work' }]
  assert.equal(modelAccountLabel(options[0], providers), 'Personal · DeepSeek')
  assert.equal(modelOptionLabel(options[1], providers), 'same · Work · DeepSeek · account-b')
  assert.deepEqual(filterModelOptions(options, '', 'work', providers), ['same@account-b'])
  assert.deepEqual(filterModelOptions(options, '', 'DeepSeek', providers), options)
  providers[1].name = 'Office'
  assert.deepEqual(filterModelOptions(options, options[1], 'office', providers), ['same@account-b'])
  assert.deepEqual(modelSelectionInput(options[1], 'account-a'), { model: 'same@account-b', provider: 'account-b' })
  assert.equal(modelAccountLabel('old@missing', providers), 'missing')
})

test('provider tags group accounts by type and leave small catalogs simple', async () => {
  const { modelProviderFilters, modelProviderGroup, modelCompactAccountLabel } = await import('./model-selection.ts')
  const providers = [{ id: 'a', type: 'deepseek', name: 'Work' }, { id: 'b', type: 'deepseek', name: 'Work' }, { id: 'c', type: 'openai' }]
  assert.deepEqual(modelProviderFilters(['one@a', 'two@c'], providers), [])
  assert.deepEqual(modelProviderFilters(['one@a', 'one@b'], providers), [])
  assert.deepEqual(modelProviderFilters(['one@a', 'one@b', 'two@c', 'one@a'], providers), [
    { id: 'deepseek', label: 'DeepSeek', count: 2 }, { id: 'openai', label: 'OpenAI', count: 1 },
  ])
  assert.equal(modelProviderGroup('vendor/model@b', providers), 'deepseek')
  assert.equal(modelCompactAccountLabel('one@a', providers), 'Work · DeepSeek · #1')
  assert.equal(modelCompactAccountLabel('one@b', providers), 'Work · DeepSeek · #2')
  assert.equal(modelCompactAccountLabel('two@c', providers), 'OpenAI')
  const large = Array.from({ length: 5 }, (_, i) => `model-${i}@a`)
  assert.equal(modelProviderFilters([...large, 'two@c'], providers).length, 2)
  assert.equal(modelProviderGroup('old@missing', providers), 'missing')
})
