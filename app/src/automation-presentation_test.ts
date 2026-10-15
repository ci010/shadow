import assert from 'node:assert/strict'
import { test } from 'node:test'
import { automationPresentation, readableAutomationTitle } from './automation-presentation.ts'

test('observer semantic input/output never promotes prompts', () => {
  const input = automationPresentation(JSON.stringify({ instruction: 'SECRET PROMPT', originalGoal: { text: 'Fix navigation' }, previous: { summary: 'Tests passing', next: 'Review' }, events: [{ text: 'raw trace' }] }), true, 'system:work-observer')
  assert.deepEqual(input.map(field => field.text), ['Fix navigation', 'Tests passing', 'Review', '1'])
  const output = automationPresentation('```json\n{"track":true,"title":"Navigation","objective":"Fix menu","summary":"Patched","next":"Review"}\n```', false, 'system:work-observer')
  assert.deepEqual(output.map(field => field.label), ['Title', 'Objective', 'Summary', 'Next'])
  assert.equal(automationPresentation('{"track":false}', false, 'system:work-observer')[0].text, 'No work topic identified')
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
