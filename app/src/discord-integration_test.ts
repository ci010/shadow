import assert from 'node:assert/strict'
import test from 'node:test'
import { discordReviewLink } from './discord-integration.ts'

test('review links navigate only to the current Project and carry no approval authority', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const path = `/projects/project-a/settings/bots?discordReview=${id}`
  assert.equal(discordReviewLink(path, 'project-a'), path)
  assert.equal(discordReviewLink(`${path}&discordBot=bot-a&approve=true&hash=secret`, 'project-a'), `${path}&discordBot=bot-a`)
  for (const href of [path.replace(id, 'invalid'), path, `https://evil.example${path}`, `//evil.example${path}`,
    `/\\evil.example${path}`, 'javascript:alert(1)']) {
    assert.equal(discordReviewLink(href, 'another-project'), undefined)
  }
})


test('saved assignments distinguish unresolved directory from permission evidence', async () => {
  const { bindingLabel, bindingAvailability } = await import('./discord-integration.ts')
  const binding = { enabled: true, target: { kind: 'channel', guildId: '100', channelId: '201' } } as import('../../src/channels/integration-contract.ts').DiscordBinding
  const directory = { guildId: '100', channels: [{ id: '201', name: 'support', supported: true, canView: true, canSend: true }] } as import('../../src/channels/integration-contract.ts').DiscordDirectory
  assert.match(bindingLabel(binding, []), /name not resolved/)
  assert.equal(bindingLabel(binding, directory.channels), 'support')
  assert.match(bindingAvailability(binding, undefined, true), /directory not resolved/)
  assert.match(bindingAvailability(binding, { ...directory, channels: [] }, true), /directory not resolved/)
  assert.match(bindingAvailability(binding, directory, true), /Bot can send at last sync/)
  assert.match(bindingAvailability(binding, { ...directory, channels: [{ ...directory.channels[0]!, canSend: false }] }, true), /permissions currently block/)
  assert.match(bindingAvailability(binding, directory, false), /disconnected/)
  assert.equal(bindingAvailability({ ...binding, enabled: false }, directory, true), 'Disabled')
})
