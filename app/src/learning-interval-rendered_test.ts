import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { setAutomationInterval } from './automations.ts'

test('interval client validates whole minutes and sends only the selected interval', async () => {
  const calls: unknown[] = []
  const request = async (url: unknown, init?: RequestInit) => { calls.push([String(url), JSON.parse(String(init?.body))]); return Response.json({ automation: { id: 'learning:reflector' } }) }
  for (const value of [0, NaN, 1.5, 35792]) await assert.rejects(setAutomationInterval('https://example.test/', 'learning:reflector', value, new AbortController().signal, request as typeof fetch))
  assert.equal(calls.length, 0)
  await setAutomationInterval('https://example.test/projects/a/', 'learning:reflector', 2, new AbortController().signal, request as typeof fetch)
  assert.deepEqual(calls, [['https://example.test/projects/a/api/automations/learning%3Areflector', { intervalMs: 120000 }]])
})

test('Learning settings navigation is removed and old URLs redirect to its automation', () => {
  const settings = readFileSync(new URL('./components/ProjectSettings.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(settings, /id: 'learning'|saveLearning|LearningRuntimeStatus|learningEnabled/)
  const router = readFileSync(new URL('./router.ts', import.meta.url), 'utf8')
  assert.match(router, /settings\/learning', redirect:.*automation: 'learning:reflector'/)
  for (const file of ['AutomationDetail.vue', 'ChatTab.vue']) {
    assert.doesNotMatch(readFileSync(new URL(`./components/${file}`, import.meta.url), 'utf8'), /AutomationConversationProjection/)
  }
})
