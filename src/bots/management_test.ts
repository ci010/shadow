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
import { AskTool } from '../tools/ask.ts'
import { YieldManager } from '../sessions/yield.ts'
import { parseYieldQuestion, MAX_YIELD_QUESTION_LENGTH } from '../sessions/yield-contract.ts'
import { mountBotUi, settleBotUi } from '../../app/src/bot-ui-test-helpers.ts'

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
  let onAsk:(args:Record<string,unknown>)=>unknown=()=>undefined,fail=false,asks=0
  const yields = new YieldManager({
    getState: sessionId => ({ sessionId, segmentIndex: 0 }), getPolicy: () => ({ timeoutMs: null }),
    notifyParent: async () => { throw new Error('Must ask the owner, not an agent') },
    notifyUser: async request => {
      asks++
      const option = await onAsk({ ...request, default_option: request.defaultOption })
      await yields.answerUser(request.sessionId, request.id, typeof option === 'string' ? option : request.options[0])
    },
  })
  // Exercise the actual AskTool + YieldManager parsers before synthetic owner
  // input. An always-successful ask mock used to hide the 4000-character failure.
  const ask:Tool<ToolResult> = new AskTool(yields, { get: () => null, ask: async () => { throw new Error('Unexpected input request') } })
  const options={pending:new Map<string,unknown>(),projectId:'p',deployments,runtime,folders:{acquireAccess:()=>()=>{},requireAvailable:async()=>({id:'folder',name:'source',path:source,createdAt:new Date().toISOString()}),list:()=>[]},ask,canAuthor:(id:string):boolean=>id==='web:owner',validate:async(_files:Record<string,string>,_signal:AbortSignal)=>{if(fail)throw new Error('live authority changed')},publish:async<T>(_id:string,change:()=>Promise<T>)=>change(),changed:(_ids:string[])=>{}}
  const tool=botPackageTool(options)
  return {root,source,save,deployments,runtime,context,options,tool,get asks(){return asks},onAsk:(fn:typeof onAsk)=>{onAsk=fn},fail:()=>{fail=true},propose:(expectedRevision?:string)=>tool.execute({action:'propose',folderId:'folder',summary:'Update support instructions',...(expectedRevision?{expectedRevision}:{})},context)}
}

test('one native owner confirmation deploys exact frozen files, never later workspace edits',async t=>{
  const f=fixture(t)
  f.onAsk(args=>{assert.match(String(args.question),/权限范围新增/);assert.equal(args.default_option,'取消');f.save('Unapproved disk edit')})
  const result=JSON.parse(await f.propose() as string)
  assert.equal(f.asks,1);assert.equal(result.status,'deployed')
  assert.equal(f.runtime.resolve({platform:'qq',botInstanceId:'bot',conversationId:'group:one'})?.agent.prompt,'Frozen instructions')
  assert.match(f.deployments.read('support')!.files['BOT.md']!,/Frozen instructions/)
  const first=result.deployment.revision
  f.onAsk(()=>{})
  await f.propose(first)
  assert.equal(f.deployments.read('support')!.deployment.previous,first)
  assert.equal(f.runtime.resolve({platform:'qq',botInstanceId:'bot',conversationId:'group:one'})?.agent.prompt,'Unapproved disk edit')
})

test('owner-only publication, cancellation, stale base and live failure preserve deployment',async t=>{
  const f=fixture(t)
  for(const patch of [{projectId:'foreign'},{channel:'discord'},{admin:false},{inputSource:'session'},{sessionId:'virtual:child'}])await assert.rejects(()=>f.tool.execute({action:'status'},{...f.context,...patch} as ExecutionContext),/authenticated owner/)
  const first=JSON.parse(await f.propose() as string).deployment.revision
  f.save('Candidate')
  await assert.rejects(()=>f.propose(),/revision changed/)
  f.options.ask.execute=async()=>JSON.stringify({option:'取消',answeredBy:'user'})
  assert.equal(JSON.parse(await f.propose(first) as string).status,'cancelled')
  assert.equal(f.deployments.read('support')!.deployment.revision,first)
  f.options.ask.execute=async args=>{f.fail();return JSON.stringify({option:(args.options as string[])[0],answeredBy:'user'})}
  await assert.rejects(()=>f.propose(first),/live authority changed/)
  assert.equal(f.deployments.read('support')!.deployment.revision,first)
})

