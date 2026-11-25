import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getBuiltinSkills } from './builtins.ts'

test('Bot setup guidance separates transport from exact BOT assignments', async () => {
  const skill = (await getBuiltinSkills()).get('tool-operations')
  assert(skill)
  assert.equal(skill.meta.tools, undefined, 'Setup instructions must not add executable tools')
  for (const rule of [
    /Connection is transport only/,
    /exact verified inbox assignment/,
    /does not execute or replay/,
    /distinct inboxes/,
    /does not grant owner or admin status/,
    /ordinary Project dynamic Skill discovery\/activation/,
    /must not acquire extra tools by dynamically reading `v:skills`/,
    /Web-only operations or platform limits/,
    /does not execute the tools or authorize unrelated side effects/,
    /Agent allowed\/blocked tools, module ceilings/,
    /readResources.*named grants do\s+not sandbox/,
    /assignment revocation, restart persistence/,
  ]) assert.match(skill.body, rule)
})


test('Directory BOT guidance keeps direct bindings and independent source publication', async () => {
  const skills = await getBuiltinSkills()
  for (const name of ['tool-operations', 'project-administration']) {
    const skill = skills.get(name)
    assert(skill)
    assert.match(skill.body, /bot_package/)
    assert.match(skill.body, /permissions\s+(?:are declared )?directly in (?:each )?binding/i)
    assert.match(skill.body, /capabilityProfiles/)
    assert.match(skill.body, /Development source and (?:the deployment copy|deployed files) are\s*independent/)
    assert.match(skill.body, /(?:no cross-BOT atomic publication|not an atomic release\s+across BOTs)/)
    assert.match(skill.body, /[Ll]egacy[\s\S]*retired/)
    assert.match(skill.body, /credential_request/)
    assert.doesNotMatch(skill.body, /`authoring_change`|`project_config`|v:authoring/)
  }
})


test('Bot state guidance prefers owner-only VFS reads without activating operation tools', async () => {
  const skills = await getBuiltinSkills()
  const setup = skills.get('bot-setup')!
  assert.equal(setup.meta.tools, undefined)
  assert.match(setup.body, /transport only.*exact conversation assignment/)
  assert.match(setup.body, /exact host-recorded WeChat private inbox.*Personal BOT/)
  assert.doesNotMatch(setup.body, /owner challenge|ownerVerified|explicit purpose/)
  for (const rule of [/v:bots\/overview/, /v:bots\/connections\/index/, /v:bots\/deployments\/<id>\/status/,
    /v:bots\/deployments\/<id>\/listeners/, /processing success is unknown/, /old `bot_setup` \/ `bot_package`/,
    /host-recorded Web execution management boundary/, /do not start connections/, /No status read repairs/]) assert.match(setup.body, rule)
  for (const name of ['project-administration', 'tool-operations']) assert.match(skills.get(name)!.body, /v:bots\/overview/)
})
