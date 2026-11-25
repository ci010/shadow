import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { BotDeployments } from './deployments.ts'
import { DirectoryBots } from './runtime.ts'
import { botPackageTool, botPackagePlugin } from './management.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { Tool, ToolResult } from '../tools/tool.ts'

function files(prompt='Frozen instructions') {
  return {'BOT.md':`---\nid: support\nconfig: bot.json\n---\n${prompt}`,'bot.json':JSON.stringify({mode:'service',allowedModules:[],tools:[],bindings:[{platform:'qq',botInstanceId:'bot',conversationId:'group:one',tools:[]}]})}
}
function fixture(t:TestContext) {
  const root=join(process.cwd(),'.tmp',`bot-integration-${randomUUID()}`),source=join(root,'source')
  mkdirSync(source,{recursive:true})
  const save=(prompt?:string)=>{for(const[path,text]of Object.entries(files(prompt)))writeFileSync(join(source,path),text)}
  save()
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const deployments=new BotDeployments({directory:join(root,'internal'),projectId:'p',runGit:async()=>{throw new Error('Git unavailable')}})
  const runtime=new DirectoryBots(deployments)
  const tools=new SessionTools(new Tools(root),root);tools.setExecutionScope('session',[])
  const context={projectId:'p',sessionId:'web:owner',physicalSessionId:'physical',channel:'web',senderId:'owner',inputSource:'user',admin:true,tools,signal:new AbortController().signal} as ExecutionContext
  let fail = false, asks = 0
  const ask: Tool<ToolResult> = { name: 'ask', description: 'Forbidden extra approval', parameters: { type: 'object', properties: {} }, execute: async () => { asks++; throw new Error('No extra approval permitted') } }
  const options={pending:new Map<string,unknown>(),projectId:'p',deployments,runtime,folders:{acquireAccess:()=>()=>{},requireAvailable:async()=>({id:'folder',name:'source',path:source,createdAt:new Date().toISOString()}),list:()=>[]},ask,canAuthor:(id:string):boolean=>id==='web:owner',validate:async(_files:Record<string,string>,_signal:AbortSignal)=>{if(fail)throw new Error('live authority changed')},publish:async<T>(_id:string,change:()=>Promise<T>)=>change(),changed:(_ids:string[])=>{}}
  const tool=botPackageTool(options)
  return {root,source,save,deployments,runtime,context,options,tool,get asks(){return asks},fail:()=>{fail=true},reload:()=>tool.execute({action:'reload',folderId:'folder',summary:'Update support instructions'},context)}
}