test('BOT inventory is owner-only and has no publication/review-history endpoints',async t=>{
  const f=fixture(t),app=new Hono()
  botPackagePlugin(f.options,request=>request.headers.get('x-owner')==='yes')(app)
  assert.equal((await app.request('/api/bot-package')).status,401)
  assert.equal((await app.request('/api/bot-package',{headers:{'x-owner':'yes'}})).status,200)
  assert.equal((await app.request('/api/bot-package/review',{method:'POST'})).status,404)
  assert.equal((await app.request('/api/bot-package/reviews/web:owner')).status,404)
})

test('source traversal, symlinks and top-level source execution fail closed',async t=>{
  const f=fixture(t)
  await assert.rejects(()=>f.tool.execute({action:'propose',folderId:'folder',directory:'../escape',summary:'Deploy'},f.context),/traversal/)
  symlinkSync(join(f.source,'BOT.md'),join(f.source,'linked'))
  await assert.rejects(()=>f.propose(),/symlinks/)
  assert.equal(f.asks,0)
})

test('fresh cross-BOT ownership validation runs inside publication exclusion, not before waiting for it',async t=>{
  const f=fixture(t)
  const firstQuestion=Promise.withResolvers<void>(),bothQuestions=Promise.withResolvers<void>()
  let questions=0,tail:Promise<unknown>=Promise.resolve(),inside=false
  f.onAsk(async()=>{if(++questions===1)firstQuestion.resolve();if(questions===2)bothQuestions.resolve();await bothQuestions.promise})
  f.options.publish=async<T>(_id:string,change:()=>Promise<T>)=>{
    const run=tail.then(async()=>{inside=true;try{return await change()}finally{inside=false}})
    tail=run.catch(()=>{});return run
  }
  let finalChecks=0
  f.options.validate=async source=>{
    const {parseBot}=await import('./sdk.ts'),candidate=parseBot(source)
    if(inside)finalChecks++
    const other=f.runtime.definitions().find(item=>item.bot.id!==candidate.id)
    if(other)throw new Error('conversation already owned')
  }
  const first=f.propose()
  await firstQuestion.promise
  writeFileSync(join(f.source,'BOT.md'),files()['BOT.md']!.replace('id: support','id: beta'))
  f.options.canAuthor = id => id === 'web:owner' || id === 'web:second'
  const second=f.tool.execute({action:'propose',folderId:'folder',summary:'Deploy independent BOT'}, {...f.context,sessionId:'web:second'})
  const results=await Promise.allSettled([first,second])
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
  assert.equal(finalChecks,2)
  assert.equal(f.deployments.list().length,1)
})

test('top-level authority ceiling changes are disclosed even when binding permissions do not change',async t=>{
  const f=fixture(t),first=JSON.parse(await f.propose() as string).deployment.revision
  const config=JSON.parse(files()['bot.json']!)
  const folder=randomUUID(),domain=randomUUID()
  config.sourceFolders=[folder];config.readDomains=[domain];config.discordHistory={guildId:'100',channelIds:['200'],threads:'public-active',preEpoch:true}
  writeFileSync(join(f.source,'bot.json'),JSON.stringify(config))
  f.onAsk(args=>{assert.match(String(args.question),/权限范围新增 3 项/);const facts=[...f.options.pending.values()][0] as any;const permissions=facts.addedPermissions.join('; ');assert.match(permissions,/BOT source-folder ceiling/);assert(permissions.includes(folder));assert(permissions.includes(domain));assert.match(permissions,/preEpoch=true/)})
  await f.propose(first)
})

