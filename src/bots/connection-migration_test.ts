import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotDeployments } from './deployments.ts'
import { migrateConnectionProjects, assertConnectionMigrationSettled, type MigrationProject } from './connection-migration.ts'
import { parseBot } from './sdk.ts'
import { BotInstanceStore } from '../channels/bot-store.ts'
import { DirectoryBots } from './runtime.ts'

async function fixture(home: string, projectId = 'non-default-id', git = false) {
  const source = join(home, 'source'); mkdirSync(source, { recursive: true })
  const files = { 'BOT.md': '---\nid: support\nconfig: bot.json\nmode: service\n---\nActive prompt',
    'bot.json': JSON.stringify({ allowedModules: [], tools: [], bindings: [{ platform: 'qq', botInstanceId: 'connection', conversationId: 'group:one', enabled: false, tools: [], trigger: 'all', allowFrom: ['owner', 'other'] }], subscriptions: [] }) }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text)
  const deployments = join(home, 'deployments'), store = new BotDeployments({ projectId, directory: deployments, ...(git ? {} : { runGit: async () => { throw Error('No git') } }) })
  await store.deploy({ id: 'support', source: { folderId: 'folder', directory: '' }, ...store.freeze(files) })
  // An unpublished candidate must remain a candidate, not overwrite active.
  writeFileSync(join(source, 'BOT.md'), files['BOT.md'].replace('Active prompt', 'Candidate prompt'))
  const connections = join(home, 'connections.json')
  const original = JSON.stringify({ version: 2, bots: [{ id: 'connection', projectId, platform: 'qq', displayName: 'Private connection', purpose: 'service',
    config: { enabled: true, appId: 'PRIVATE_APP', secret: 'PRIVATE_SECRET', allowFrom: ['owner'], triggerMode: 'mention', trustedChats: ['group:one'] } }] })
  writeFileSync(connections, original)
  const credentials = join(home, 'private-credentials.json'); writeFileSync(credentials, 'PRIVATE_CREDENTIAL_BYTES')
  const history = join(home, 'old-sessions.jsonl'); writeFileSync(history, 'UNCHANGED_HISTORY')
  const project: MigrationProject = { projectId, home, connections, deployments, sources: [{ folderId: 'folder', directory: '', path: source }], privateFiles: [credentials] }
  return { project, store, source, original, history }
}
const offline = () => {}
test('dry-run is read-only; non-default full files migrate idempotently, retain candidates, disabled and [] subscriptions, restore exact config/source', async () => {
  await withTempWorkspace(async home => {
    const f = await fixture(home), old = f.store.read('support')!, sourceBefore = readFileSync(join(f.source, 'bot.json'), 'utf8')
    const planned = await migrateConnectionProjects([f.project], { action: 'plan', assertOffline: offline })
    assert.equal(planned[0]?.status, 'planned'); assert.equal(existsSync(join(home, '.connection-policy-migration')), false)
    assert.equal(readFileSync(f.project.connections, 'utf8'), f.original)
    assert.throws(() => new BotInstanceStore({ projectId: f.project.projectId, path: f.project.connections }), /offline/)
    const result = await migrateConnectionProjects([f.project], { action: 'apply', assertOffline: offline })
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/)
    assert.equal(statSync(result[0]!.backup!).mode & 0o777, 0o600)
    assert.equal(Buffer.from(JSON.parse(readFileSync(result[0]!.backup!, 'utf8')).privateFiles[0].contents, 'base64').toString('utf8'), 'PRIVATE_CREDENTIAL_BYTES')
    const connections = new BotInstanceStore({ projectId: f.project.projectId, path: f.project.connections })
    assert.equal(connections.get('connection').config.allowFrom, undefined)
    const active = f.store.read('support')!, bot = parseBot(active.files)
    assert.match(bot.prompt, /Active prompt/); assert.doesNotMatch(bot.prompt, /Candidate/)
    assert.match(readFileSync(join(f.source, 'BOT.md'), 'utf8'), /Candidate prompt/)
    assert.deepEqual(bot.connectionPolicies?.connection?.allowFrom, ['owner'])
    assert.equal(bot.bindings[0]?.enabled, false); assert.deepEqual(bot.subscriptions, [])
    assert.deepEqual(new DirectoryBots(f.store).resolve({ botInstanceId: 'connection', platform: 'qq', conversationId: 'group:one' })?.binding.allowFrom, ['owner'])
    await migrateConnectionProjects([f.project], { action: 'apply', assertOffline: offline })
    assert.equal(f.store.read('support')!.deployment.generation, active.deployment.generation)
    await migrateConnectionProjects([f.project], { action: 'restore', assertOffline: offline })
    assert.equal(readFileSync(f.project.connections, 'utf8'), f.original)
    assert.equal(readFileSync(join(f.source, 'bot.json'), 'utf8'), sourceBefore)
    assert.deepEqual(f.store.read('support')!.files, old.files)
    assert.equal(readFileSync(f.history, 'utf8'), 'UNCHANGED_HISTORY')
  })
})
test('interruption after activation resumes without reactivating a migrated BOT or replaying history', async () => {
  await withTempWorkspace(async home => {
    const f = await fixture(home)
    await assert.rejects(() => migrateConnectionProjects([f.project], { action: 'apply', assertOffline: offline, checkpoint: stage => { if (stage === 'bot-migrated') throw Error('synthetic interruption') } }), /synthetic/)
    assert.throws(() => assertConnectionMigrationSettled(home, f.project.projectId), /incomplete/)
    const generation = f.store.read('support')!.deployment.generation
    assert.equal(JSON.parse(readFileSync(f.project.connections, 'utf8')).version, 2)
    await migrateConnectionProjects([f.project], { action: 'apply', assertOffline: offline })
    assert.equal(f.store.read('support')!.deployment.generation, generation)
    assert.equal(JSON.parse(readFileSync(f.project.connections, 'utf8')).version, 3)
    assert.doesNotThrow(() => assertConnectionMigrationSettled(home, f.project.projectId))
  })
})
test('identity mismatch, explicit offline refusal and edited candidates fail without overwriting user content', async () => {
  await withTempWorkspace(async home => {
    const f = await fixture(home)
    await assert.rejects(() => migrateConnectionProjects([{ ...f.project, projectId: 'foreign' }], { action: 'plan', assertOffline: offline }), /ownership/)
    await assert.rejects(() => migrateConnectionProjects([f.project], { action: 'apply', assertOffline: () => { throw Error('running') } }), /running/)
    await assert.rejects(() => migrateConnectionProjects([f.project], { action: 'apply', assertOffline: offline, checkpoint: () => { throw Error('stop') } }), /stop/)
    writeFileSync(join(f.source, 'bot.json'), 'NEW_USER_CONTENT')
    await assert.rejects(() => migrateConnectionProjects([f.project], { action: 'apply', assertOffline: offline }), /File changed/)
    assert.equal(readFileSync(join(f.source, 'bot.json'), 'utf8'), 'NEW_USER_CONTENT')
    assert.equal(readFileSync(f.project.connections, 'utf8'), f.original)
  })
})