test('authenticated publication deploys exact frozen files with zero native asks and no pending activation', async t => {
  const f = fixture(t)
  f.options.ask.execute = async () => { throw Error('Must never ask for a second approval') }
  f.options.publish = async (_id, change) => { f.save('Later source edit'); return change() }
  const result = JSON.parse(await f.reload() as string)
  assert.equal(result.status, 'deployed'); assert.equal(f.asks, 0); assert.equal(f.options.pending.size, 0)
  assert.match(f.deployments.read('support')!.files['BOT.md']!, /Frozen instructions/)
  assert.doesNotMatch(f.deployments.read('support')!.files['BOT.md']!, /Later source edit/)
  assert.ok(result.changes.exactContent)
})
test('owner-only publication, cancellation and live fence failure preserve active deployment', async t => {
  const f = fixture(t)
  for (const patch of [{ projectId: 'foreign' }, { channel: 'discord' }, { admin: false }, { inputSource: 'session' }, { sessionId: 'virtual:child' }, { remoteWorkdir: {} }, { isGroup: true }])
    await assert.rejects(() => f.tool.execute({ action: 'status' }, { ...f.context, ...patch } as ExecutionContext), /authenticated owner/)
  const first = JSON.parse(await f.reload() as string).deployment.revision
  f.save('Candidate')
  const signal = AbortSignal.abort(); await assert.rejects(() => f.tool.execute({ action: 'reload', folderId: 'folder', summary: 'Update' }, { ...f.context, signal }))
  f.options.publish = async (_id, change) => { f.fail(); return change() }
  await assert.rejects(() => f.reload(), /live authority changed/)
  assert.equal(f.deployments.read('support')!.deployment.revision, first)
})
test('authority loss inside exclusion cannot publish, and traversal/symlinks do not execute source', async t => {
  const f = fixture(t)
  f.options.publish = async (_id, change) => { f.options.canAuthor = () => false; return change() }
  await assert.rejects(() => f.reload(), /owner authority changed/)
  f.options.canAuthor = () => true
  await assert.rejects(() => f.tool.execute({ action: 'reload', folderId: 'folder', directory: '../escape', summary: 'Deploy' }, f.context), /traversal/)
  symlinkSync(join(f.source, 'BOT.md'), join(f.source, 'linked'))
  await assert.rejects(() => f.reload(), /symlinks/)
  assert.equal(f.deployments.list().length, 0)
})
test('owner inventory has no approval endpoint or pending authority', async t => {
  const f = fixture(t), app = new Hono()
  botPackagePlugin(f.options, request => request.headers.get('x-owner') === 'yes')(app)
  assert.equal((await app.request('/api/bot-package')).status, 401)
  const response = await app.request('/api/bot-package', { headers: { 'x-owner': 'yes' } })
  assert.deepEqual((await response.json()).pending, [])
  assert.equal((await app.request('/api/bot-package/review', { method: 'POST' })).status, 404)
})
test('create is explicit new source plus immediate exact publication, never overwrites existing source', async t => {
  const f = fixture(t)
  const result = JSON.parse(await f.tool.execute({ action: 'create', id: 'new-role', folderId: 'folder', directory: 'new-role', prompt: 'Only this role', summary: 'Create a BOT' }, f.context) as string)
  assert.equal(result.status, 'deployed'); assert.equal(f.asks, 0)
  const { parseBot } = await import('./sdk.ts'), bot = parseBot(f.deployments.read('new-role')!.files)
  assert.deepEqual(bot.bindings, []); assert.deepEqual(bot.subscriptions, []); assert.deepEqual(bot.tools, [])
  await assert.rejects(() => f.tool.execute({ action: 'create', id: 'other', folderId: 'folder', directory: 'new-role', prompt: 'Other', summary: 'Create' }, f.context), /overwrite/)
})
test('source resolves trusted addresses read-only; ordinary source edits reload without preflight', async t => {
  const f = fixture(t)
  const { passiveChannelId } = await import('../channels/passive-contract.ts')
  const source = { version: 1 as const, projectId: 'p', connectionId: 'bot', platform: 'qq' as const, conversationId: 'group:two', kind: 'group' as const }
  const tool = botPackageTool({ ...f.options, channelSource: () => source })
  const request = { action: 'source', folderId: 'folder', channelSessionId: passiveChannelId(source) }
  const result = JSON.parse(await tool.execute(request, f.context) as string)
  assert.equal(f.deployments.list().length, 0)
  assert.equal(result.sourceRevision, undefined)
  assert.deepEqual(result.addresses.conversation.binding, { platform: 'qq', botInstanceId: 'bot', conversationId: 'group:two' })
  await assert.rejects(() => tool.execute({ ...request, channelSessionId: passiveChannelId({ ...source, projectId: 'foreign' }) }, f.context), /origin mismatch/)
  const config = JSON.parse(files()['bot.json'])
  config.bindings.push({ ...result.addresses.conversation.binding, enabled: true, trigger: 'all', tools: [] })
  config.subscriptions = [result.addresses.conversation.subscription]
  writeFileSync(join(f.source, 'bot.json'), JSON.stringify(config))
  const deployed = JSON.parse(await f.reload() as string)
  assert.equal(deployed.changes.bindings.length, 2)
  assert.deepEqual(deployed.changes.subscriptions, config.subscriptions)
  await assert.rejects(() => tool.execute({ action: 'link', folderId: 'folder', summary: 'Removed' }, f.context))
  assert.equal('bindingJson' in tool.parameters.properties!, false)
  assert.equal('scope' in tool.parameters.properties!, false)
})