test('removed Discord binding IDs are invalidated together with retained/new IDs',async t=>{
  const f=fixture(t),a=randomUUID(),b=randomUUID()
  const binding=(id:string,channelId:string)=>({platform:'discord',id,botInstanceId:'discord',botUserId:'900',target:{kind:'channel',guildId:'100',channelId},enabled:true,trigger:'mention',participants:{everyone:false,userIds:['500'],roleIds:[]},tools:[],readDomains:[],inheritThreads:false,manage:false})
  const config={mode:'service',allowedModules:[],tools:[],bindings:[binding(a,'201'),binding(b,'202')]}
  writeFileSync(join(f.source,'bot.json'),JSON.stringify(config))
  const notifications:string[][]=[];f.options.changed=ids=>{notifications.push(ids)}
  const first=JSON.parse(await f.propose() as string).deployment.revision
  config.bindings=[binding(b,'202')]
  writeFileSync(join(f.source,'bot.json'),JSON.stringify(config))
  await f.propose(first)
  assert.deepEqual(notifications.at(-1)!.sort(),[a,b].sort())
})

test('personal preparation confirms exact hash and role without replacing live owner authority',async t=>{
  const f=fixture(t),connection=randomUUID()
  const config={mode:'personal',connection,agent:'general',allowedModules:[],tools:[],bindings:[]}
  writeFileSync(join(f.source,'bot.json'),JSON.stringify(config))
  let confirmedHash=''
  f.onAsk(args=>{
    const facts=[...f.options.pending.values()][0] as Record<string,unknown>
    confirmedHash=String(facts.exactContent)
    assert.equal(facts.mode,'personal');assert.equal(facts.agent,'general');assert.equal(facts.connection,connection)
    assert.match(String(args.question),/已验证身份和所选角色的正常工具/)
    writeFileSync(join(f.source,'BOT.md'),'unapproved edit')
  })
  const result=JSON.parse(await f.propose() as string)
  assert.equal(result.deployment.revision,confirmedHash)
  assert.equal(f.runtime.personal(connection)?.prompt,'Frozen instructions')
  assert.equal(f.runtime.resolve({platform:'qq',botInstanceId:connection,conversationId:'dm'}),undefined)
})


test('BOT trigger changes use the existing owner confirmation and disclose the connection compatibility boundary', async t => {
  const f = fixture(t)
  const first = JSON.parse(await f.propose() as string)
  const config = JSON.parse(files()['bot.json']!)
  config.bindings[0].trigger = 'all'
  writeFileSync(join(f.source, 'bot.json'), JSON.stringify(config))
  f.onAsk(args => {
    assert.match(String(args.question), /会处理所有获准接收的消息/)
    assert.match(String(args.question), /权限范围新增 1 项、移除 1 项/)
    const facts = [...f.options.pending.values()][0] as any
    assert.ok(facts.addedPermissions.some((value: string) => value.endsWith('trigger all')))
    assert.ok(facts.removedPermissions.some((value: string) => value.endsWith('trigger mention')))
  })
  await f.propose(first.deployment.revision)
  const status = JSON.parse(await f.tool.execute({ action: 'status' }, f.context) as string)
  assert.match(status.receivePolicy, /Connection triggerMode is not inherited/)
})


