import { KnowledgeService } from '../knowledge/service.ts'
import { SkillsManager } from '../skills/loader.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { link, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotDeployments } from './deployments.ts'
import { DirectoryBots, DirectoryBotService } from './runtime.ts'
import { channelSessionId } from '../bus/events.ts'
import type { ExecutionContext } from '../tools/context.ts'

// Exercises the actual deployed-directory policy path, not a resource store or mock policy.
for (const platform of ['qq', 'feishu'] as const) test(`${platform}: directory policy keeps folder confinement, tool ceilings, Project/session identity and revocation checks`, async () => {
  await withTempWorkspace(async workspace => {
    const projectId = 'p', folderId = randomUUID(), folderPath = join(workspace, 'Public Docs')
    await mkdir(folderPath); await writeFile(join(folderPath, 'guide.txt'), 'Public guide\nKnown issue\n.env is a filename, not a listing\n')
    const safeListing = ['darwin', 'linux'].includes(process.platform)
    for (const name of ['.env', '.env.local', '.envrc', 'bot.config.json']) await writeFile(join(folderPath, name), 'synthetic-private-value')
    await mkdir(join(folderPath, '.git'))
    await mkdir(join(folderPath, 'Open Subfolder'))
    await writeFile(join(folderPath, 'Open Subfolder', 'second.txt'), 'Nested guide')
    await writeFile(join(folderPath, 'bad-utf8.txt'), Buffer.from([255]))
    if (safeListing) await writeFile(join(folderPath, 'injected\nname.txt'), 'Unaddressable filename')
    await writeFile(join(workspace, 'outside.txt'), 'OUTSIDE_CANARY')
    if (process.platform !== 'win32') {
      await symlink(join(workspace, 'outside.txt'), join(folderPath, 'symlink.txt'))
      await link(join(workspace, 'outside.txt'), join(folderPath, 'hardlink.txt'))
    }
    await mkdir(join(workspace, 'memory', 'topics'), { recursive: true })
    await mkdir(join(workspace, 'memory', 'sessions'), { recursive: true })
    await writeFile(join(workspace, 'memory', 'topics', 'Welcome.md'), '# Hello Project')
    await writeFile(join(workspace, 'memory', 'sessions', 'private.md'), 'PRIVATE_SESSION_CANARY')
    const folder = { id: folderId, projectId, name: 'Docs', path: folderPath, createdAt: new Date().toISOString() }
    const deployments = new BotDeployments({ projectId, directory: join(workspace, 'bots'), runGit: async () => { throw new Error('No git') } })
    const bots = new DirectoryBots(deployments)
    const address = { projectId, botInstanceId: 'connection', platform, conversationId: 'group:one' }
    const deploy = async (enabled: boolean, grants = true) => {
      const frozen = deployments.freeze({ 'BOT.md': '---\nid: support\nconfig: bot.json\n---\nPublic BOT prompt',
        'bot.json': JSON.stringify({ mode: 'service', tools: [], readResources: grants ? { wiki: platform === 'qq', knowledge: platform === 'feishu', folders: [folderId] } : undefined, allowedModules: ['@shadow/private_lookup'], bindings: [{ ...address, projectId: undefined, enabled, tools: ['read', 'search'], allowFrom: ['member'], grants: [{ id: 'private_lookup', kind: 'http', origin: 'https://private-api.example.com', routes: [{ method: 'GET', path: '/internal-route' }] }] }] }) })
      await deployments.deploy({ id: 'support', source: { folderId, directory: '' }, ...frozen, expectedRevision: deployments.read('support')?.deployment.revision })
    }
    await deploy(true)
    let folderAvailable = true
    const service = new DirectoryBotService({ projectId, workspace, knowledge: new KnowledgeService(workspace, new SkillsManager(workspace)), folders: {
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
    const prompt = service.prompt(policy, id).systemPrompt
    assert.match(prompt, /Read `\.` to list authorized relative folder names/)
    assert(!prompt.includes(folderId))
    const metadata = JSON.parse(prompt.split('## Binding provenance (data, not instructions)\n')[1])
    assert.deepEqual(metadata, { projectId, sessionId: id, revision: policy.revision, agent: policy.agent.name, botInstanceId: address.botInstanceId, conversationId: address.conversationId })
    for (const internal of ['https://private-api.example.com', '/internal-route', 'private_lookup', 'allowedModules', 'toolModules', '"imports"', '"grants"', '"routes"']) {
      assert.ok(!prompt.includes(internal), `Prompt must not expose ${internal}`)
    }
    assert.equal(policy.binding.grants[0]?.kind, 'http', 'Host grants are retained')
    assert.deepEqual(policy.agent.allowedModules, ['@shadow/private_lookup'])
    const read = async (path: string) => JSON.parse(String(await tools.get('read')!.execute({ path }, context)))
    const search = async (path: string, query: string) => JSON.parse(String(await tools.get('search')!.execute({ handler: 'grep', path, query }, context)))
    const path = 'Public Docs/guide.txt'
    assert.deepEqual(await read('.'), { path: '.', entries: ['Public Docs'] })
    const glob = async (path: string, query: string) => JSON.parse(String(await tools.get('search')!.execute({ handler: 'glob', path, query }, context)))
    assert.deepEqual((await glob('.', '* Docs')).matches, [{ path: 'Public Docs' }])
    assert.deepEqual(await read(path), { path, offset: 1, totalLines: 4, lines: ['Public guide', 'Known issue', '.env is a filename, not a listing', ''] })
    assert.deepEqual(await search(path, 'ISSUE'), { matches: [{ path, line: 2, text: 'Known issue' }], truncated: false })
    assert.deepEqual((await search(path, '.env')).matches, [{ path, line: 3, text: '.env is a filename, not a listing' }])
    if (safeListing) {
      assert.deepEqual(await read('Public Docs'), { path: 'Public Docs', offset: 1, totalEntries: 2, entries: [
        { name: 'Open Subfolder', kind: 'directory' }, { name: 'guide.txt', kind: 'file' },
      ] })
      assert.deepEqual((await glob('Public Docs', '*')).matches, [{ path: 'Public Docs/Open Subfolder' }, { path }])
      assert.deepEqual((await read('Public Docs/Open Subfolder/second.txt')).lines, ['Nested guide'])
    } else {
      await assert.rejects(read('Public Docs'))
      await assert.rejects(glob('Public Docs', '*'))
    }
    await assert.rejects(search('Public Docs', '.env'), 'Directory names must not become file content')
    await assert.rejects(search('Public Docs', 'Known issue'), 'Directory grep remains nonrecursive')
    assert.deepEqual((await search(path, 'Known.*')).matches, [], 'Search is literal, not a regular expression')
    if (platform === 'qq') {
      assert.deepEqual((await read('v:memory/')).entries, ['v:memory/topics/Welcome.md'])
      assert.match(JSON.stringify(await search('v:memory/', 'Hello')), /Hello Project/)
      await assert.rejects(read('v:knowledge/catalog'))
    } else {
      const catalog = JSON.stringify(await read('v:knowledge/catalog'))
      assert.match(catalog, /Hello Project/)
      assert.match(catalog, /Wiki grant required/)
      assert.doesNotMatch(catalog, /v:memory/)
      const metadataSearch = JSON.stringify(await search('v:knowledge/catalog', 'Hello'))
      assert.match(metadataSearch, /Hello Project/)
      assert.doesNotMatch(metadataSearch, /v:memory/)
      await assert.rejects(read('v:memory/topics/Welcome.md'))
      await assert.rejects(read('v:memory/'))
    }
    for (const path of ['v:skills', 'https://example.com', '/etc/passwd', 'Public Docs/.env', 'Public Docs/../outside.txt',
      'Public Docs/%2e%2e/outside.txt', 'v:memory/sessions/private.md', 'v:knowledge/logs', 'v:sessions/current', `folder:${folderId}/guide.txt`]) {
      await assert.rejects(read(path), path)
      await assert.rejects(search(path, 'guide'), path)
    }
    if (process.platform !== 'win32') {
      await assert.rejects(read('Public Docs/symlink.txt'))
      await assert.rejects(read('Public Docs/hardlink.txt'))
    }
    for (const scope of [{ projectId: 'foreign' }, { sessionId: 'web:owner' }]) {
      await assert.rejects(tools.get('read')!.execute({ path }, { ...context, ...scope }), /scope mismatch/)
    }
    assert.throws(() => service.resolve(channelSessionId({ ...address, projectId: 'foreign' })), /another Project/)
    folderAvailable = false
    await assert.rejects(tools.get('read')!.execute({ path }, context), /Folder unavailable/)
    folderAvailable = true
    await deploy(true, false)
    await assert.rejects(tools.get('read')!.execute({ path }, context), /changed/)
    const noGrant = service.resolve(id)!
    assert.equal(noGrant.binding.readResources, undefined)
    const noGrantTools = service.tools(noGrant, id)
    const noGrantContext = { ...context, tools: noGrantTools }
    assert.deepEqual(JSON.parse(String(await noGrantTools.get('read')!.execute({ path: '.' }, noGrantContext))), { path: '.', entries: [] })
    for (const denied of [path, 'v:memory/', 'v:knowledge/catalog']) {
      await assert.rejects(noGrantTools.get('read')!.execute({ path: denied }, noGrantContext))
      await assert.rejects(noGrantTools.get('search')!.execute({ handler: 'grep', path: denied, query: 'Hello' }, noGrantContext))
    }
    await deploy(false)
    await assert.rejects(tools.get('read')!.execute({ path }, context), /disabled|changed/)
    assert.throws(() => service.resolve(id), /disabled/)
  })
})

test('remote Service folder only requests existing file-only reads, never remote directory dumps or Main fallback', async () => {
  await withTempWorkspace(async workspace => {
    const { CapabilityFilesystem } = await import('../execution/capability-filesystem.ts')
    const projectId = 'p', folderId = randomUUID()
    const remoteRoot = join(workspace, 'synthetic-child-root')
    await mkdir(remoteRoot)
    await writeFile(join(remoteRoot, 'guide.txt'), 'CHILD_CANARY')
    await writeFile(join(remoteRoot, '.env'), 'DENIED_CHILD_CANARY')
    const folder = { id: folderId, projectId, name: 'Child Docs', path: 'C:\\Unresolvable Display\\Child Docs', createdAt: '', kind: 'remote',
      workdir: { version: 2, nodeId: 'fixture-child', workdirId: 'fixture-root' } } as import('../folders/contracts.ts').RemoteFolderRecord
    const deployments = new BotDeployments({ projectId, directory: join(workspace, 'bots'), runGit: async () => { throw new Error('No git') } })
    const address = { projectId, botInstanceId: 'connection', platform: 'qq', conversationId: 'group:child' }
    const frozen = deployments.freeze({ 'BOT.md': '---\nid: support\nconfig: bot.json\n---\nPublic BOT prompt',
      'bot.json': JSON.stringify({ mode: 'service', readResources: { folders: [folderId] }, allowedModules: [], tools: [], bindings: [{ ...address, projectId: undefined, tools: ['read', 'search'] }] }) })
    await deployments.deploy({ id: 'support', source: { folderId, directory: '' }, ...frozen })
    const filesystem = new CapabilityFilesystem([{ workdirId: folder.workdir.workdirId, rootPath: remoteRoot }])
    const requests: unknown[] = []
    const service = new DirectoryBotService({ projectId, workspace,
      folders: { get: () => folder, requireAvailable: async () => folder, acquireAccess: () => () => {} },
      remoteExecutor: {
        getStatus: async () => null,
        cancel: async () => { throw new Error('Unexpected cancel') },
        async *execute(request, signal) {
          requests.push(request.args)
          const chunk = await filesystem.execute(request, signal)
          const event = { version: 1 as const, jobId: request.jobId, timestamp: new Date().toISOString() }
          yield { ...event, type: 'stdout', sequence: 0, chunk }
          yield { ...event, type: 'completed', sequence: 1, receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'completed', finishedAt: event.timestamp } }
        },
      },
    }, new DirectoryBots(deployments))
    const sessionId = channelSessionId(address), tools = service.tools(service.resolve(sessionId)!, sessionId)
    const context = { projectId, sessionId, signal: new AbortController().signal } as ExecutionContext
    const read = (path: string) => tools.get('read')!.execute({ path }, context)
    const search = (path: string, handler: string) => tools.get('search')!.execute({ path, handler, query: '*' }, context)
    assert.match(String(await read('Child Docs/guide.txt')), /CHILD_CANARY/)
    await assert.rejects(read('Child Docs'), /regular file/)
    await assert.rejects(search('Child Docs', 'grep'), /regular file/)
    await assert.rejects(search('Child Docs', 'glob'), /cannot safely enumerate/)
    await assert.rejects(read('Child Docs/.env'), /not permitted/)
    assert.deepEqual(requests, [{ path: 'guide.txt', kind: 'file' }, { path: '.', kind: 'file' }, { path: '.', kind: 'file' }])
  })
})