test('BOT prompt tab reads only the authorized exact deployed revision, never later source edits', async t => {
  const f = fixture(t), app = new Hono()
  const revision = JSON.parse(await f.reload() as string).deployment.revision
  f.save('Unpublished source changes')
  botPackagePlugin(f.options, request => request.headers.get('x-owner') === 'yes')(app)
  const url = `/api/bot-package/support/prompt?revision=${revision}`
  assert.equal((await app.request(url)).status, 401)
  const response = await app.request(url, { headers: { 'x-owner': 'yes' } })
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.id, 'support'); assert.equal(data.revision, revision)
  assert.match(data.prompt, /Frozen instructions/)
  assert.doesNotMatch(data.prompt, /Unpublished source changes/)
  assert.deepEqual(Object.keys(data).sort(), ['id', 'prompt', 'revision', 'source'])
  assert.equal((await app.request('/api/bot-package/support/prompt?revision=stale', { headers: { 'x-owner': 'yes' } })).status, 409)
  assert.equal((await app.request('/api/bot-package/missing/prompt?revision=stale', { headers: { 'x-owner': 'yes' } })).status, 404)
})

test('Knowledge lists and reads Markdown only from verified Project deployments', async t => {
  const f = fixture(t), app = new Hono(), headers = { 'x-owner': 'yes' }
  mkdirSync(join(f.source, 'docs'))
  writeFileSync(join(f.source, 'docs', 'README.MD'), '# Deployed companion')
  const revision = JSON.parse(await f.reload() as string).deployment.revision
  writeFileSync(join(f.source, 'docs', 'README.MD'), '# Not deployed')
  const other = new BotDeployments({directory:join(f.root,'other'),projectId:'other'})
  await other.deploy({ id: 'foreign', source: { folderId: 'folder', directory: 'foreign' }, ...other.freeze({ 'BOT.md': '# Other Project' }) })
  botPackagePlugin(f.options, request => request.headers.get('x-owner') === 'yes')(app)
  const list = '/api/bot-package?documents=markdown'
  assert.equal((await app.request(list)).status, 401)
  assert.deepEqual(await (await app.request(list, { headers })).json(), {
    projectId: 'p', partial: false, documents: [{ id: 'support', revision, paths: ['BOT.md', 'docs/README.MD'] }],
  })
  const file = (id: string, path: string, rev = revision) => `/api/bot-package/${id}/prompt?${new URLSearchParams({ path, revision: rev })}`
  assert.equal((await app.request(file('support', 'docs/README.MD'))).status, 401)
  assert.equal((await (await app.request(file('support', 'docs/README.MD'), { headers })).json()).prompt, '# Deployed companion')
  assert.equal((await app.request(file('support', 'bot.json'), { headers })).status, 404)
  assert.equal((await app.request(file('support', '../BOT.md'), { headers })).status, 404)
  assert.equal((await app.request(file('support', 'docs/README.MD', 'stale'), { headers })).status, 409)
  assert.equal((await app.request(file('foreign', 'BOT.md'), { headers })).status, 404)
  await f.deployments.deploy({ id: 'damaged', source: { folderId: 'folder', directory: 'damaged' }, ...f.deployments.freeze({ 'BOT.md': '# Damaged' }) })
  writeFileSync(join(f.deployments.runtimeDirectory('damaged'), 'BOT.md'), '# Unverified overwrite')
  const partial = await (await app.request(list, { headers })).json()
  assert.equal(partial.partial, true)
  assert.deepEqual(partial.documents.map((entry: { id: string }) => entry.id), ['support'])
})