test('invalid legacy binding skills quarantine only that BOT without weakening SDK publication', async t => {
  const f = fixture(t)
  const { parseBot } = await import('./sdk.ts')
  const invalid = files()
  const config = JSON.parse(invalid['bot.json'])
  config.skills = [{ name: 'xmcl-issues', content: 'Frozen issue instructions' }]
  config.bindings[0].skills = ['xmcl-issues']
  invalid['bot.json'] = JSON.stringify(config)
  assert.throws(() => parseBot(invalid), /Unrecognized key.*skills/)
  // Model an existing package published before the current strict schema.
  await f.deployments.deploy({ id: 'support', source: { folderId: 'folder', directory: '.' }, ...f.deployments.freeze(invalid) })
  const valid = files('Healthy BOT')
  valid['BOT.md'] = valid['BOT.md'].replace('id: support', 'id: healthy')
  const validConfig = JSON.parse(valid['bot.json'])
  validConfig.bindings[0].conversationId = 'group:healthy'
  valid['bot.json'] = JSON.stringify(validConfig)
  await f.deployments.deploy({ id: 'healthy', source: { folderId: 'folder', directory: '.' }, ...f.deployments.freeze(valid) })
  const messages: string[] = []
  t.mock.method(console, 'error', (message: string) => messages.push(message))
  assert.deepEqual(f.runtime.discord(), { agents: [], bindings: [] })
  assert.deepEqual(f.runtime.definitions().map(({ bot }) => bot.id), ['healthy'])
  assert.equal(f.runtime.definition('support'), undefined)
  assert.throws(() => f.runtime.personal(randomUUID()), /prevents personal role fallback/)
  assert.equal(f.runtime.isManaged({ platform: 'qq', botInstanceId: 'bot', conversationId: 'group:one' }), true)
  assert.equal(f.runtime.resolve({ platform: 'qq', botInstanceId: 'bot', conversationId: 'group:one' }), undefined)
  assert.equal(f.runtime.resolve({ platform: 'qq', botInstanceId: 'bot', conversationId: 'group:healthy' })?.agent.prompt, 'Healthy BOT')
  assert.equal(f.runtime.inputListeners().length, 1)
  assert.equal(messages.length, 1)
  assert.match(messages[0]!, /Deployment quarantined.*Project p/)
  assert.match(f.runtime.diagnostics()[0]!.reason, /bindings.0.*skills/)
  const revision = f.deployments.read('support')!.deployment.revision
  await assert.rejects(() => f.runtime.execute('support', revision, [], 'anything', {}, f.context), /Unrecognized key.*skills/)
  assert.equal(f.deployments.read('support')!.files['bot.json'], invalid['bot.json'])
  delete config.bindings[0].skills
  invalid['bot.json'] = JSON.stringify(config)
  await f.deployments.deploy({ id: 'support', source: { folderId: 'folder', directory: '.' }, ...f.deployments.freeze(invalid), expectedRevision: revision })
  assert.equal(f.runtime.definition('support')?.skills?.[0]?.name, 'xmcl-issues')
  assert.deepEqual(f.runtime.diagnostics(), [])
})


test('second deployment read integrity failure or disappearance remains fatal', async t => {
  const f = fixture(t)
  await f.propose()
  const read = f.deployments.read.bind(f.deployments)
  let count = 0
  const mock = t.mock.method(f.deployments, 'read', (id: string) => {
    if (++count === 2) throw new Error('Deployment integrity failure')
    return read(id)
  })
  assert.throws(() => f.runtime.definitions(), /Deployment integrity failure/)
  assert.deepEqual(f.runtime.diagnostics(), [])
  count = 0
  mock.mock.mockImplementation((id: string) => ++count === 2 ? undefined : read(id))
  assert.throws(() => f.runtime.definitions(), /deployment disappeared/)
  assert.deepEqual(f.runtime.diagnostics(), [])
})


test('format-only upgrade still needs exact owner approval and preserves frozen semantics/previous revision', async t => {
  const f = fixture(t)
  const { migrateBotFrontmatter } = await import('./format.ts')
  const { parseBot } = await import('./sdk.ts')
  const first = JSON.parse(await f.propose() as string).deployment.revision
  const before = f.deployments.read('support')!
  const converted = migrateBotFrontmatter(before.files)
  for (const [path, text] of Object.entries(converted)) writeFileSync(join(f.source, path), text)
  // No special migration endpoint, authorization exemption or inferred approval.
  f.options.ask.execute = async () => JSON.stringify({ option: '部署', answeredBy: 'agent' })
  assert.equal(JSON.parse(await f.propose(first) as string).status, 'cancelled')
  assert.equal(f.deployments.read('support')!.deployment.revision, first)
  f.options.ask.execute = async args => {
    assert.match(String(args.question), /权限范围新增 0 项/)
    assert.match(String(args.question), /移除 0 项/)
    f.save('Unapproved later edit')
    return JSON.stringify({ option: '部署', answeredBy: 'user' })
  }
  const next = JSON.parse(await f.propose(first) as string)
  assert.equal(next.status, 'deployed')
  assert.equal(next.deployment.previous, first)
  assert.deepEqual({ ...f.deployments.read('support')!.files }, converted)
  assert.deepEqual(parseBot(f.deployments.read('support')!.files), parseBot(before.files))
  await f.deployments.restorePrevious('support') // Storage primitive exercised only in this disposable fixture.
  assert.equal(f.deployments.read('support')!.deployment.revision, first)
})


