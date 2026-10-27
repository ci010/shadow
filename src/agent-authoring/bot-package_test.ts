import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { compileBotPackage, readBotDirectory, replaceBotPackage } from './bot-package.ts'
import { testResourceTool } from './checks.ts'
import { AgentResourceStore } from './store.ts'
import { AgentAuthoringService } from './service.ts'
import { CapabilityBroker } from './capabilities.ts'
import { PublicationRequests, authoringPublicationPlugin } from './publication-requests.ts'
import { botPackagePlugin, botPackageTool } from './bot-package-management.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'

function sources(prompt = 'Frozen instructions') {
  return { 'BOT.md': `---\nname: support\nallowedTools: []\nchannels: [channels/qq.json]\n---\n${prompt}`,
    'channels/qq.json': JSON.stringify([{ botInstanceId: 'bot', platform: 'qq', conversationId: 'group:one', allowFrom: ['owner'] }]) }
}

test('BOT directory API freezes exact source; owner approval activates actual policy; retained rollback and failed activation are safe', async () => {
  const root = join(process.cwd(), '.test-artifacts', randomUUID())
  const draft = join(root, 'draft')
  mkdirSync(join(draft, 'channels'), { recursive: true })
  const save = (prompt?: string) => { for (const [path, text] of Object.entries(sources(prompt))) writeFileSync(join(draft, path), text) }
  save()
  const store = new AgentResourceStore({ projectId: 'p', directory: join(root, 'private') })
  const broker = new CapabilityBroker({ projectId: 'p', directory: join(root, 'broker'), resolveSecret: async () => undefined, canDeliver: () => false, deliver: async () => {} })
  const service = new AgentAuthoringService({ projectId: 'p', workspace: root, store, broker, folders: {
    get: () => undefined, requireAvailable: async () => ({ id: 'folder', name: 'draft', path: draft, createdAt: new Date().toISOString() }), acquireAccess: () => () => {},
  } })
  let fail = false
  const options = { service, retire: async () => {}, validateLive: async () => { if (fail) throw new Error('Live validation failed') } }
  const requests = new PublicationRequests(options)
  const app = new Hono()
  const authorize = (req: Request) => req.headers.get('Authorization') === 'owner'
  authoringPublicationPlugin(requests, authorize)(app)
  const post = async (path: string, body: unknown, owner = true) => app.request(path, { method: 'POST', headers: { Authorization: owner ? 'owner' : '', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const tools = new SessionTools(new Tools(root), root)
  tools.setExecutionScope('session', [])
  const records = new Map<string, import('./bot-review-contract.ts').BotReviewRecord>()
  const reviews = {record:async (record:import('./bot-review-contract.ts').BotReviewRecord) => {records.set(record.id,structuredClone(record))},read:async (id:string) => [...records.values()].filter(record => record.origin.sessionId === id)}
  botPackagePlugin({...options,publicationRequests:requests,inventory:()=>({}),reviews},authorize)(app)
  const context = {toolCallId:'host-call',physicalSessionId:'owner-segment',projectId:'p', sessionId:'web:owner', channel:'web', inputSource:'user', admin:true, tools, signal:new AbortController().signal} as ExecutionContext
  const tool = botPackageTool({...options, reviews, publicationRequests:requests, inventory:()=>({}), canAuthor:id=>id==='web:owner'})
  const review = async () => JSON.parse(await tool.execute({action:'propose', folderId:'folder',expectedRevision:store.draft().revision}, context) as string).request
  const approve = (request: { id: string; revision: string; baseRevision: string }) => post(`/api/agent-resources/publication-requests/${request.id}`, { revision: request.revision, baseRevision: request.baseRevision })
  try {
    assert.equal((await post('/api/bot-package/review', {}, false)).status, 401)
    for (const patch of [{projectId:'foreign'}, {channel:'discord'}, {admin:false}, {inputSource:'session'}, {sessionId:'virtual:child'}]) {
      await assert.rejects(() => tool.execute({action:'status'}, {...context,...patch} as ExecutionContext), /authenticated owner/)
    }
    tools.setExecutionScope('task',[])
    await assert.rejects(()=>tool.execute({action:'status'},context),/authenticated owner/)
    tools.setExecutionScope('session',[])
    assert.equal(JSON.parse(await tool.execute({action:'status'},context) as string).projectId,'p')
    await assert.rejects(() => tool.execute({action:'commit'},context))
    const first = await review()
    assert.equal(first.sessionId,'web:owner')
    assert.equal(records.get(first.id)?.status,'pending')
    assert.equal((await app.request('/api/bot-package/reviews/web%3Aowner')).status,401)
    const history = async (id='web:owner') => (await (await app.request('/api/bot-package/reviews/'+encodeURIComponent(id),{headers:{Authorization:'owner'}})).json()).reviews
    assert.equal((await history())[0].id,first.id)
    assert.deepEqual(await history('web:other'),[])
    assert.ok(first.files.some((file: { path: string }) => file.path === 'bot/support/BOT.md'))
    assert.equal(store.resolve({ projectId: 'p', botInstanceId: 'bot', platform: 'qq', conversationId: 'group:one' }), undefined)
    save('Unreviewed disk edit')
    assert.equal((await approve(first)).status, 200)
    assert.equal((await history())[0].status,'applied')
    assert.ok((await history())[0].decidedAt)
    assert.equal((await approve(first)).status,409)
    const reopenedRequests = new PublicationRequests(options)
    assert.equal(reopenedRequests.reviewStatus(first).status,'applied')
    reopenedRequests.stop()
    const address = { projectId: 'p', botInstanceId: 'bot', platform: 'qq', conversationId: 'group:one' }
    assert.equal(store.resolve(address)?.agent.prompt, 'Frozen instructions')
    const second = await review()
    fail = true
    assert.equal((await approve(second)).status, 500)
    assert.equal(store.snapshot().revision, first.revision)
    fail = false
    assert.equal((await approve(second)).status, 200)
    assert.equal(store.resolve(address)?.agent.prompt, 'Unreviewed disk edit')
    save('Cancelled candidate')
    const cancelled = await review()
    requests.cancel(cancelled.id,{revision:cancelled.revision,baseRevision:cancelled.baseRevision})
    assert.equal((await history()).find((r:{id:string})=>r.id===cancelled.id).status,'cancelled')
    const afterCancelRestart = new PublicationRequests(options)
    assert.equal(afterCancelRestart.reviewStatus(cancelled).status,'cancelled')
    afterCancelRestart.stop()
    assert.equal((await approve(cancelled)).status,409)
    const response = await post('/api/bot-package/review', { packageId: 'support', release: store.packageStatus()[0]!.retained[0]!.revision, expectedRevision: store.draft().revision })
    assert.equal(response.status, 200)
    assert.equal((await approve((await response.json()).request)).status, 200)
    assert.equal(store.resolve(address)?.agent.prompt, 'Frozen instructions')
    const tampered = structuredClone(store.snapshot().bundle)
    tampered.files['agents/support/AGENT.md'] += '\nBypass'
    assert.equal(store.validate(store.candidate(tampered)).valid, false)
    assert.equal(new AgentResourceStore({ projectId: 'p', directory: join(root, 'private') }).snapshot().revision, first.revision)
  } finally { requests.stop(); rmSync(root, { recursive: true, force: true }) }
})

test('plain validation never executes advanced entry; dependencies and unscoped native imports fail closed', () => {
  assert.throws(() => compileBotPackage({ ...sources(), 'initialize.ts': 'throw new Error("executed")' }), /Unsupported BOT file/)
  assert.throws(() => compileBotPackage({ ...sources(), 'package.json': '{}' }), /Unsupported BOT file/)
  assert.throws(() => compileBotPackage({ ...sources(), 'BOT.md': sources()['BOT.md'].replace('allowedTools: []', 'allowedTools: []\nallowedModules: ["node:fs"]') }), /pure Node/)
  const root = join(process.cwd(), '.test-artifacts', randomUUID())
  mkdirSync(root, { recursive: true })
  try { symlinkSync('missing', join(root, 'BOT.md')); assert.throws(() => readBotDirectory(root), /symlinks/) }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('declared skill dependency closure is frozen, validated and permission-restricted', async () => {
  const root = join(process.cwd(), '.test-artifacts', randomUUID())
  mkdirSync(root, { recursive: true })
  const source = sources()
  source['BOT.md'] = source['BOT.md'].replace('allowedTools: []', 'allowedTools: [echo]')
  source['channels/qq.json'] = JSON.stringify([{ botInstanceId: 'bot', platform: 'qq', conversationId: 'group:one', skills: ['echo'] }])
  const skillSource = { ...source,
    'skills/echo/SKILL.md': '---\nname: echo\ntools:\n  echo:\n    source: echo.ts\n    description: Echo\n    parameters:\n      type: object\n      properties: {}\n      additionalProperties: false\n---\nEcho only.',
    'skills/echo/echo.ts': 'export async function run(args: Record<string, unknown>) { return { ok: true } }',
  }
  try {
    const store = new AgentResourceStore({ projectId: 'p', directory: root })
    const bundle = compileBotPackage(skillSource)
    assert.equal(store.validate(store.candidate(bundle)).valid, true)
    assert.equal(bundle.files['bot/support/skills/echo/echo.ts'], bundle.files['skills/echo/echo.ts'])
    const address = { projectId: 'p', botInstanceId: 'bot', platform: 'qq', conversationId: 'group:one' }
    const policy = store.preview(address, store.candidate(bundle))!
    assert.deepEqual((await testResourceTool(policy, { toolName: 'echo', arguments: {} }, new AbortController().signal)).result, { ok: true })
    const forbidden = store.preview(address, store.candidate(compileBotPackage({ ...skillSource, 'skills/echo/echo.ts': 'import fs from "node:fs"; export function run() {}' })))!
    await assert.rejects(() => testResourceTool(forbidden, { toolName: 'echo', arguments: {} }, new AbortController().signal), /import|module|denied|permitted/i)
    assert.throws(() => compileBotPackage({ ...skillSource, 'channels/unreferenced.json': '[]' }), /Unreferenced/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('independent BOT releases retain policies, sources and rollback history across restart', async () => {
  const root = join(process.cwd(), '.test-artifacts', randomUUID())
  const options = {projectId:'p',directory:root}
  const bot = (name: string, prompt: string) => compileBotPackage({
    'BOT.md': `---\nname: ${name}\nchannels: [channels/main.json]\n---\n${prompt}`,
    'channels/main.json': JSON.stringify([{botInstanceId:name,platform:'qq',conversationId:'group:one'}]),
  })
  const address = (name:string) => ({projectId:'p',platform:'qq',botInstanceId:name,conversationId:'group:one'})
  try {
    let store = new AgentResourceStore(options)
    const publish = async (bundle: ReturnType<typeof bot>) => {
      const staged = await store.stage({expectedRevision:store.draft().revision,bundle:replaceBotPackage(store.snapshot().bundle,bundle)})
      return store.publish(staged.revision)
    }
    await publish(bot('alpha','A1'))
    const a1 = store.packageStatus().find(p=>p.id==='alpha')!.activeRelease
    await publish(bot('beta','B1'))
    const beforeB = store.resolve(address('beta'))!
    await publish(bot('alpha','A2'))
    assert.equal(store.resolve(address('beta'))!.agent.prompt,beforeB.agent.prompt)
    assert.equal(store.snapshot().bundle.files['bot/beta/BOT.md'],bot('beta','B1').files['bot/beta/BOT.md'])
    store = new AgentResourceStore(options)
    await publish(store.retainedPackage('alpha',a1))
    assert.equal(store.resolve(address('alpha'))!.agent.prompt,'A1')
    assert.equal(store.resolve(address('beta'))!.agent.prompt,'B1')
    assert.throws(()=>replaceBotPackage(store.snapshot().bundle,compileBotPackage({...sources(),'BOT.md':sources()['BOT.md'].replace('name: support','name: gamma'),'channels/qq.json':JSON.stringify([{botInstanceId:'alpha',platform:'qq',conversationId:'group:one'}])})),/owned/)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('explicit legacy adoption preserves exact approved policy and refuses drift or owned resources', async () => {
  const { stringify } = await import('yaml')
  const markdown = '---\ndescription: Legacy\ndefaultMode: session\nallowedTools: []\nallowedModules: []\ncapabilityProfiles: []\n---\nFrozen instructions'
  const source = {...sources(), 'BOT.md': `---\n${stringify({name:'support',description:'Legacy',allowedTools:[],allowedModules:[],channels:['channels/qq.json'],agentMarkdown:markdown})}---\nFrozen instructions`}
  const next = compileBotPackage(source)
  const base = {version:1 as const,files:Object.fromEntries(Object.entries(next.files).filter(([p])=>!p.startsWith('bot/'))),bindings:next.bindings}
  assert.throws(()=>replaceBotPackage(base,next),/owned/)
  const adopted = replaceBotPackage(base,next,true)
  assert.equal(adopted.files['agents/support/AGENT.md'],markdown)
  assert.deepEqual(adopted.bindings,base.bindings)
  assert.throws(()=>replaceBotPackage({...base,bindings:[]},next,true),/exact/)
  assert.throws(()=>replaceBotPackage({...base,files:{...base.files,'agents/support/AGENT.md':markdown+'drift'}},next,true),/identical/)
  assert.throws(()=>replaceBotPackage(adopted,next,true),/unowned/)
})

test('legacy adoption staging checks active Release CAS inside the store mutation', async () => {
  const root = join(process.cwd(), '.test-artifacts', randomUUID())
  const store = new AgentResourceStore({projectId:'p',directory:root})
  try {
    const before = store.snapshot(), draft = store.draft()
    await assert.rejects(()=>store.stage({expectedRevision:draft.revision,expectedActiveRelease:'sha256:stale',bundle:compileBotPackage(sources())}),/Stale active Release/)
    assert.deepEqual(store.snapshot(),before)
    assert.deepEqual(store.draft(),draft)
  } finally { rmSync(root,{recursive:true,force:true}) }
})
