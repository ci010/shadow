import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotDeployments } from './deployments.ts'
import { DirectoryBots, DirectoryBotService } from './runtime.ts'
import { channelSessionId } from '../bus/events.ts'
import type { ExecutionContext } from '../tools/context.ts'

// Exercises the actual deployed-directory policy path, not a resource store or mock policy.
test('directory policy keeps folder confinement, tool ceilings, Project/session identity and revocation checks', async () => {
  await withTempWorkspace(async workspace => {
    const projectId = 'p', folderId = randomUUID(), folderPath = join(workspace, 'docs')
    await mkdir(folderPath); await writeFile(join(folderPath, 'guide.txt'), 'Public guide\nKnown issue\n')
    await writeFile(join(folderPath, '.env'), 'synthetic-private-value')
    const folder = { id: folderId, projectId, name: 'Docs', path: folderPath, createdAt: new Date().toISOString() }
    const deployments = new BotDeployments({ projectId, directory: join(workspace, 'bots'), runGit: async () => { throw new Error('No git') } })
    const bots = new DirectoryBots(deployments)
    const address = { projectId, botInstanceId: 'connection', platform: 'qq', conversationId: 'group:one' }
    const deploy = async (enabled: boolean) => {
      const frozen = deployments.freeze({ 'BOT.md': '---\nid: support\nconfig: bot.json\n---\nPublic BOT prompt',
        'bot.json': JSON.stringify({ mode: 'service', tools: [], allowedModules: [], bindings: [{ ...address, projectId: undefined, enabled, tools: ['read', 'search'], readFolders: [folderId], allowFrom: ['member'] }] }) })
      await deployments.deploy({ id: 'support', source: { folderId, directory: '' }, ...frozen, expectedRevision: deployments.read('support')?.deployment.revision })
    }
    await deploy(true)
    let folderAvailable = true
    const service = new DirectoryBotService({ projectId, workspace, folders: {
      get: id => id === folderId ? folder : undefined,
      requireAvailable: async id => { if (id !== folderId || !folderAvailable) throw new Error('Folder unavailable'); return folder },
      acquireAccess: () => () => {},
    } }, bots)
    const id = channelSessionId(address), policy = service.resolve(id)!
    assert.ok(policy)
    const tools = service.tools(policy, id)
    assert.deepEqual(tools.getDefinitions().map(tool => tool.function.name).sort(), ['read', 'search'])
    for (const name of ['exec', 'write', 'invoke_tool', 'credential_request', 'skill_save', 'bot_package']) assert.equal(tools.has(name), false)
    const context = { projectId, sessionId: id, channelAddress: address, tools, signal: new AbortController().signal } as ExecutionContext
    assert.match(String(await tools.get('read')!.execute({ path: `folder:${folderId}/guide.txt` }, context)), /Public guide/)
    for (const path of ['v:skills', 'https://example.com', '/etc/passwd', `folder:${folderId}/.env`, `folder:${folderId}/../outside`, 'folder:foreign/guide.txt']) {
      await assert.rejects(tools.get('read')!.execute({ path }, context))
    }
    for (const scope of [{ projectId: 'foreign' }, { sessionId: 'web:owner' }]) {
      await assert.rejects(tools.get('read')!.execute({ path: `folder:${folderId}/guide.txt` }, { ...context, ...scope }), /scope mismatch/)
    }
    assert.throws(() => service.resolve(channelSessionId({ ...address, projectId: 'foreign' })), /another Project/)
    folderAvailable = false
    await assert.rejects(tools.get('read')!.execute({ path: `folder:${folderId}/guide.txt` }, context), /Folder unavailable/)
    folderAvailable = true
    await deploy(false)
    await assert.rejects(tools.get('read')!.execute({ path: `folder:${folderId}/guide.txt` }, context), /disabled|changed/)
    assert.throws(() => service.resolve(id), /disabled/)
  })
})