async function legacySkillsRepair(t: TestContext, invalidPatch?: (config: any) => void) {
  const f = fixture(t)
  const { migrateBotFrontmatter } = await import('./format.ts')
  const legacy = files()
  const config = JSON.parse(legacy['bot.json'])
  config.skills = [{ name: 'issues', content: 'Unchanged issue instructions' }]
  config.allowedModules = ['@shadow/issues']
  config.bindings[0].skills = ['issues']
  config.bindings[0].tools = ['read']
  config.bindings[0].allowFrom = ['owner']
  config.bindings[0].readFolders = ['approved-folder']
  config.bindings[0].grants = [{ id: 'issues', kind: 'http', origin: 'https://api.example.com', routes: [{ method: 'GET', path: '/issues/*' }] }]
  const repaired = structuredClone(config)
  delete repaired.bindings[0].skills
  const candidate = migrateBotFrontmatter({ ...legacy, 'bot.json': JSON.stringify(repaired) })
  invalidPatch?.(config)
  legacy['bot.json'] = JSON.stringify(config)
  const initial = await f.deployments.deploy({ id: 'support', source: { folderId: 'folder', directory: '' }, ...f.deployments.freeze(legacy) })
  for (const [path, text] of Object.entries(candidate)) writeFileSync(join(f.source, path), text)
  return { f, candidate, legacy, initial }
}

test('owner proposal narrowly repairs retired selectors with complete permissions, invalid-state and restoration disclosure', async t => {
  const { f, candidate, legacy, initial } = await legacySkillsRepair(t)
  f.onAsk(args => {
    const question = String(args.question)
    assert.match(question, /旧版本目前无法运行/)
    assert.match(question, /权限范围新增 \d+ 项、移除 \d+ 项/)
    assert.match(question, /恢复已授权的消息接收和处理/)
    assert.doesNotMatch(question, /hash|revision|checksum|binding\.skills|Channels|Agent summary/)
    assert.ok(!question.includes(initial.revision))
    assert.ok(!question.includes(f.deployments.freeze(candidate).revision))
    const pending = [...f.options.pending.values()][0] as any
    for (const fact of ['@shadow/issues', 'tool read', 'allowed senders owner', 'folder approved-folder', 'GET https://api.example.com/issues/*', 'input subscription']) assert.ok(pending.candidatePermissions.some((value: string) => value.includes(fact)), fact)
    assert.equal(pending.expectedRevision, initial.revision)
    assert.equal(pending.exactContent, f.deployments.freeze(candidate).revision)
    assert.equal(pending.repair.activeInvalid, true)
    assert.deepEqual(pending.repair.removedBindingSkills, [{ index: 0, names: ['issues'] }])
    assert.deepEqual(f.deployments.read('support')!.files['bot.json'], legacy['bot.json'], 'audit baseline never rewrites active')
  })
  const result = JSON.parse(await f.propose(initial.revision) as string)
  assert.equal(f.asks, 1)
  assert.equal(result.status, 'deployed')
  assert.equal(result.deployment.previous, initial.revision)
  assert.deepEqual({ ...f.deployments.read('support')!.files }, candidate)
  assert.deepEqual(f.runtime.resolve({ platform: 'qq', botInstanceId: 'bot', conversationId: 'group:one' })?.skillPrompts, [{ name: 'issues', content: 'Unchanged issue instructions' }])
})

test('cancelled selector repair preserves exact active bytes and post-confirmation live validation can still deny', async t => {
  const { f, legacy, initial } = await legacySkillsRepair(t)
  f.options.ask.execute = async () => JSON.stringify({ option: '取消', answeredBy: 'user' })
  assert.equal(JSON.parse(await f.propose(initial.revision) as string).status, 'cancelled')
  assert.deepEqual({ ...f.deployments.read('support')!.files }, legacy)
  assert.equal(f.options.pending.size, 0)
  f.options.ask.execute = async () => { f.fail(); return JSON.stringify({ option: '部署', answeredBy: 'user' }) }
  await assert.rejects(() => f.propose(initial.revision), /live authority changed/)
  assert.equal(f.deployments.read('support')!.deployment.revision, initial.revision)
  assert.deepEqual({ ...f.deployments.read('support')!.files }, legacy)
})

