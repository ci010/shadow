import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const view = readFileSync(new URL('./components/BotConnectionSetup.vue', import.meta.url), 'utf8')
const copy = readFileSync(new URL('./components/BotPairingCommand.vue', import.meta.url), 'utf8')

test('compact personal setup separates connection from explicit owner pairing without a multi-step wizard', () => {
  assert.doesNotMatch(view, /class="setup-steps"|step-number/)
  assert.match(view, /v-if="selected.purpose === 'personal'"/)
  assert.match(view, /v-if="selected.ownerVerified"/)
  assert.match(view, /selected.state === 'connected' \? t\('Ready for your messages'\)/)
  assert.match(view, /v-else-if="selected.state !== 'connected'"/)
  assert.ok(view.includes("t('I sent it — verify my account')"))
  assert.match(view, /window.confirm\(t\('Bind platform user/)
  assert.match(copy, /useTextCopy\(command\)/)
  assert.match(copy, /readonly/)
  assert.match(copy, /\.select\(\)/)
})

test('private connection, owner pairing and copy guidance are translated in both locales', () => {
  const en = JSON.parse(readFileSync(new URL('./locales/en.json', import.meta.url), 'utf8'))
  const zh = JSON.parse(readFileSync(new URL('./locales/zh-CN.json', import.meta.url), 'utf8'))
  for (const match of (view + copy).matchAll(/\bt\('([^']+)'/g)) {
    assert.ok(en[match[1]], `English: ${match[1]}`)
    assert.ok(zh[match[1]], `Chinese: ${match[1]}`)
    assert.notEqual(zh[match[1]], en[match[1]], `Translated: ${match[1]}`)
  }
})
