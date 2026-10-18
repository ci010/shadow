import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const view = readFileSync(new URL('./components/ChannelsView.vue', import.meta.url), 'utf8')
const copy = readFileSync(new URL('./components/BotPairingCommand.vue', import.meta.url), 'utf8')

test('personal setup distinguishes transport, owner pairing, and ready-to-chat states', () => {
  assert.match(view, /class="setup-steps"/)
  for (const label of ['Connect platform', 'Pair your account', 'Start a private chat']) assert.ok(view.includes(`t('${label}')`))
  assert.ok(view.includes("channel.ownerVerified && channel.state === 'connected' ? t('Ready for your messages')"))
  assert.ok(view.includes("v-if=\"channel.state !== 'connected'\""))
  assert.ok(view.includes("t('I sent it — verify my account')"))
  assert.match(view, /window.confirm\(t\('Bind platform user/)
  assert.match(copy, /useTextCopy\(command\)/)
  assert.match(copy, /readonly/)
  assert.match(copy, /\.select\(\)/)
})

test('pairing guidance and copy labels have English and Chinese entries', () => {
  const en = JSON.parse(readFileSync(new URL('./locales/en.json', import.meta.url), 'utf8'))
  const zh = JSON.parse(readFileSync(new URL('./locales/zh-CN.json', import.meta.url), 'utf8'))
  const section = view.slice(view.indexOf('<section v-if="channel.purpose'), view.indexOf('<div v-if="channel.platform === \'wechat\''))
  for (const match of (section + copy).matchAll(/t\('([^']+)'/g)) {
    assert.ok(en[match[1]], `English: ${match[1]}`)
    assert.ok(zh[match[1]], `Chinese: ${match[1]}`)
    assert.notEqual(zh[match[1]], en[match[1]], `Translated: ${match[1]}`)
  }
})