test('selector repair does not accept other invalid active packages, malformed selectors or missing top-level prompts', async t => {
  for (const patch of [
    (config: any) => { config.unknown = true },
    (config: any) => { config.bindings[0].unknown = true },
    (config: any) => { config.bindings[0].skills = 'issues' },
    (config: any) => { config.bindings[0].skills = ['missing-prompt'] },
    (config: any) => { config.temperature = 100 },
  ]) {
    const { f, initial, legacy } = await legacySkillsRepair(t, patch)
    await assert.rejects(() => f.propose(initial.revision))
    assert.equal(f.asks, 0)
    assert.equal(f.options.pending.size, 0)
    assert.deepEqual({ ...f.deployments.read('support')!.files }, legacy)
  }
})


test('large repair uses real AskTool and exposes complete same-revision details in the existing owner UI before cancellation', async t => {
  const f = fixture(t)
  const legacy = files(), config = JSON.parse(legacy['bot.json'])
  config.skills = Array.from({ length: 32 }, (_, i) => ({ name: `skill-${i}`, content: 'Frozen shared instructions' }))
  config.allowedModules = Array.from({ length: 31 }, (_, i) => `@shadow/module-${i}-${'m'.repeat(100)}`)
  const toolNames = Array.from({ length: 64 }, (_, i) => `tool-${i}-${'t'.repeat(100)}`)
  config.tools = toolNames.map(name => ({ name, description: 'Synthetic tool', parameters: { type: 'object', properties: {} }, module: 'tools.ts', imports: config.allowedModules }))
  config.bindings = Array.from({ length: 12 }, (_, i) => ({
    platform: i % 2 ? 'feishu' : 'qq', botInstanceId: 'bot', conversationId: `group:${i}`,
    tools: toolNames, skills: config.skills.map((skill: { name: string }) => skill.name), allowFrom: ['owner'],
    grants: [{ id: 'api', kind: 'http', origin: 'https://api.example.com',
      routes: Array.from({ length: 8 }, (_, j) => ({ method: 'GET', path: `/issues/${i}/${j}/${'p'.repeat(128)}`, bodySchema: { type: 'object', properties: { public: { type: 'boolean' } } } })),
      credential: { secretRef: 'private-ref-sentinel', header: 'Authorization', prefix: 'private-header-value-sentinel' } }],
  }))
  const oldFiles = { ...legacy, 'bot.json': JSON.stringify(config), 'tools.ts': 'export const unused = true' }
  const initial = await f.deployments.deploy({ id: 'support', source: { folderId: 'folder', directory: '' }, ...f.deployments.freeze(oldFiles) })
  for (const binding of config.bindings) { delete binding.skills; binding.trigger = 'all' }
  const candidate = { ...oldFiles, 'bot.json': JSON.stringify(config) }, revision = f.deployments.freeze(candidate).revision
  for (const [path, text] of Object.entries(candidate)) writeFileSync(join(f.source, path), text)
  const app = new Hono()
  botPackagePlugin(f.options, request => request.headers.get('x-owner') === 'yes')(app)
  let owner = true
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo) => {
    assert.equal(new URL(String(url)).pathname, '/api/bot-package')
    return app.request('/api/bot-package', { headers: owner ? { 'x-owner': 'yes' } : {} })
  })
  // The settings card is already open before the question. The named Refresh
  // control must fetch pending facts while ask is waiting, not after it settles.
  const view = mountBotUi(t, 'BotPackage.vue', { apiBase: 'http://localhost', projectId: 'p', active: true })
  await settleBotUi()
  assert.equal(view.nodes().filter(node => node.tag === 'pre').length, 0)
  f.onAsk(async args => {
    const question = parseYieldQuestion({ ...args, defaultOption: args.default_option })
    assert.ok(question.question.length < MAX_YIELD_QUESTION_LENGTH)
    t.diagnostic(`Large repair question: ${question.question.length}/${MAX_YIELD_QUESTION_LENGTH} characters`)
    assert.match(question.question, /旧版本目前无法运行/)
    assert.match(question.question, /恢复已授权的消息接收和处理/)
    assert.ok(question.question.includes('s'.repeat(800)), 'full user summary retained')
    assert.ok(!question.question.includes(revision)); assert.ok(!question.question.includes(initial.revision))
    assert.deepEqual(question.options, ['部署', '取消'])
    assert.doesNotMatch(question.question, /hash|revision|checksum|binding\.skills|Channels|Agent summary/)
    assert.equal(question.defaultOption, '取消')
    assert.equal((await app.request('/api/bot-package')).status, 401)
    const response = await app.request('/api/bot-package', { headers: { 'x-owner': 'yes' } })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const data = await response.json(), pending = data.pending[0], facts = pending.facts
    assert.equal(pending.revision, revision); assert.equal(facts.exactContent, revision)
    assert.equal(facts.expectedRevision, initial.revision)
    assert.equal(facts.affected.length, 12)
    assert.equal(facts.addedPermissions.filter((value: string) => value.endsWith('trigger all')).length, 12)
    assert.equal(facts.removedPermissions.filter((value: string) => value.endsWith('trigger mention')).length, 12)
    assert.ok(JSON.stringify(facts.candidatePermissions).length > 100_000)
    assert.deepEqual(facts.repair.candidatePermissions, facts.candidatePermissions)
    assert.equal(facts.repair.removedBindingSkills.length, 12)
    assert.equal(facts.repair.removedBindingSkills[11].names.length, 32)
    const grant = facts.bindings[11].grants[0]
    assert.deepEqual(grant.credential, { configured: true })
    assert.deepEqual(grant.routes, config.bindings[11].grants[0].routes)
    assert.equal(grant.origin, 'https://api.example.com')
    assert.doesNotMatch(JSON.stringify(data), /private-ref-sentinel|private-header-value-sentinel|secretRef|Authorization/)
    await view.click('Refresh status')
    const detail = view.nodes().find(node => node.tag === 'details' && node.children.some(child => child.tag === 'pre'))
    assert(detail, 'expandable pending details are rendered, not only API data')
    assert.ok(detail.children.some(child => child.tag === 'summary'))
    const displayed = JSON.parse(detail.children.find(child => child.tag === 'pre')!.text)
    assert.deepEqual(displayed, facts, 'the existing details card renders every complete fact without truncation')
    assert.ok(view.text().includes(revision))
    assert.equal(f.deployments.read('support')!.deployment.revision, initial.revision)
    // Later source edits cannot change either the confirmation hash or its facts.
    f.save('Unapproved later edit')
    assert.equal((await (await app.request('/api/bot-package', { headers: { 'x-owner': 'yes' } })).json()).pending[0].revision, revision)
    return '取消'
  })
  const result = JSON.parse(await f.tool.execute({ action: 'propose', folderId: 'folder', expectedRevision: initial.revision, summary: 's'.repeat(800) }, f.context) as string)
  assert.equal(result.status, 'cancelled'); assert.equal(f.asks, 1)
  assert.deepEqual({ ...f.deployments.read('support')!.files }, oldFiles)
  assert.equal(f.options.pending.size, 0)
  await view.click('Refresh status')
  assert.equal(view.nodes().filter(node => node.tag === 'pre').length, 0)
  owner = false
  await view.click('Refresh status')
  assert.match(view.text(), /BOT deployment status unavailable/)
})

