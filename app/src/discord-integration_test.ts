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
