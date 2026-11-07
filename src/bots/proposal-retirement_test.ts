import test from 'node:test'
import assert from 'node:assert/strict'
import { botProposalBaseline } from './format.ts'
import { parseBot } from './sdk.ts'
import { botFiles } from './sdk-test-fixture.ts'

const legacyGrant = { id: 'legacy', kind: 'proposal-inbox', inbox: 'triage', disclosurePolicy: { kind: 'public-github-issue-proposal', repository: 'owner/repo' } }
const files = (config: Record<string, unknown> = {}, grant: unknown = legacyGrant) => botFiles('', { bindings: [{ platform: 'qq', botInstanceId: 'connection', conversationId: 'group:one', tools: [], grants: [grant] }], ...config })

test('owner-preview legacy proposal subtraction never makes the original package executable or grants Work authority', () => {
  const old = files(), bytes = JSON.stringify(old)
  assert.throws(() => parseBot(old))
  const audit = botProposalBaseline(old)
  assert.deepEqual(audit.removedProposalGrants, [{ bindingIndex: 0, id: 'legacy', inbox: 'triage', repository: 'owner/repo' }])
  assert.deepEqual(audit.bot.bindings[0]!.grants, [])
  assert.equal(audit.bot.hostCapabilities, undefined)
  assert.equal(JSON.stringify(old), bytes)
  assert.throws(() => parseBot(old), 'audit baseline is not a runtime migration')
})

test('proposal preview rejects malformed grants, unknown fields and mixed package errors rather than granting compatibility', () => {
  for (const bad of [
    files({ unknownRoot: 'not allowed' }),
    files({}, { ...legacyGrant, sessionId: 'local-owner' }),
    files({}, { ...legacyGrant, disclosurePolicy: { ...legacyGrant.disclosurePolicy, repository: 'bad' } }),
    files({ bindings: [{ platform: 'qq', botInstanceId: 'connection', conversationId: 'group:one', tools: [], unknownBinding: true, grants: [legacyGrant] }] }),
    files({ bindings: [{ platform: 'qq', botInstanceId: 'connection', conversationId: 'group:one', tools: [], grants: [legacyGrant, { kind: 'future', id: 'unknown' }] }] }),
    { ...files(), 'BOT.md': '---\nid: demo\nconfig: bot.json\nmode: service\n---\nMixed duplicate mode.' },
  ]) {
    const bytes = JSON.stringify(bad)
    assert.throws(() => botProposalBaseline(bad))
    assert.throws(() => parseBot(bad))
    assert.equal(JSON.stringify(bad), bytes)
  }
})