test('1000 old and 1000 new normal bindings keep maximum summary within the real decision limit and both hashes in backend facts', async t => {
  const f = fixture(t), source = files(), config = JSON.parse(source['bot.json'])
  const bindings = (prefix: string) => Array.from({ length: 1000 }, (_, i) => ({ platform: 'qq', botInstanceId: 'bot', conversationId: `${prefix}-${i}-${'c'.repeat(120)}`, tools: ['read'] }))
  config.bindings = bindings('old')
  const before = { ...source, 'bot.json': JSON.stringify(config) }
  const initial = await f.deployments.deploy({ id: 'support', source: { folderId: 'folder', directory: '' }, ...f.deployments.freeze(before) })
  config.bindings = bindings('new')
  const candidate = { ...source, 'bot.json': JSON.stringify(config) }, hash = f.deployments.freeze(candidate).revision
  for (const [path, text] of Object.entries(candidate)) writeFileSync(join(f.source, path), text)
  f.onAsk(args => {
    assert.ok(String(args.question).length <= MAX_YIELD_QUESTION_LENGTH)
    t.diagnostic(`2000-location question: ${String(args.question).length}/${MAX_YIELD_QUESTION_LENGTH} characters`)
    assert.match(String(args.question), /影响 2000 个消息接收位置，接收配置由 1000 项变为 1000 项/)
    assert.match(String(args.question), /权限范围新增 5000 项、移除 5000 项/)
    assert.ok(!String(args.question).includes(initial.revision)); assert.ok(!String(args.question).includes(hash))
    const facts = f.options.pending.get(hash) as any
    assert.equal(facts.expectedRevision, initial.revision)
    assert.equal(facts.exactContent, hash)
    assert.equal(facts.affected.length, 2000)
    assert.equal(facts.addedPermissions.length, 5000)
    assert.equal(facts.removedPermissions.length, 5000)
    assert.equal(facts.candidatePermissions.length, 5001)
    assert.equal(facts.repair, undefined)
  })
  const result = JSON.parse(await f.tool.execute({ action: 'propose', folderId: 'folder', expectedRevision: initial.revision, summary: 's'.repeat(800) }, f.context) as string)
  assert.equal(result.status, 'deployed'); assert.equal(result.deployment.revision, hash)
  assert.deepEqual({ ...f.deployments.read('support')!.files }, candidate)
  assert.equal(f.options.pending.size, 0)
})

