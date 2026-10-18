import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getBuiltinSkills } from './builtins.ts'

test('Bot setup guidance distinguishes verified personal entry points and restricted service roles', async () => {
  const skill = (await getBuiltinSkills()).get('tool-operations')
  assert(skill)
  assert.match(skill.meta.description, /personal assistant versus service Bot/)
  assert.equal(skill.meta.tools, undefined, 'Setup instructions must not add executable tools')
  for (const rule of [
    /Connect my assistant/,
    /Create a service Bot/,
    /Private versus group chat alone does not determine the purpose/,
    /exact-Project\/exact-Bot owner verification/,
    /Only the verified owner's direct messages/,
    /Unbound identities, other people and group messages must\s+be rejected/,
    /ordinary Project dynamic Skill discovery\/activation path/,
    /Owner DMs remain service conversations/,
    /Unassigned conversations must not fall back/,
    /must not acquire extra tools by dynamically reading `v:skills`/,
    /must not silently serve both purposes/,
    /Web-only operations or platform limits/,
    /do not currently start legacy WeChat adapters/,
    /does not execute the tools or authorize unrelated side effects/,
    /Agent allowed\/blocked tools, module ceilings/,
    /Selecting instructions can change behavior even when a tool is\s+not allowed/,
    /readFolders.*named grants do\s+not sandbox/s,
    /restart persistence, revoked owner/,
    /workflows below configure service Bots, not personal Project entry points/,
  ]) assert.match(skill.body, rule)
})
