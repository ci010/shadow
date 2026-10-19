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