test('Knowledge runtime endpoint is owner-only, revision-bound and derives scope exclusively from subscriptions', async t => {
  const f = fixture(t), app = new Hono(), headers = { 'x-owner': 'yes' }
  const snapshot = files()
  const base = JSON.parse(snapshot['bot.json'])
  const binding = base.bindings[0]
  snapshot['bot.json'] = JSON.stringify({ ...base,
    bindings: [{ ...binding, enabled: true }, { ...binding, conversationId: 'group:disabled', enabled: false }, { ...binding, conversationId: 'group:unsubscribed', enabled: true }],
    subscriptions: [binding, { ...binding, conversationId: 'group:disabled' }].map(({ platform, botInstanceId, conversationId }) => ({ platform, botInstanceId, conversationId })),
  })
  writeFileSync(join(f.source, 'bot.json'), snapshot['bot.json'])
  const revision = JSON.parse(await f.reload() as string).deployment.revision
  const selected: unknown[] = []
  botPackagePlugin(f.options, request => request.headers.get('x-owner') === 'yes', (bot, rev, scope) => {
    assert.equal(bot.id, 'support')
    assert.equal(rev, revision)
    selected.push(scope)
    return { source: 'preview', systemPrompt: 'Assembled runtime', sections: [], tools: [{ name: 'scoped_tool', description: 'Actual tool definition', parameters: { type: 'object', properties: {} } }] }
  })(app)
  const route = '/api/bot-package/support/runtime-context'
  const req = (suffix = '') => app.request(`${route}?revision=${revision}${suffix}`, { headers })
  const denied = await app.request(`${route}?revision=${revision}&scope=0`)
  assert.equal(denied.status, 401)
  assert.equal(denied.headers.get('cache-control'), 'no-store')
  assert.equal((await app.request(`${route}?revision=stale&scope=0`, { headers })).status, 409)
  assert.equal((await app.request(`/api/bot-package/foreign/runtime-context?revision=${revision}&scope=0`, { headers })).status, 404)
  const overview = await (await req()).json()
  assert.equal(overview.projectId, 'p')
  assert.equal(overview.mode, 'service')
  assert.equal(overview.scopes.length, 2)
  assert.equal(overview.runtime, undefined)
  assert.equal((await req('&scope=2')).status, 404)
  assert.equal((await req('&scope=web:arbitrary')).status, 404)
  assert.equal((await (await req('&scope=1')).json()).result, 'disabled')
  assert.deepEqual(selected, [])
  const result = await (await req('&scope=0&sessionId=web:unrelated')).json()
  assert.equal(result.result, 'available')
  assert.deepEqual(result.runtime, { source: 'preview', systemPrompt: 'Assembled runtime', sections: [], tools: [{ name: 'scoped_tool', description: 'Actual tool definition', parameters: { type: 'object', properties: {} } }] })
  assert.equal((selected[0] as typeof binding).conversationId, 'group:one')
})

test('owner assignment and deployment receipts explicitly surface shared Knowledge and Wiki grants', async t => {
  const f = fixture(t)
  const { passiveChannelId } = await import('../channels/passive-contract.ts')
  const source = { version: 1 as const, projectId: 'p', connectionId: 'bot', platform: 'qq' as const, conversationId: 'group:two', kind: 'group' as const }
  const tool = botPackageTool({ ...f.options, channelSource: () => source })
  const config = JSON.parse(files()['bot.json'])
  config.readResources = { knowledge: true, wiki: true }
  writeFileSync(join(f.source, 'bot.json'), JSON.stringify(config))
  await f.reload()
  const configSource = JSON.parse(await tool.execute({ action: 'source', folderId: 'folder', channelSessionId: passiveChannelId(source) }, f.context) as string)
  config.bindings.push({ ...configSource.addresses.conversation.binding, enabled: true, trigger: 'all', tools: ['read', 'search'] })
  writeFileSync(join(f.source, 'bot.json'), JSON.stringify(config))
  assert.equal(f.deployments.list().length, 1)
  const receipt = JSON.parse(await f.reload() as string)
  assert.deepEqual(receipt.changes.readResources, { knowledge: true, wiki: true })
  assert(receipt.changes.candidatePermissions.includes('BOT-wide read grant: Project Knowledge metadata and scoped relations (v:knowledge)'))
  assert(receipt.changes.candidatePermissions.some((line: string) => line.includes('inherits BOT-wide read grant: shared Project Wiki content (v:memory)')))
  assert.deepEqual(receipt.changes.bindings.at(-1).inheritedReadResources, { knowledge: true, wiki: true })
})