test('real owner cancellation, validation failure, and revoked author authority leave the exact invalid active revision intact', async t => {
  const { f, legacy, initial } = await legacySkillsRepair(t)
  f.onAsk(() => '取消')
  assert.equal(JSON.parse(await f.propose(initial.revision) as string).status, 'cancelled')
  f.onAsk(() => { throw new Error('Synthetic question delivery failure') })
  await assert.rejects(() => f.propose(initial.revision), /Yield delivery failed/)
  assert.equal(f.options.pending.size, 0)
  f.onAsk(() => { f.fail() })
  await assert.rejects(() => f.propose(initial.revision), /live authority changed/)
  f.options.validate = async () => {}
  f.onAsk(() => { f.options.canAuthor = () => false })
  await assert.rejects(() => f.propose(initial.revision), /owner authority changed/)
  f.options.canAuthor = () => true
  f.onAsk(() => {})
  // Revoke while the second validation is in flight, not merely before it.
  let checks = 0
  f.options.validate = async () => { if (++checks === 2) f.options.canAuthor = () => false }
  await assert.rejects(() => f.propose(initial.revision), /owner authority changed/)
  assert.deepEqual({ ...f.deployments.read('support')!.files }, legacy)
  assert.equal(f.deployments.read('support')!.deployment.revision, initial.revision)
  assert.equal(f.options.pending.size, 0)
})


test('duplicate candidate cannot clear the original pending exact details while another owner is deciding', async t => {
  const f = fixture(t), opened = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.options.canAuthor = id => id === 'web:owner' || id === 'web:second'
  f.onAsk(async () => { opened.resolve(); await release.promise; return '取消' })
  const waiting = f.propose()
  await opened.promise
  try {
    const [revision, facts] = [...f.options.pending][0]!
    await assert.rejects(() => f.tool.execute({ action: 'propose', folderId: 'folder', summary: 'Duplicate proposal' }, { ...f.context, sessionId: 'web:second' }), /already has a pending owner confirmation/)
    assert.equal(f.options.pending.get(revision), facts)
    assert.equal(f.asks, 1)
  } finally { release.resolve() }
  assert.equal(JSON.parse(await waiting as string).status, 'cancelled')
  assert.equal(f.options.pending.size, 0)
  assert.equal(f.deployments.read('support'), undefined)
})


test('deployment confirmation uses only Chinese system text and exact Chinese approval options', async t => {
  const f = fixture(t)
  f.onAsk(args => {
    assert.equal(args.question, '更新客服回复说明\n影响 1 个消息接收位置，接收配置由 0 项变为 1 项。\n权限范围新增 5 项、移除 0 项。\n是否部署此版本？')
    assert.deepEqual(args.options, ['部署', '取消'])
    assert.equal(args.default_option, '取消')
    assert.doesNotMatch(String(args.question), /[a-zA-Z]|[a-f0-9]{64}/)
    return '取消'
  })
  const result = JSON.parse(await f.tool.execute({ action: 'propose', folderId: 'folder', summary: '更新客服回复说明' }, f.context) as string)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.activeUnchanged, true)
  assert.equal(f.deployments.read('support'), undefined)
})
