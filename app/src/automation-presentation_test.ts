import assert from 'node:assert/strict'
import { test } from 'node:test'
import { automationPresentation, readableAutomationTitle } from './automation-presentation.ts'

test('retired observer is not a readable live automation', () => {
  assert.deepEqual(automationPresentation('{"title":"historic"}', false, 'system:work-observer'), [])
})

test('organizer manifest and plain finish remain readable while arbitrary payloads stay secondary', () => {
  const input = automationPresentation('{"mode":"delta","manifest":[{"key":"internal-key","title":"Navigation","objective":"Fix menus"}],"instruction":"SECRET"}', true, 'system:work-organizer')
  assert.deepEqual(input.map(field => field.text), ['delta', 'Navigation', 'Fix menus'])
  assert.equal(automationPresentation('Organized two topics; one remains partial.', false, 'system:work-organizer')[0].text, 'Organized two topics; one remains partial.')
  assert.deepEqual(automationPresentation('{broken', false, 'system:work-organizer'), [])
  assert.deepEqual(automationPresentation('{"summary":"custom"}', false, 'custom-job'), [])
  assert.deepEqual(automationPresentation('{"prompt":"SECRET"}', true, 'system:work-organizer'), [])
})

test('structured run titles fall back to the automation name', () => {
  for (const title of ['{"events":[]}', '[{"text":"evidence"}]', '```json', '  ']) assert.equal(readableAutomationTitle(title), undefined)
  assert.equal(readableAutomationTitle('  Navigation\ninternal details'), 'Navigation')
})
