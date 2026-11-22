import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotDeployments } from './deployments.ts'
import { DirectoryBots } from './runtime.ts'
import { assignChannelSource } from './channel-assignment.ts'
import { botReadResources, parseBot } from './sdk.ts'
import type { ChannelSource } from '../channels/passive-contract.ts'

const folder = '10000000-0000-4000-8000-000000000001'
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
const linked: ChannelSource = { version: 1, projectId: 'p', platform: 'qq', connectionId: 'qq', conversationId: 'group:two', kind: 'group' }

test('Service BOT packages inherit the top-level grant and reject binding configuration, including explicit empty fields', () => {
  const grant = { wiki: true, knowledge: true, folders: [folder] }
  const model = { readResources: grant }
  const files = packages(model)
  assert.deepEqual(botReadResources(parseBot(files)), grant)
  assert.equal(botReadResources(parseBot(packages({}))), undefined)
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
  for (const stale of [{ readResourcesModel: 'bot-wide' }, { sourceFolders: [] }, { readFolders: [] }]) {
    assert.throws(() => parseBot(packages(stale)), /Unrecognized key/)
  }
  for (const binding of bindings) {
    for (const fields of [{ readResources: {} }, { readFolders: [] }, { sourceFolders: [] }]) {
      assert.throws(() => parseBot(packages({ ...model, bindings: [{ ...binding, ...fields }] })), /Unrecognized key/)
    }
  }
  for (const fields of [{ readResources: {} }, { readFolders: [] }, { sourceFolders: [] }]) {
    assert.throws(() => assignChannelSource(files, linked, { ...channelPolicy, ...fields }), /inherited from the BOT/)
  }
})

test('one frozen Bot projects identical grants to QQ, Feishu and Discord, or none when omitted', async () => {
  await withTempWorkspace(async workspace => {
    const deployments = new BotDeployments({ projectId: 'p', directory: join(workspace, 'bots'), runGit: async () => { throw new Error('No git') } })
    const runtime = new DirectoryBots(deployments)
    const grant = { wiki: true, knowledge: true, folders: [folder] }
    const qq = { platform: 'qq', botInstanceId: 'qq', conversationId: 'group:one' } as const
    const feishu = { platform: 'feishu', botInstanceId: 'feishu', conversationId: 'oc_one' } as const
    const deploy = (files: Record<string, string>, expectedRevision?: string) => deployments.deploy({ id: 'support', source: { folderId: folder, directory: '' }, ...deployments.freeze(files), expectedRevision })
    const first = await deploy(packages({ readResources: grant }))
    assert.deepEqual(runtime.resolve(qq)?.binding.readResources, grant)
    assert.deepEqual(runtime.resolve(feishu)?.binding.readResources, grant)
    assert.deepEqual(runtime.discord().bindings.map(binding => binding.readResources), [grant])
    await deploy(packages({}), first.revision)
    assert.equal(runtime.resolve(qq)?.binding.enabled, true)
    assert.equal(runtime.resolve(qq)?.binding.readResources, undefined)
    assert.equal(runtime.resolve(feishu)?.binding.enabled, true)
    assert.equal(runtime.resolve(feishu)?.binding.readResources, undefined)
    assert.deepEqual(runtime.discord().bindings.map(binding => binding.readResources), [undefined])
    assert.deepEqual(runtime.discord().agents.map(agent => agent.readResources), [undefined])
  })
})
