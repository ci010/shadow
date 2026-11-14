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
  return {root,source,save,deployments,runtime,context,options,tool,get asks(){return asks},fail:()=>{fail=true},propose:(expectedRevision?:string)=>tool.execute({action:'propose',folderId:'folder',summary:'Update support instructions',...(expectedRevision?{expectedRevision}:{})},context)}
}

test('authenticated publication deploys exact frozen files with zero native asks and no pending activation', async t => {
  const f = fixture(t)
  f.options.ask.execute = async () => { throw Error('Must never ask for a second approval') }
  f.options.publish = async (_id, change) => { f.save('Later source edit'); return change() }
  const result = JSON.parse(await f.propose() as string)
  assert.equal(result.status, 'deployed'); assert.equal(f.asks, 0); assert.equal(f.options.pending.size, 0)
  assert.match(f.deployments.read('support')!.files['BOT.md']!, /Frozen instructions/)
  assert.doesNotMatch(f.deployments.read('support')!.files['BOT.md']!, /Later source edit/)
  assert.ok(result.changes.exactContent)
})
test('owner-only publication, optimistic base, cancellation and live fence failure preserve active deployment', async t => {
  const f = fixture(t)
  for (const patch of [{ projectId: 'foreign' }, { channel: 'discord' }, { admin: false }, { inputSource: 'session' }, { sessionId: 'virtual:child' }, { remoteWorkdir: {} }, { isGroup: true }])
    await assert.rejects(() => f.tool.execute({ action: 'status' }, { ...f.context, ...patch } as ExecutionContext), /authenticated owner/)
  const first = JSON.parse(await f.propose() as string).deployment.revision
  f.save('Candidate'); await assert.rejects(() => f.propose(), /revision changed/)
  const signal = AbortSignal.abort(); await assert.rejects(() => f.tool.execute({ action: 'propose', folderId: 'folder', summary: 'Update', expectedRevision: first }, { ...f.context, signal }))
  f.options.publish = async (_id, change) => { f.fail(); return change() }
  await assert.rejects(() => f.propose(first), /live authority changed/)
  assert.equal(f.deployments.read('support')!.deployment.revision, first)
})
test('authority loss inside exclusion cannot publish, and traversal/symlinks do not execute source', async t => {
  const f = fixture(t)
  f.options.publish = async (_id, change) => { f.options.canAuthor = () => false; return change() }
  await assert.rejects(() => f.propose(), /owner authority changed/)
  f.options.canAuthor = () => true
  await assert.rejects(() => f.tool.execute({ action: 'propose', folderId: 'folder', directory: '../escape', summary: 'Deploy' }, f.context), /traversal/)
  symlinkSync(join(f.source, 'BOT.md'), join(f.source, 'linked'))
  await assert.rejects(() => f.propose(), /symlinks/)
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
test('link edits and publishes only the existing BOT companion; group receiver identity is host-owned', async t => {
  const f = fixture(t), first = JSON.parse(await f.propose() as string).deployment.revision
  const { passiveChannelId } = await import('../channels/passive-contract.ts')
  const source = { version: 1 as const, projectId: 'p', botInstanceId: 'bot', platform: 'qq' as const, conversationId: 'group:two', kind: 'group' as const }
  const tool = botPackageTool({ ...f.options, channelSource: () => source })
  const sourceRevision = f.deployments.freezeDirectory(f.source).revision
  const input = { action: 'link', folderId: 'folder', summary: 'Link existing BOT', channelSessionId: passiveChannelId(source), expectedRevision: first, sourceRevision, bindingJson: JSON.stringify({ enabled: true, trigger: 'all', allowFrom: ['owner'], tools: [] }) }
  const result = JSON.parse(await tool.execute(input, f.context) as string)
  assert.equal(result.status, 'deployed'); assert.equal(f.deployments.list().length, 1)
  const { parseBot } = await import('./sdk.ts'), bot = parseBot(f.deployments.read('support')!.files)
  assert.equal(bot.id, 'support'); assert.equal(bot.bindings.length, 2)
  assert.equal(bot.bindings[1]?.platform === 'qq' && bot.bindings[1].conversationId, 'group:two')
  await assert.rejects(() => tool.execute(input, f.context), /source changed|revision changed/)
})
test('link never creates exact thread or DM assignment and never trusts target keys from policy JSON', async t => {
  const f = fixture(t), first = JSON.parse(await f.propose() as string).deployment.revision
  const { passiveChannelId } = await import('../channels/passive-contract.ts')
  const base = { version: 1 as const, projectId: 'p', botInstanceId: 'bot', platform: 'qq' as const, conversationId: 'dm:one', kind: 'direct' as const }
  const tool = botPackageTool({ ...f.options, channelSource: () => base })
  await assert.rejects(() => tool.execute({ action: 'link', folderId: 'folder', summary: 'Link', channelSessionId: passiveChannelId(base), expectedRevision: first, sourceRevision: f.deployments.freezeDirectory(f.source).revision, bindingJson: JSON.stringify({ enabled: true, trigger: 'all', allowFrom: [], tools: [] }) }, f.context), /top-level/)
  const { assignChannelSource } = await import('./channel-assignment.ts')
  assert.throws(() => assignChannelSource(f.deployments.read('support')!.files, { ...base, kind: 'group' }, { platform: 'qq' }), /targets/)
})