test('no-BOT personal/unbound Connections migrate without a collector or model authority; omission and legacy empty allowlist stay distinct', async () => {
  await withTempWorkspace(async home => {
    const projectId = 'isolated-project', deployments = join(home, 'deployments')
    const store = new BotDeployments({ projectId, directory: deployments, runGit: async () => { throw Error('No git') } })
    const connections = join(home, 'connections.json')
    writeFileSync(connections, JSON.stringify({ version: 2, bots: [{ id: 'personal', projectId, platform: 'qq', displayName: 'Unbound', purpose: 'personal', config: { enabled: true, appId: 'private', secret: 'private', allowFrom: [] } }] }))
    await migrateConnectionProjects([{ projectId, home, connections, deployments, sources: [] }], { action: 'apply', assertOffline: offline })
    assert.deepEqual(store.list(), [], 'Migration must not invent a collector BOT')
    assert.equal(new BotInstanceStore({ projectId, path: connections }).get('personal').config.allowFrom, undefined)
    assert.deepEqual(new DirectoryBots(store).inputListeners(), [])
  })
})
test('v3 writes reject all Connection business keys while BOT binding omission/[] are preserved by migration', async () => {
  await withTempWorkspace(async home => {
    const store = new BotInstanceStore({ projectId: 'p', path: join(home, 'new.json') })
    for (const [key, value] of Object.entries({ allowFrom: [], trustedChats: [], adminChats: [], triggerMode: 'all' }))
      assert.throws(() => store.create('qq', 'No business filter', { enabled: false, [key]: value }), /bot_policy_belongs/)
    const f = await fixture(join(home, 'nested'))
    const active = f.store.read('support')!, config = JSON.parse(active.files['bot.json']!)
    delete config.subscriptions; config.bindings[0].enabled = true
    const files = { ...active.files, 'bot.json': JSON.stringify(config) }
    await f.store.deploy({ id: 'support', source: active.deployment.source, ...f.store.freeze(files), expectedRevision: active.deployment.revision })
    writeFileSync(join(f.source, 'bot.json'), files['bot.json'])
    await migrateConnectionProjects([f.project], { action: 'apply', assertOffline: offline })
    assert.equal(parseBot(f.store.read('support')!.files).subscriptions, undefined)
  })
})
test('legacy Discord thread selectors are reported, never silently expanded to parent rules', async () => {
  await withTempWorkspace(async home => {
    const f = await fixture(home), old = f.store.read('support')!
    const config = JSON.parse(old.files['bot.json']!)
    config.bindings = [{ platform: 'discord', id: '00000000-0000-4000-a000-000000000001', botInstanceId: 'connection', botUserId: '900', target: { kind: 'channel', guildId: '100', channelId: '301' },
      enabled: false, trigger: 'mention', participants: { everyone: false, userIds: ['500'], roleIds: [] }, tools: [], readDomains: [], inheritThreads: false, manage: false }]
    const files = { ...old.files, 'bot.json': JSON.stringify(config) }
    await f.store.deploy({ id: 'support', source: old.deployment.source, ...f.store.freeze(files), expectedRevision: old.deployment.revision })
    writeFileSync(join(f.source, 'bot.json'), files['bot.json'])
    const raw = JSON.parse(f.original); raw.bots[0].platform = 'discord'; raw.bots[0].config = { enabled: false, token: 'PRIVATE_TOKEN' }
    writeFileSync(f.project.connections, JSON.stringify(raw))
    await assert.rejects(() => migrateConnectionProjects([f.project], { action: 'plan', assertOffline: offline }), /offline verified/)
    await assert.rejects(() => migrateConnectionProjects([{ ...f.project, discordKinds: { 'connection/301': 'thread' } }], { action: 'apply', assertOffline: offline }), /Legacy thread assignment/)
    assert.equal(JSON.parse(readFileSync(f.project.connections, 'utf8')).version, 2)
    assert.equal(existsSync(join(home, '.connection-policy-migration', 'journal.json')), false)
  })
})

