import assert from 'node:assert/strict'
import test from 'node:test'
import { automationCatalogConfigChanged, automationModelSettings } from './automation-model.ts'

const config = () => ({
  agent: { model: 'default', quickModel: undefined as string | undefined, temperature: 0 },
  organization: { enabled: true, model: undefined as string | undefined },
  learning: { enabled: true },
  providers: { fixture: { baseUrl: 'https://example.test' } },
})

test('catalog default model changes invalidate without requiring any automation session', () => {
  const previous = config()
  const next = config()
  assert.equal(automationCatalogConfigChanged(previous, next), false)
  next.agent.model = 'new-default'
  assert.equal(automationModelSettings(next, 'system:work-organizer').defaultModel, 'new-default')
  assert.equal(automationCatalogConfigChanged(previous, next), true)
  next.agent.model = previous.agent.model
  next.agent.quickModel = 'quick'
  assert.equal(automationModelSettings(next, 'system:work-organizer').defaultModel, 'quick')
  assert.equal(automationCatalogConfigChanged(previous, next), true)
  assert.equal(automationCatalogConfigChanged(next, previous), true, 'Removing quickModel also invalidates')
})

test('catalog config comparison retains learning/organization changes but ignores unrelated provider parameters', () => {
  const previous = config()
  const next = config()
  next.agent.temperature = 0.7
  next.providers.fixture.baseUrl = 'https://another.example.test'
  assert.equal(automationCatalogConfigChanged(previous, next), false)
  next.learning.enabled = false
  assert.equal(automationCatalogConfigChanged(previous, next), true)
  next.learning.enabled = true
  next.organization.enabled = false
  assert.equal(automationCatalogConfigChanged(previous, next), true)
  next.organization.enabled = true
  next.organization.model = 'override'
  assert.equal(automationCatalogConfigChanged(previous, next), true)
})
