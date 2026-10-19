import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileScript, parse } from 'vue/compiler-sfc'
import { channelDefinitions, channelDraft, channelPatch } from './channel-settings.ts'

const view = readFileSync(new URL('./components/ChannelsView.vue', import.meta.url), 'utf8')

test('Discord service setup uses staged guidance without implying owner pairing or access readiness', () => {
  const start = view.indexOf('<section v-if="channel.platform');
  const card = view.slice(start, view.indexOf('</section>', start))
  assert.match(card, /channel.platform === 'discord' && channel.purpose === 'service'/)
  for (const label of ['Connect platform', 'Invite to a Discord server', 'Publish and assign an Agent', 'Review and approve access']) assert.ok(card.includes(`t('${label}')`))
  assert.match(card, /Connection status does not verify assignments/)
  assert.match(card, /Owner pairing is only for personal Bots/)
  assert.doesNotMatch(card, /pairOwner\(|ownerVerified|Ready for your messages/)
  assert.match(card, /accessBot = accessBot === channel.id \? undefined : channel.id/)
  assert.match(view, /<DiscordAccess v-if="available && accessBot === channel.id && channel.platform === 'discord' && channel.purpose === 'service'"/)
  assert.match(view, /requested-review-id="requestedReviewId"/)
  assert.match(view, /channel.purpose === 'personal'\r?\n    \? \[\.\.\.instructions.slice\(0, 2\)/)
  const { descriptor } = parse(view)
  assert.doesNotThrow(() => compileScript(descriptor, { id: 'discord-setup-test', inlineTemplate: true }))
})

test('legacy response mode stays editable under advanced settings and preserves credentials', () => {
  const definition = channelDefinitions.find(item => item.id === 'discord')!
  const field = definition.fields.find(item => item.key === 'triggerMode')!
  assert.equal(field.advanced, true)
  assert.equal(definition.fields.find(item => item.key === 'token')!.advanced, undefined)
  assert.match(view, /UiSelect v-else-if="field.kind === 'select'"/)
  const status = { id: 'discord' as const, label: 'Discord', enabled: false, configured: true, state: 'disabled' as const, config: { triggerMode: 'all' }, secrets: { token: true } }
  const draft = channelDraft(status)
  assert.equal(draft.triggerMode, 'all')
  const patch = channelPatch(status, draft, true)
  assert.equal(patch.triggerMode, 'all')
  assert.equal(patch.enabled, true)
  assert.equal(Object.hasOwn(patch, 'token'), false)
  draft.triggerMode = 'mention'
  assert.equal(channelPatch(status, draft, false).triggerMode, 'mention')
})

test('new service setup guidance is translated in both locales', () => {
  const en = JSON.parse(readFileSync(new URL('./locales/en.json', import.meta.url), 'utf8'))
  const zh = JSON.parse(readFileSync(new URL('./locales/zh-CN.json', import.meta.url), 'utf8'))
  const start = view.indexOf('<section v-if="channel.platform')
  for (const [, key] of view.slice(start, view.indexOf('</section>', start)).matchAll(/t\('([^']+)'/g)) {
    assert.ok(en[key], `English: ${key}`)
    assert.ok(zh[key], `Chinese: ${key}`)
    assert.notEqual(en[key], zh[key], key)
  }
})


test('server invitation fallback remains visible without connection or editor, and never guesses identity', () => {
  const start = view.indexOf('<section v-if="channel.platform')
  const card = view.slice(start, view.indexOf('</section>', start))
  const installStart = card.indexOf('<div class="setup-next setup-install">')
  const install = card.slice(installStart, card.indexOf('</div>', installStart))
  assert.ok(installStart > 0)
  assert.doesNotMatch(install, /v-if|v-else|channel.config|channel.secrets/)
  assert.match(install, /application ID verified for this Bot is not available/)
  assert.match(install, /Installation.*Guild Install.*Install Link/)
  assert.match(install, /OAuth2 URL Generator with the bot scope/)
  assert.match(install, /do not select Administrator/)
  assert.match(install, /Installation alone does not enable Agent access/)
  assert.match(install, /href="https:\/\/discord.com\/developers\/applications" target="_blank" rel="noopener noreferrer"/)
  assert.match(install, /@click.prevent="openPortal\(channel\)"/)
  assert.match(install, /Discord installation documentation/)
  assert.doesNotMatch(card, /client_id=|permissions=8|atob\(|split\('\.'\)/)
  assert.equal((card.match(/class="step-number"/g) ?? []).length, 4)
  assert.equal((card.match(/'step-done'/g) ?? []).length, 1)
  assert.ok(card.indexOf("t('Invite to a Discord server')") < card.indexOf("t('Publish and assign an Agent')"))
})


test('steps three and four are navigable without treating invitation as verified', () => {
  assert.match(view, /@click="openAccess\(channel.id\)">{{ t\('Publish and assign an Agent'\) }}/)
  assert.match(view, /@click="openAccess\(channel.id, 'reviews'\)">{{ t\('Review and approve access'\) }}/)
  assert.match(view, /I have invited the Bot — continue to assignments/)
  assert.match(view, /Opening configuration does not verify installation or grant access/)
  assert.doesNotMatch(view, /<small>{{ t\('Closed until assigned.'\) }}/)
})
