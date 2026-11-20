import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotDeployments } from './deployments.ts'
import { DirectoryBots } from './runtime.ts'
import { assignChannelSource } from './channel-assignment.ts'
import { botReadResources, migratableReadResources, parseBot } from './sdk.ts'
import type { ReadResources } from './read-scope.ts'
import type { ChannelSource } from '../channels/passive-contract.ts'

const folder = '10000000-0000-4000-8000-000000000001'
const otherFolder = '10000000-0000-4000-8000-000000000002'
const channelPolicy = { enabled: true, trigger: 'mention', tools: ['read'], allowFrom: ['member'] }
const discordPolicy = { enabled: true, trigger: 'mention', tools: ['read'], participants: { everyone: true, userIds: [], roleIds: [] }, readDomains: [], manage: false, inheritThreads: false }
const bindings = [
  { ...channelPolicy, platform: 'qq', botInstanceId: 'qq', conversationId: 'group:one' },
  { ...channelPolicy, platform: 'feishu', botInstanceId: 'feishu', conversationId: 'oc_one' },
  { ...discordPolicy, platform: 'discord', id: '10000000-0000-4000-8000-000000000003', botInstanceId: 'discord', botUserId: '900', target: { kind: 'channel', guildId: '100', channelId: '200' } },
]
const packages = (extra: object) => ({
  'BOT.md': '---\nid: support\nconfig: bot.json\nmode: service\n---\nShared support',
  'bot.json': JSON.stringify({ allowedModules: [], tools: [], bindings, ...extra }),
})
const legacy = (scopes: Array<ReadResources | undefined>) => packages({
  readResources: { wiki: true, knowledge: true, folders: [folder, otherFolder] },
  bindings: scopes.map((readResources, index) => ({ ...bindings[index], readResources })),
})
const linked: ChannelSource = { version: 1, projectId: 'p', platform: 'qq', connectionId: 'qq', conversationId: 'group:two', kind: 'group' }

test('legacy QQ, Feishu and Discord scope agreement compares grants, not field presence or folder order', () => {
  const shared = { wiki: true, folders: [folder, otherFolder] }
  const files = legacy([shared, { wiki: true, folders: [otherFolder, folder] }, { ...shared, knowledge: false }])
  assert.deepEqual(migratableReadResources(parseBot(files)), shared)
  const edit = assignChannelSource(files, linked, channelPolicy)
  const config = JSON.parse(edit.content)
  assert.equal(config.readResourcesModel, 'bot-wide')
  assert.deepEqual(config.readResources, shared, 'only agreed scope, not the ceiling')
  assert.equal(config.bindings.length, 4)
  assert(config.bindings.every((binding: object) => !Object.hasOwn(binding, 'readResources')))
  assert.deepEqual(botReadResources(parseBot(edit.files)), shared)
  assert.equal(JSON.parse(files['bot.json']).readResources.knowledge, true, 'original frozen bytes unchanged')
})

test('legacy omission, empty scopes and zero bindings never promote the ceiling', () => {
  for (const files of [legacy([]), legacy([undefined, undefined, undefined]), legacy([{ wiki: false, knowledge: false, folders: [] }, {}, undefined])]) {
    assert.equal(botReadResources(parseBot(files)), undefined)
    const edit = assignChannelSource(files, linked, channelPolicy)
    assert(!Object.hasOwn(JSON.parse(edit.content), 'readResources'))
    assert.equal(botReadResources(parseBot(edit.files)), undefined)
  }
})

test('legacy migrations fail closed even with a disabled differing binding; old platform folder fields require review', () => {
  assert.throws(() => migratableReadResources(parseBot(legacy([{ wiki: true }, undefined, { wiki: true }]))), /Legacy binding read scopes differ/)
  assert.throws(() => migratableReadResources(parseBot(legacy([{ folders: [folder] }, { folders: [otherFolder] }, { folders: [folder] }]))), /do not copy the ceiling or union grants/i)
  assert.throws(() => migratableReadResources(parseBot(packages({ readResources: { wiki: true }, bindings: [{ ...bindings[0], readResources: { wiki: true } }, { ...bindings[1], enabled: false }] }))), /Legacy binding read scopes differ/)
  assert.throws(() => migratableReadResources(parseBot(packages({ sourceFolders: [folder], bindings: [bindings[2]] }))), /backend checks/)
  for (const binding of [{ ...bindings[0], readFolders: [folder] }, { ...bindings[1], readFolders: [folder] }, { ...bindings[2], sourceFolders: [folder] }]) {
    assert.throws(() => migratableReadResources(parseBot(packages({ sourceFolders: [folder], bindings: [binding] }))), /backend requirements/)
  }
})

