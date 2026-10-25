import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { AgentResourceStore } from './store.ts'
import { AgentCredentialStore } from './credentials.ts'
import { agentCapabilityProfiles, capabilitySummary, profileBindings } from './capability-profiles.ts'
import type { ResourceBundle } from './contracts.ts'

const profile = { botInstanceId: 'bot-A', platform: 'qq', skills: ['issues'], readFolders: ['docs'], grants: [{ id: 'github', kind: 'http', origin: 'https://api.github.com', routes: [{ method: 'GET', path: '/repos/example/project/issues' }], credential: { secretRef: 'private-github-name', header: 'Authorization', prefix: 'Bearer ' } }] }
function bundle(profiles: unknown = [profile]): ResourceBundle {
  return { version: 1, bindings: [], files: {
    'agents/helper/AGENT.md': `---\nallowedTools: [issue_list, read]\nallowedModules: ["@shadow/github"]\ncapabilityProfiles: ${JSON.stringify(profiles)}\n---\nSynthetic helper`,
    'skills/issues/SKILL.md': '---\ntools:\n  issue_list:\n    source: issues.js\n    description: List approved repository issues\n    parameters: {type: object}\n    imports: ["@shadow/github"]\n---\nSynthetic instructions',
    'skills/issues/issues.js': 'export async function run() { return [] }',
  } }
}

test('unbound profiles validate the same tool/module/grant routes as real bindings, without widening old Agents', async () => {
  await withTempWorkspace(async directory => {
    const store = new AgentResourceStore({ projectId: 'A', directory })
    assert.equal(store.validate(store.candidate(bundle())).valid, true)
    for (const profiles of [
      [profile, profile],
      [{ ...profile, skills: [] }],
      [{ ...profile, grants: [] }],
      [{ ...profile, grants: [{ ...profile.grants[0], routes: [{ method: 'GET', path: '/repos/../private' }] }] }],
      [{ ...profile, surprise: true }],
    ]) assert.equal(store.validate(store.candidate(bundle(profiles))).valid, false)
    const legacy = bundle()
    legacy.files['agents/helper/AGENT.md'] = '---\nallowedTools: []\n---\nOld Agent'
    const snapshot = store.candidate(legacy)
    assert.equal(store.validate(snapshot).valid, true)
    assert.deepEqual(agentCapabilityProfiles(snapshot, 'helper'), [])
  })
})

test('reviewed Agent profiles persist exact revisions, safe summaries contain no credential identifiers, credentials remain Project-owned', async () => {
  await withTempWorkspace(async directory => {
    const storage = join(directory, 'A')
    const store = new AgentResourceStore({ projectId: 'A', directory: storage })
    const staged = await store.stage({ expectedRevision: store.draft().revision, bundle: bundle() })
    await store.publish(staged.revision)
    const reopened = new AgentResourceStore({ projectId: 'A', directory: storage })
    assert.equal(reopened.snapshot().revision, staged.revision)
    const [saved] = agentCapabilityProfiles(reopened.snapshot(), 'helper')
    assert.deepEqual(saved, { ...profile, parameters: {} })
    assert.equal(profileBindings(reopened.snapshot())[0].botInstanceId, 'bot-A')
    const summary = capabilitySummary(reopened.snapshot(), 'helper', saved)
    assert.equal(JSON.stringify(summary).includes('private-github-name'), false)
    assert.equal(summary.tools[0].description, 'List approved repository issues')
    assert.deepEqual(summary.readFolders, ['docs'])
    assert.deepEqual(summary.targets[0].operations, ['GET /repos/example/project/issues'])
    const credentialsA = new AgentCredentialStore(storage)
    const credentialsB = new AgentCredentialStore(join(directory, 'B'))
    credentialsA.put('private-github-name', 'SYNTHETIC-PRIVATE')
    assert.equal(credentialsA.names().includes(saved.grants[0].kind === 'http' ? saved.grants[0].credential!.secretRef : ''), true)
    assert.equal(credentialsB.names().includes('private-github-name'), false)
    assert.throws(() => new AgentResourceStore({ projectId: 'B', directory: storage }), /another project/)
  })
})
