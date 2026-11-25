import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const view = readFileSync(new URL('./components/BotConnectionSetup.vue', import.meta.url), 'utf8')

test('connection setup offers WeChat transport login, not owner pairing or BOT role selection', () => {
  assert.doesNotMatch(view, /ownerVerified|owner-pairing|BotPairingCommand|Select a role/)
  assert.match(view, /Generate WeChat login QR code/)
  assert.match(view, /Check WeChat login/)
})

test('exact-conversation assignment guidance is translated in both locales', () => {
  const key = 'A connection receives messages. To run a BOT, assign it to the exact conversation in your Project.'
  assert.ok(view.includes(key))
  for (const locale of ['en', 'zh-CN']) {
    const messages = JSON.parse(readFileSync(new URL(`./locales/${locale}.json`, import.meta.url), 'utf8'))
    assert.ok(messages[key])
    if (locale !== 'en') assert.notEqual(messages[key], key)
  }
})