test('explicit Bot-wide packages inherit the top-level grant and reject binding configuration, including explicit empty fields', () => {
  const grant = { wiki: true, knowledge: true, folders: [folder] }
  const model = { readResourcesModel: 'bot-wide', readResources: grant }
  const files = packages(model)
  assert.deepEqual(botReadResources(parseBot(files)), grant)
  assert.equal(botReadResources(parseBot(packages({ readResourcesModel: 'bot-wide' }))), undefined)
  for (const [source, policy] of [
    [linked, channelPolicy],
    [{ ...linked, platform: 'feishu', connectionId: 'feishu', conversationId: 'oc_two' }, channelPolicy],
    [{ version: 1, projectId: 'p', platform: 'discord', connectionId: 'discord', conversationId: '201', kind: 'channel', guildId: '100', botUserId: '900' }, discordPolicy],
  ] as const) {
    const edit = assignChannelSource(files, source, policy)
    assert.deepEqual(edit.readResources, grant)
    assert.equal(parseBot(edit.files).bindings.length, 4)
    assert(!Object.hasOwn(JSON.parse(edit.content).bindings.at(-1), 'readResources'))
  }
  for (const binding of bindings) {
    const oldFields = binding.platform === 'discord' ? { sourceFolders: [] } : { readFolders: [] }
    for (const fields of [{ readResources: {} }, oldFields]) {
      assert.throws(() => parseBot(packages({ ...model, bindings: [{ ...binding, ...fields }] })), /scope belongs only on the BOT/)
    }
  }
  for (const fields of [{ readResources: {} }, { readFolders: [] }, { sourceFolders: [] }]) {
    assert.throws(() => assignChannelSource(files, linked, { ...channelPolicy, ...fields }), /inherited from the BOT/)
  }
})


test('one frozen Bot projects identical grants to QQ, Feishu and Discord, and retains legacy bindings without quarantining Personal fallback', async () => {
  await withTempWorkspace(async workspace => {
    const deployments = new BotDeployments({ projectId: 'p', directory: join(workspace, 'bots'), runGit: async () => { throw new Error('No git') } })
    const runtime = new DirectoryBots(deployments)
    const grant = { wiki: true, knowledge: true, folders: [folder] }
    const qq = { platform: 'qq', botInstanceId: 'qq', conversationId: 'group:one' } as const
    const feishu = { platform: 'feishu', botInstanceId: 'feishu', conversationId: 'oc_one' } as const
    const deploy = (files: Record<string, string>, expectedRevision?: string) => deployments.deploy({ id: 'support', source: { folderId: folder, directory: '' }, ...deployments.freeze(files), expectedRevision })
    const first = await deploy(packages({ readResourcesModel: 'bot-wide', readResources: grant }))
    assert.deepEqual(runtime.resolve(qq)?.binding.readResources, grant)
    assert.deepEqual(runtime.resolve(feishu)?.binding.readResources, grant)
    assert.deepEqual(runtime.discord().bindings.map(binding => binding.readResources), [grant])
    const second = await deploy(legacy([{ wiki: true }, { wiki: true }, { wiki: true }]), first.revision)
    assert.deepEqual(runtime.resolve(qq)?.binding.readResources, { wiki: true })
    assert.deepEqual(runtime.resolve(feishu)?.binding.readResources, { wiki: true })
    assert.deepEqual(runtime.discord().bindings.map(binding => binding.readResources), [{ wiki: true }])
    const invalid = await deploy(legacy([{ wiki: true }, undefined, { wiki: true }]), second.revision)
    assert.equal(runtime.resolve(qq)?.revision, invalid.revision)
    assert.deepEqual(runtime.resolve(qq)?.binding.readResources, { wiki: true })
    assert.equal(runtime.resolve(feishu)?.binding.readResources, undefined)
    assert.deepEqual(runtime.discord().bindings.map(binding => binding.readResources), [{ wiki: true }])
    assert.equal(runtime.personal('legacy-qq'), undefined, 'ordinary role fallback remains available')
    assert.deepEqual(runtime.diagnostics(), [])
    const oldDiscord = packages({ sourceFolders: [folder], bindings: [{ ...bindings[2], sourceFolders: [folder] }] })
    await deploy(oldDiscord, invalid.revision)
    assert.deepEqual(runtime.discord().agents.map(agent => agent.sourceFolders), [[folder]])
    assert.deepEqual(runtime.discord().bindings.map(binding => binding.sourceFolders), [[folder]])
    assert.equal(runtime.personal('legacy-qq'), undefined)
  })
})
