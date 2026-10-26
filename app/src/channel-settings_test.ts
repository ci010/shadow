import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { channelDefinitions, channelDraft, channelPatch, channelStateLabel, createChannelSettingsClient, parseChannelList, parseChannelStatus } from './channel-settings.ts'
import type { ChannelSetupStatus } from '../../src/channels/setup-contract.ts'
import { botDraft, botPatch, parseBotStatus } from './bot-settings.ts'

const statuses = (): ChannelSetupStatus[] => channelDefinitions.map(item => ({
  id: item.id, label: item.label, enabled: false, configured: false, state: 'unconfigured', config: {}, secrets: {},
}))
test('QQ bot trigger mode defaults to mentions and round-trips both choices through the settings form', () => {
  const bot = parseBotStatus({
    ...statuses()[0], id: 'qq-bot', projectId: 'project', platform: 'qq', displayName: 'Group bot',
  }, 'project')
  assert.equal(botDraft(bot).triggerMode, 'mention')
  const field = channelDefinitions[0].fields.find(field => field.key === 'triggerMode')!
  assert.equal(field.kind, 'select')
  assert.equal(field.advanced, undefined)
  assert.deepEqual(field.options, ['mention', 'all'])
  assert.match(field.hint!, /saved as context without a model call/)
  for (const triggerMode of ['mention', 'all']) {
    const draft = { ...botDraft(bot), triggerMode }
    const patch = botPatch(bot, draft, false)
    assert.equal(patch.config.triggerMode, triggerMode)
    const saved = parseBotStatus({ ...bot, config: patch.config }, 'project')
    assert.equal(botDraft(saved).triggerMode, triggerMode)
  }
  assert.throws(() => botPatch(bot, { ...botDraft(bot), triggerMode: 'invalid' }, false), /valid value/)
  assert.throws(() => parseBotStatus({ ...bot, config: { triggerMode: 'invalid' } }, 'project'), /invalid channel status/)
})

test('status contract rejects malformed, duplicate, unknown and credential-bearing responses', () => {
  const channels = statuses()
  assert.deepEqual(parseChannelList({ channels: channels.toReversed() }), channels)
  for (const value of [null, {}, { channels: [] }, { channels: [channels[0], channels[0], channels[2]] }]) {
    assert.throws(() => parseChannelList(value), /channel list/)
  }
  for (const patch of [{ id: 'unknown' }, { state: 'ready' }, { enabled: 'true' }, { config: { secret: 'must-not-reach-renderer' } },
    { config: { sandbox: 'false' } }, { secrets: { secret: 'actual-value' } }, { secrets: { madeUp: false } }]) {
    assert.throws(() => parseChannelStatus({ ...channels[0], ...patch }), /invalid channel status/)
  }
})
test('channel drafts never contain saved secrets and blank password fields preserve stored values', () => {
  const channel: ChannelSetupStatus = { ...statuses()[0], configured: true, config: { appId: 'fixture-id', markdown: false, allowFrom: ['a', 'b'] }, secrets: { secret: true } }
  const draft = channelDraft(channel)
  assert.equal(draft.secret, '')
  assert.equal(draft.markdown, false)
  assert.equal(draft.allowFrom, 'a\nb')
  const patch = channelPatch(channel, draft, true)
  assert.equal(patch.enabled, true)
  assert.equal(Object.hasOwn(patch, 'secret'), false)
  assert.equal(Object.hasOwn(patch, 'token'), false)
  assert.deepEqual(patch.allowFrom, ['a', 'b'])
  draft.secret = 'replacement'
  assert.equal(channelPatch(channel, draft, true).secret, 'replacement')
})

