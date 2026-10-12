import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { providerReadinessMessage, providerBlocksSubmission } from './provider-readiness.ts'
import type { ProviderSetupStatus } from './provider-setup.ts'
const status: ProviderSetupStatus = { provider: 'copilot', model: 'gpt@copilot', authMode: 'copilot', ready: false, hasApiKey: false, reason: 'missing_credentials' }

test('primary provider readiness covers inherited, unsuffixed and matching models only', () => {
  for (const model of ['', 'gpt', 'other@copilot']) assert.ok(providerReadinessMessage(status, false, '', model))
  for (const checking of [false, true]) assert.equal(providerReadinessMessage(status, checking, 'service error', 'anthropic/claude@openrouter'), '')
  assert.equal(providerReadinessMessage({ ...status, ready: true }, false, '', ''), '')
})
test('initial checks, retry checks and service failures block before readiness is known', () => {
  assert.ok(providerReadinessMessage(null, true, '', ''))
  assert.ok(providerReadinessMessage({ ...status, ready: true }, true, '', 'gpt@copilot'))
  assert.equal(providerReadinessMessage(status, false, 'service error', ''), 'service error')
  assert.ok(providerReadinessMessage(null, false, '', ''))
})
test('reason codes are actionable; unknown backend reasons are not displayed verbatim', () => {
  for (const reason of ['missing_base_url', 'network_error', 'proxy_error', 'storage_error', 'invalid_credentials', 'private-secret']) {
    const message = providerReadinessMessage({ ...status, reason }, false, '', '')
    assert.ok(message)
    assert.ok(!message.includes('private-secret'))
  }
})
test('pending replies stay available but queued guidance, resend and regular messages are gated', () => {
  assert.equal(providerBlocksSubmission('not ready', true, false), false)
  assert.equal(providerBlocksSubmission('not ready', true, true), true)
  assert.equal(providerBlocksSubmission('not ready', false, false), true)
  assert.equal(providerBlocksSubmission('', false, true), false)
})
test('chat gates submission before draft preparation and does not gate stop', () => {
  const source = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  const send = source.slice(source.indexOf('async function sendMessage('), source.indexOf('function retryLastRequest('))
  assert.ok(send.indexOf('await sendQuestionAnswer') < send.indexOf('if (providerBlocksSubmission'))
  assert.ok(send.indexOf('if (providerBlocksSubmission') < send.indexOf('await draft.value.prepare'))
  assert.match(source, /const canSend = computed\(\(\) => !providerSendBlocked.value/)
  const resume = source.slice(source.indexOf('async function resumeCurrentRequest'), source.indexOf('async function resumeCurrentRequest') + 900)
  assert.ok(resume.indexOf('if (providerNotice.value) return') < resume.indexOf('requestControls.set'))
  assert.match(source, /class="resend-btn" :disabled="!!providerNotice"/)
})