for (const interruption of ['none', 'apply', 'restore'] as const) test(`real isolated Git-managed migration apply/restore retains history and recovers ${interruption} interruption`, async () => {
  await withTempWorkspace(async home => {
    // BotDeployments writes only its private synthetic bare repo via commit-tree;
    // no working repository commit, remote, source program or platform is involved.
    const f = await fixture(home, 'git-project', true), before = f.store.read('support')!
    const git = (...args: string[]) => execFileSync('git', [`--git-dir=${join(f.project.deployments, 'support', 'history.git')}`, ...args], { encoding: 'utf8' }).trim()
    const head = () => git('rev-parse', 'refs/heads/deployments')
    const consistent = () => {
      const current = f.store.read('support')!.deployment
      assert.equal(current.mode, 'git'); assert.equal(head(), current.gitCommit)
      assert.equal(git('fsck', '--no-dangling'), '')
      return current
    }
    consistent()
    const crash = (stage: string) => { if (stage === 'bot-migrated') throw Error('synthetic process interruption') }
    await migrateConnectionProjects([f.project], { action: 'plan', assertOffline: offline })
    assert.equal(head(), before.deployment.gitCommit, 'plan must not write history')
    if (interruption === 'apply') {
      await assert.rejects(migrateConnectionProjects([f.project], { action: 'apply', assertOffline: offline, checkpoint: crash }), /synthetic process/)
      const interrupted = consistent()
      assert.throws(() => assertConnectionMigrationSettled(home, f.project.projectId), /incomplete/)
      assert.equal(readFileSync(f.project.connections, 'utf8'), f.original)
      await migrateConnectionProjects([f.project], { action: 'apply', assertOffline: offline })
      assert.equal(consistent().generation, interrupted.generation)
    } else await migrateConnectionProjects([f.project], { action: 'apply', assertOffline: offline })
    const applied = consistent()
    assert.notEqual(applied.generation, before.deployment.generation)
    assert.equal(git('rev-parse', `${applied.gitCommit}^`), before.deployment.gitCommit)
    assert.deepEqual(parseBot(f.store.read('support')!.files).connectionPolicies?.connection?.allowFrom, ['owner'])
    if (interruption === 'restore') {
      await assert.rejects(migrateConnectionProjects([f.project], { action: 'restore', assertOffline: offline, checkpoint: crash }), /synthetic process/)
      const interrupted = consistent()
      assert.throws(() => assertConnectionMigrationSettled(home, f.project.projectId), /incomplete/)
      await assert.rejects(migrateConnectionProjects([f.project], { action: 'apply', assertOffline: offline }), /restore is incomplete/)
      await migrateConnectionProjects([f.project], { action: 'restore', assertOffline: offline })
      assert.equal(consistent().generation, interrupted.generation)
    } else await migrateConnectionProjects([f.project], { action: 'restore', assertOffline: offline })
    const restored = consistent()
    assert.equal(restored.revision, before.deployment.revision)
    assert.notEqual(restored.generation, before.deployment.generation)
    assert.equal(git('rev-parse', `${restored.gitCommit}^`), applied.gitCommit)
    assert.deepEqual(f.store.read('support')!.files, before.files)
    assert.equal(readFileSync(f.project.connections, 'utf8'), f.original)
    assert.equal(readFileSync(f.history, 'utf8'), 'UNCHANGED_HISTORY')
  })
})
