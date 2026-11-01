import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileScript, parse } from 'vue/compiler-sfc'
import { botConnectionDraft, botConnectionPatch, parseBotStatus } from './bot-settings.ts'

const view = readFileSync(new URL('./components/BotConnectionSetup.vue', import.meta.url), 'utf8')
const settings = readFileSync(new URL('./components/ChannelsView.vue', import.meta.url), 'utf8')
const status = readFileSync(new URL('./components/BotServiceStatus.vue', import.meta.url), 'utf8')

test('Discord service setup has minimal credentials and file-authored permissions, not configuration wizards', () => {
  assert.match(view, /Connection does not grant service access/)
  assert.match(view, /Owner pairing is only for personal Bots/)
  assert.match(view, /Guilds, channels, participants and grants belong in BOT files/)
  assert.doesNotMatch(settings + view, /<DiscordAccess|Publish and assign an Agent|setup-steps|Advanced settings and access/)
  assert.match(settings, /retired Discord configuration workflow. No change has been approved or published/)
  assert.match(settings, /requestedReviewId/)
  assert.match(view, /<BotServiceStatus v-if="serviceStatusOpen"/)
  assert.doesNotMatch(status, /\.propose\(|\.commit\(|\.cancel\(|<form|<input/)
  for (const source of [view, settings, status]) assert.doesNotThrow(() => compileScript(parse(source).descriptor, { id: 'discord-setup-test', inlineTemplate: true }))
})

test('legacy Discord access settings remain untouched by credential-only patches', () => {
  const bot = parseBotStatus({ id: 'discord-bot', projectId: 'p', platform: 'discord', label: 'Discord', displayName: 'Discord', purpose: 'service', enabled: false, configured: true, state: 'disabled', config: { triggerMode: 'all', memberIntent: true, allowFrom: ['123'], adminChats: ['456'] }, secrets: { token: true } }, 'p')
  const draft = botConnectionDraft('discord')
  assert.deepEqual(draft, { token: '' })
  assert.deepEqual(botConnectionPatch(bot, draft, true), { config: { enabled: true } })
  draft.token = 'synthetic-replacement'
  assert.deepEqual(botConnectionPatch(bot, draft, false), { config: { enabled: false, token: 'synthetic-replacement' } })
})

test('Discord install fallback never guesses application ID or requests administrator access', () => {
  assert.match(view, /application’s Guild Install link with only the required channel permissions/)
  assert.match(view, /Do not select Administrator/)
  assert.match(view, /Platform installation and permissions are not verified by connection status/)
  assert.match(view, /never share a token in chat or an invite URL/)
  assert.match(view, /window.shadowDesktop\?\.openExternal/)
  assert.doesNotMatch(view, /client_id=|permissions=8|atob\(|split\('\.'\)/)
})
