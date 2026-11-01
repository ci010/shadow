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
  const context={projectId:'p',sessionId:'web:owner',physicalSessionId:'physical',channel:'web',inputSource:'user',admin:true,tools,signal:new AbortController().signal} as ExecutionContext
  let onAsk:(args:Record<string,unknown>)=>unknown=()=>undefined,fail=false,asks=0
  const ask:Tool<ToolResult>={name:'ask',description:'Ask',parameters:{type:'object',properties:{}},execute:async args=>{asks++;await onAsk(args);return JSON.stringify({option:(args.options as string[])[0],answeredBy:'user'})}}
  const options={pending:new Map<string,unknown>(),projectId:'p',deployments,runtime,folders:{acquireAccess:()=>()=>{},requireAvailable:async()=>({id:'folder',name:'source',path:source,createdAt:new Date().toISOString()}),list:()=>[]},ask,canAuthor:(id:string)=>id==='web:owner',validate:async(_files:Record<string,string>,_signal:AbortSignal)=>{if(fail)throw new Error('live authority changed')},publish:async<T>(_id:string,change:()=>Promise<T>)=>change(),changed:(_ids:string[])=>{}}
  const tool=botPackageTool(options)
  return {root,source,save,deployments,runtime,context,options,tool,get asks(){return asks},onAsk:(fn:typeof onAsk)=>{onAsk=fn},fail:()=>{fail=true},propose:(expectedRevision?:string)=>tool.execute({action:'propose',folderId:'folder',summary:'Update support instructions',...(expectedRevision?{expectedRevision}:{})},context)}
}

test('one native owner confirmation deploys exact frozen files, never later workspace edits',async t=>{
  const f=fixture(t)
  f.onAsk(args=>{assert.match(String(args.question),/Added permissions/);assert.equal(args.default_option,'Cancel deployment');f.save('Unapproved disk edit')})
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
  f.options.ask.execute=async()=>JSON.stringify({option:'Cancel deployment',answeredBy:'user'})
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
  const second=f.propose()
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
  f.onAsk(args=>{const question=String(args.question);assert.match(question,/BOT source-folder ceiling/);assert(question.includes(folder));assert(question.includes(domain));assert.match(question,/preEpoch=true/)})
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
    assert.match(String(args.question),/ordinary verified-owner tools/)
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
    assert.match(String(args.question), /Added permissions:.*trigger all/)
    assert.match(String(args.question), /Removed permissions:.*trigger mention/)
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
  f.options.ask.execute = async () => JSON.stringify({ option: 'Deploy support', answeredBy: 'agent' })
  assert.equal(JSON.parse(await f.propose(first) as string).status, 'cancelled')
  assert.equal(f.deployments.read('support')!.deployment.revision, first)
  f.options.ask.execute = async args => {
    assert.match(String(args.question), /Added permissions: none/)
    assert.match(String(args.question), /Removed permissions: none/)
    f.save('Unapproved later edit')
    return JSON.stringify({ option: 'Deploy support', answeredBy: 'user' })
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
    assert.match(question, /Active package is invalid/)
    assert.match(question, /bindings\[0\].skills=\["issues"\]/)
    assert.match(question, /restores a valid BOT definition and its enabled input subscriptions\/runtime/)
    assert.match(question, /Candidate permissions \(complete\)/)
    for (const fact of ['@shadow/issues', 'tool read', 'allowed senders owner', 'folder approved-folder', 'GET https://api.example.com/issues/*', 'input subscription']) assert.ok(question.includes(fact), fact)
    assert.ok(question.includes(initial.revision))
    assert.ok(question.includes(f.deployments.freeze(candidate).revision))
    const pending = [...f.options.pending.values()][0] as any
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
  f.options.ask.execute = async () => JSON.stringify({ option: 'Cancel deployment', answeredBy: 'user' })
  assert.equal(JSON.parse(await f.propose(initial.revision) as string).status, 'cancelled')
  assert.deepEqual({ ...f.deployments.read('support')!.files }, legacy)
  assert.equal(f.options.pending.size, 0)
  f.options.ask.execute = async () => { f.fail(); return JSON.stringify({ option: 'Deploy support', answeredBy: 'user' }) }
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