test('proposal rejects the removed marker without changing active read authority', async t => {
  const f = fixture(t)
  const config = JSON.parse(files()['bot.json'])
  const active = JSON.parse(await f.reload() as string).deployment.revision
  writeFileSync(join(f.source, 'bot.json'), JSON.stringify({ ...config, readResourcesModel: 'bot-wide', readResources: { wiki: true } }))
  await assert.rejects(() => f.reload(), /Unrecognized key/)
  assert.equal(f.deployments.read('support')?.deployment.revision, active)
  assert.equal(f.runtime.resolve(config.bindings[0])?.binding.readResources, undefined)
})

test('reload uses current source without revision preflight and removed authoring contracts fail closed', async t => {
  const f = fixture(t)
  const first = JSON.parse(await f.reload() as string)
  f.save('Current source edit')
  const second = JSON.parse(await f.reload() as string)
  assert.notEqual(first.deployment.revision, second.deployment.revision)
  assert.match(f.deployments.read('support')!.files['BOT.md']!, /Current source edit/)
  const source = JSON.parse(await f.tool.execute({ action: 'source', folderId: 'folder' }, f.context) as string)
  assert.equal(source.bot, 'support')
  assert.equal(source.sourceRevision, undefined)
  for (const action of ['assign', 'propose', 'link']) await assert.rejects(() => f.tool.execute({ action, folderId: 'folder', summary: 'Removed action' }, f.context))
  for (const key of ['sourceRevision', 'expectedRevision']) await assert.rejects(() => f.tool.execute({ action: 'reload', folderId: 'folder', summary: 'No revision input', [key]: first.deployment.revision }, f.context), /Unrecognized key/)
  const properties = f.tool.parameters.properties!
  assert.equal('sourceRevision' in properties, false)
  assert.equal('expectedRevision' in properties, false)
})

test('directly written source cannot bypass centralized live validation at either reload fence', async t => {
  const f = fixture(t)
  const first = JSON.parse(await f.reload() as string).deployment.revision
  const { parseBot } = await import('./sdk.ts')
  const { validateServiceAssignments } = await import('./assignment-validation.ts')
  const config = JSON.parse(files()['bot.json'])
  config.bindings[0].botInstanceId = 'foreign'
  writeFileSync(join(f.source, 'bot.json'), JSON.stringify(config))
  f.options.validate = async candidate => {
    await validateServiceAssignments('p', { projectId: 'p', assertAccess: () => { throw Error('Connection not in Project') } } as never, parseBot(candidate), [], async () => {})
  }
  await assert.rejects(() => f.reload(), /Connection not in Project/)
  assert.equal(f.deployments.read('support')!.deployment.revision, first)
  f.save('Valid candidate')
  let checks = 0
  f.options.validate = async () => { if (++checks === 2) throw Error('Permissions revoked inside publication') }
  await assert.rejects(() => f.reload(), /Permissions revoked inside publication/)
  assert.equal(checks, 2)
  assert.equal(f.deployments.read('support')!.deployment.revision, first)
})