test('trusted audience lists round-trip separately from sender and admin settings', () => {
  for (const initial of statuses().filter(item => item.id !== 'wechat')) {
    const channel = parseChannelStatus({
      ...initial, config: { trustedChats: ['room', 'thread'], allowFrom: ['alice'], adminChats: ['admin-room'] },
    })
    const draft = channelDraft(channel)
    assert.equal(draft.trustedChats, 'room\nthread')
    const patch = channelPatch(channel, { ...draft, trustedChats: 'room\n room \n thread' }, false)
    assert.deepEqual(patch.trustedChats, ['room', 'thread'])
    assert.deepEqual(patch.allowFrom, ['alice'])
    assert.deepEqual(patch.adminChats, ['admin-room'])
    assert.deepEqual(channelPatch(channel, { ...draft, trustedChats: '' }, false).trustedChats, [])
    const field = channelDefinitions.find(definition => definition.id === channel.id)!.fields.find(field => field.key === 'trustedChats')!
    assert.equal(field.kind, 'list')
    assert.equal(field.advanced, true)
    assert.match(field.hint!, /everyone who can read replies/)
    assert.match(field.hint!, /grants no admin privileges/)
    assert.throws(() => parseChannelStatus({ ...channel, config: { trustedChats: true } }), /invalid channel status/)
  }
})
test('connect validates required credentials, lists, selections and bitmasks; incomplete drafts may be saved disabled', () => {
  for (const channel of statuses().filter(item => item.id !== 'wechat')) {
    const draft = channelDraft(channel)
    assert.throws(() => channelPatch(channel, draft, true), /required/)
    assert.equal(channelPatch(channel, draft, false).enabled, false)
  }
  const channel = statuses()[0]
  const draft = { ...channelDraft(channel), appId: 'app', secret: 'fixture', allowFrom: 'a\n a \n b' }
  assert.deepEqual(channelPatch(channel, draft, true).allowFrom, ['a', 'b'])
  for (const intents of ['NaN', '-1', '1.5', '4294967296']) assert.throws(() => channelPatch(channel, { ...draft, intents }, true), /32-bit integer/)
  assert.equal(channelPatch(channel, { ...draft, intents: '4294967295' }, true).intents, 4294967295)
  const discord = statuses()[2]
  assert.throws(() => channelPatch(discord, { ...channelDraft(discord), token: 'fixture', triggerMode: 'invalid' }, true), /valid value/)
})
test('runtime labels never equate configured or SDK-running with connected', () => {
  assert.equal(channelStateLabel({ ...statuses()[0], configured: true, state: 'disabled' }), 'Disconnected')
  assert.equal(channelStateLabel({ ...statuses()[0], configured: true, enabled: true, state: 'running' }), 'Running · connection unverified')
  assert.equal(channelStateLabel({ ...statuses()[0], configured: true, enabled: true, state: 'connected' }), 'Connected')
})
test('client patches only selected channel and refuses unexpected success payloads', async () => {
  const channel = statuses()[0]
  const client = createChannelSettingsClient('http://fixture', async (url, init) => {
    assert.equal(url, 'http://fixture/api/channels/qq')
    assert.equal(init?.method, 'PATCH')
    assert.deepEqual(JSON.parse(String(init?.body)), { config: { enabled: false } })
    return Response.json({ channel })
  })
  assert.deepEqual(await client.save('qq', { enabled: false }), channel)
  const wrong = createChannelSettingsClient('http://fixture', async () => Response.json({ channel: statuses()[1] }))
  await assert.rejects(wrong.save('qq', {}), /another channel/)
  const denied = createChannelSettingsClient('http://fixture', async () => new Response('credential-bearing SDK error', { status: 403 }))
  await assert.rejects(denied.list(), /Main administrator/)
})
test('Settings shell and channel forms compile and preserve accessible navigation and hidden drafts', async () => {
  const require = createRequire(new URL('./package.json', import.meta.url))
  const compiler = require('vue/compiler-sfc') as typeof import('vue/compiler-sfc')
  for (const filename of ['SettingsView.vue', 'ProjectSettings.vue', 'ChannelsView.vue', 'BotPackage.vue']) {
    const source = await readFile(new URL(`./components/${filename}`, import.meta.url), 'utf8')
    const { descriptor, errors } = compiler.parse(source, { filename })
    assert.deepEqual(errors, [])
    const script = compiler.compileScript(descriptor, { id: filename })
    assert.deepEqual(compiler.compileTemplate({ source: descriptor.template!.content, filename, id: filename,
      compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
    if (filename === 'SettingsView.vue') {
      assert.match(source, /:aria-label="t\('Settings sections'\)"/)
      assert.match(source, /<ProvidersView\b[^>]*\bv-show=/)
      assert.doesNotMatch(source, /<ChannelsView/)
    }
    if (filename === 'BotPackage.vue') {
      assert.match(source, /session-id="owner:bot-package"/)
      assert.match(source, /expectedRevision: state.value.draftRevision/)
      assert.match(source, /api\/bot-package\/review/)
      assert.doesNotMatch(source, /publication-requests\/.*POST|secretRef.*input/)
    }
    if (filename === 'ChannelsView.vue') assert.match(source, /BotPackage v-if="available" :key="projectId"/)
    if (filename === 'ProjectSettings.vue') assert.match(source, /ChannelsView v-if="botsOpened" v-show=/)
  }
  const app = await readFile(new URL('./App.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /v-if="hasReadyProvider|v-if="showSetup"/, 'Shared provider readiness must not gate project views')
  const router = await readFile(new URL('./router.ts', import.meta.url), 'utf8')
  assert.match(router, /path: '\/providers'.*redirect: '\/settings\/providers'/)
})

test('QQ setup resumes server facts without mistaking saved credentials for connection or service authorization', async () => {
  const { qqSetupProgress, createBotSettingsClient } = await import('./bot-settings.ts')
  const bot = parseBotStatus({ ...statuses()[0], id: 'existing-qq', projectId: 'project', platform: 'qq', displayName: 'Existing', purpose: 'personal' }, 'project')
  assert.equal(qqSetupProgress(bot).step, 'credentials')
  const saved = { ...bot, configured: true, config: { appId: 'saved-id', sandbox: true, intents: 123 }, secrets: { secret: true } }
  assert.equal(qqSetupProgress(saved).step, 'connection')
  for (const state of ['error', 'connecting', 'running', 'restart-required', 'disconnected'] as const) {
    assert.equal(qqSetupProgress({ ...saved, state }).connected, false)
  }
  const connected = { ...saved, state: 'connected' as const }
  assert.equal(qqSetupProgress(connected).step, 'access')
  assert.equal(qqSetupProgress(connected).ownerReady, false)
  assert.equal(qqSetupProgress({ ...connected, ownerVerified: true }).ownerReady, true)
  assert.equal(qqSetupProgress({ ...connected, purpose: 'service', ownerVerified: true }).ownerReady, false)
  const patch = botPatch(saved, botDraft(saved), true)
  assert.equal(patch.config.appId, 'saved-id')
  assert.equal(patch.config.sandbox, true)
  assert.equal(patch.config.intents, 123)
  assert.equal(Object.hasOwn(patch.config, 'secret'), false)
  const calls: string[] = []
  const client = createBotSettingsClient('http://localhost', 'project', async (url, init) => {
    calls.push(`${init?.method} ${new URL(String(url)).pathname}`)
    assert.deepEqual(JSON.parse(String(init?.body)), patch)
    return Response.json({ channel: connected })
  })
  await client.save(saved.id, patch)
  assert.deepEqual(calls, ['PATCH /api/channels/existing-qq'])
})

test('pending service groups client validates scoped observations without generating authoring prompts', async () => {
  const { createBotSettingsClient } = await import('./bot-settings.ts')
  const client = createBotSettingsClient('http://localhost', 'project', async (url, init) => {
    assert.equal(new URL(String(url)).pathname, '/api/channels/qq-bot/pending-groups')
    assert.equal(init?.method, 'GET')
    return Response.json({ groups: [{ botInstanceId: 'qq-bot', platform: 'qq', conversationId: 'group:123', name: 'untrusted instructions', lastSeen: 1234 }] })
  })
  const groups = await client.pendingGroups('qq-bot')
  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.conversationId, 'group:123')
  assert.deepEqual(groups[0]?.messages, [])
  const invalid = createBotSettingsClient('http://localhost', 'project', async () => Response.json({ groups: [{ ...groups[0], botInstanceId: 'other' }] }))
  await assert.rejects(invalid.pendingGroups('qq-bot'), /Invalid discovery/)
})