test('Discord source address projections reuse ids and supply strict subscription references without permissions', async () => {
  const { channelSourceAddresses } = await import('./channel-assignment.ts')
  const { BotSubscriptionSchema, BotBindingSchema } = await import('./sdk.ts')
  const source = { version: 1 as const, projectId: 'p', connectionId: 'connection', platform: 'discord' as const, conversationId: '200000000000000001', kind: 'channel' as const, guildId: '200000000000000002', botUserId: '200000000000000003' }
  const first = channelSourceAddresses(source).conversation!
  BotSubscriptionSchema.parse(first.subscription)
  assert.equal('enabled' in first.binding, false)
  const binding = BotBindingSchema.parse({ ...first.binding, enabled: true, trigger: 'mention', tools: [], participants: { everyone: true, userIds: [], roleIds: [] }, readDomains: [], inheritThreads: false, manage: false })
  assert.deepEqual(channelSourceAddresses(source, [binding]).conversation, first)
  const thread = channelSourceAddresses({ ...source, kind: 'thread', conversationId: '200000000000000004', parentId: source.conversationId }, [binding])
  assert.equal(thread.conversation, undefined)
  assert.deepEqual(thread.parent!.subscription, first.subscription)
  assert.match(thread.parent!.requires, /Explicit inheritThreads:true/)
})

// Stored bytes can be authentic yet no longer satisfy today's configuration schema.
async function retiredReadFolders(t: TestContext) {
  const f = fixture(t), old = files('Retired deployment')
  const config = JSON.parse(old['bot.json'])
  config.bindings[0].readFolders = ['must-not-be-inherited']
  old['bot.json'] = JSON.stringify(config)
  const deployment = await f.deployments.deploy({ id: 'support', source: { folderId: 'folder', directory: '' }, ...f.deployments.freeze(old) })
  return { f, deployment }
}

test('reload replaces authentic obsolete readFolders deployment without inventing a permission baseline', async t => {
  const { f, deployment } = await retiredReadFolders(t)
  const result = JSON.parse(await f.reload() as string)
  assert.equal(result.status, 'deployed')
  assert.equal(result.changes.previousContent, deployment.revision)
  assert.equal(result.changes.permissionBaseline, 'unknown')
  assert.equal(result.changes.addedPermissions, null)
  assert.equal(result.changes.removedPermissions, null)
  assert.equal(result.changes.repair.activeInvalid, true)
  assert.ok(result.changes.candidatePermissions.length)
  assert.doesNotMatch(JSON.stringify(result), /must-not-be-inherited/)
  assert.deepEqual(result.changes.readResources, null)
  assert.deepEqual(f.deployments.read('support')!.files, f.deployments.freeze(files()).files)
})

test('obsolete active schema does not relax candidate schema, Project or live permission checks', async t => {
  const { f, deployment } = await retiredReadFolders(t)
  const config = JSON.parse(files()['bot.json'])
  config.bindings[0].readFolders = ['forbidden']
  writeFileSync(join(f.source, 'bot.json'), JSON.stringify(config))
  await assert.rejects(() => f.reload(), /readFolders/)
  f.save()
  await assert.rejects(() => f.tool.execute({ action: 'reload', folderId: 'folder', summary: 'Replace' }, { ...f.context, projectId: 'foreign' }), /authenticated owner/)
  f.options.publish = async (_id, change) => { f.fail(); return change() }
  await assert.rejects(() => f.reload(), /live authority changed/)
  assert.equal(f.deployments.read('support')!.deployment.revision, deployment.revision)
})

test('obsolete schema never hides damaged deployment bytes or storage read failures', async t => {
  const { f } = await retiredReadFolders(t)
  writeFileSync(join(f.deployments.runtimeDirectory('support'), 'BOT.md'), '# Tampered')
  await assert.rejects(() => f.reload(), /integrity|revision|hash|mismatch/i)
  assert.throws(() => new BotDeployments({ directory: join(f.root, 'internal'), projectId: 'foreign' }), /Project ownership mismatch/)
  const error = Object.assign(new Error('storage permission denied'), { code: 'EACCES' })
  f.deployments.read = () => { throw error }
  await assert.rejects(() => f.reload(), caught => caught === error)
})
