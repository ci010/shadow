import assert from 'node:assert/strict'
import { assertPersonalOutput } from './personal-output.ts'
import type { OutboundMessage } from '../bus/events.ts'
import { test } from 'node:test'
import { join } from 'node:path'
import { BotDeployments } from './deployments.ts'
import { parseBot } from './sdk.ts'
import { migrateBotFrontmatter } from './format.ts'
import { DirectoryBots } from './runtime.ts'
import { projectInputListeners } from './input.ts'
import { botConversationPolicies } from '../channels/bot-policies.ts'
import { BotInstanceStore } from '../channels/bot-store.ts'
import { channelSessionId, deriveSessionId } from '../bus/events.ts'
import { channelInputFixture } from '../testing/channel-input.ts'
import { Bus } from '../bus/bus.ts'
import { SessionManager } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { IdentityManager } from '../agent/identity.ts'
import { EventService } from '../events/service.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { HandoffManager } from '../sessions/handoff/manager.ts'
import { Tools } from '../tools/registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ConversationPolicies } from './conversation-policy.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { channelMessageInput, inputAdmin } from '../sessions/input.ts'

const files = (extra = {}) => ({
  'BOT.md': '---\nid: shadow\nconfig: bot.json\n---\nScoped personal instructions.',
  'bot.json': JSON.stringify({mode:'personal',agent:'general',allowedModules:[],tools:[],bindings:[],...extra}),
})
test('personal discriminator denies package-defined authority and service escalation', () => {
  assert.equal(parseBot(files()).mode,'personal')
  for(const extra of [{connection:'00000000-0000-4000-8000-000000000001'},{admin:true},{verifiedOwner:{senderId:'attacker'}},{tools:[{name:'read'}]},{agent:undefined},{mode:'service'},{mode:undefined},{readDomains:[]}]) assert.throws(()=>parseBot(files(extra)))
})
test('personal deployment uses real normal SessionManager prompt/tools, exact inbox without owner authority; service stays restricted', async () => {
  await withTempWorkspace(async workspace => {
    const projectId='p', store=new BotInstanceStore({projectId,path:join(workspace,'bots.json')})
    const bot=store.create('qq','Shared transport',{appId:'synthetic',secret:'synthetic',enabled:true})
    const deployments=new BotDeployments({directory:join(workspace,'deployments'),projectId,runGit:async()=>{throw new Error('No git')}})
    const frozen=deployments.freeze(migrateBotFrontmatter(files({agent:'personal-role',bindings:[{platform:'qq',botInstanceId:bot.id,conversationId:'dm',tools:[]}]})))
    await deployments.deploy({id:'shadow',source:{folderId:'f',directory:'shadow'},files:frozen.files,revision:frozen.revision,signal:new AbortController().signal})
    const runtime=new DirectoryBots(deployments)
    let execution = { enabled: true, generation: '0' }
    runtime.setExecutionPolicy(() => execution)
    let publishing = false
    const existing={assertInputAvailable: () => { if (publishing) throw new Error('Publication in progress') }, managed:()=>true,resolve:()=>undefined,authorize:()=>{},tools:()=>{throw new Error('Restricted service tools')},prompt:()=>{throw new Error('Restricted prompt')}} as unknown as ConversationPolicies
    const policies=botConversationPolicies(store,existing,runtime)
    const id=channelSessionId({projectId,botInstanceId:bot.id,platform:'qq',conversationId:'dm'})
    const bus=new Bus(), agents=new AgentTypesManager(workspace);await agents.load()
    agents.setWorkspaceType('personal-role',{...agents.resolve('general')!,name:'personal-role',source:'workspace',model:'role-model',prompt:'Custom role prompt'})
    const outbound: OutboundMessage[] = []
    bus.on('message.outbound', message => { outbound.push(message) })
    const tools=new Tools(workspace)
    tools.register({name:'read',description:'ordinary role tool',parameters:{type:'object',properties:{}},execute:async()=>''})
    let preloadGate: (() => Promise<void>) | undefined
    tools.register({name:'invoke_tool',description:'fixture invoke',parameters:{type:'object',properties:{}},execute:async()=>''})
    const importer = {name:'import_tool',description:'fixture import',parameters:{type:'object' as const,properties:{}},execute:async()=>'',
      importSource: async () => { await preloadGate?.(); return 'fixture loaded' }}
    tools.register(importer)
    const context=new ContextBuilder(workspace)
    const admins:boolean[]=[]
    let prepareGate: (() => Promise<void>) | undefined
    context.register({name:'role',getPromptSection:async ctx=>{admins.push(ctx.admin===true);await prepareGate?.();return [ctx.agent.prompt, ctx.personalBotPrompt].filter(Boolean).join('\n')}})
    const calls: Array<{prompt:string;tools:string[];model:string}> = []
    const provider:LLMProvider={name:'fixture',listModels:()=>[],chat:async(messages,definitions,options)=>{calls.push({model:options.model,prompt:String(messages[0]?.content),tools:definitions?.map(t=>t.function.name)??[]});return {content:'done',toolCalls:[]}}}
    const sessionStore=new JsonlSessionStore(join(workspace,'sessions'))
    const events=new EventService(workspace,bus,async()=>{throw new Error('unused')})
    const backgroundTasks=new BackgroundTaskManager(bus,events)
    const handoff=new HandoffManager(provider,128000,{autoHandoff:false},workspace,sessionStore)
    const sessions=new SessionManager({projectId,workspace,store:sessionStore,bus,provider,agentTypes:agents,context,tools,events,backgroundTasks,identity:new IdentityManager(workspace),handoffManager:handoff,conversationPolicies:policies,getLlmRuntimeConfig:()=>({model:'fixture',contextWindow:128000,temperature:0})})
    try {
      await sessions.start()
      const address={projectId,botInstanceId:bot.id,platform:'qq',conversationId:'dm'} as const
      const message={channelInputGuard:()=>{},channel:'qq',chatId:'dm',channelAddress:address,senderId:'any-inbox-sender',isGroup:false,admin:true,content:'hello',messageId:'m',timestamp:new Date().toISOString()}
      assert.equal(policies.managed(id),false)
      publishing = true
      assert.throws(() => policies.authorize(id, channelMessageInput(message)), /Publication in progress/)
      publishing = false
      assert.equal(inputAdmin(id, channelMessageInput(message)), false, 'a scoped sender cannot elevate by setting the admin hint')
      const personal = { personalAgent: 'personal-role' }
      assert.equal(sessions.inspectBotContext(id, personal), undefined, 'a bound inbox is not an active runtime context')
      const finished=Promise.withResolvers<void>()
      bus.on('session.turn.finished',()=>finished.resolve())
      const inputs = channelInputFixture({ projectId, sessions, bots: store, directory: runtime,
        receive: message => sessions.deliver(deriveSessionId(message), channelMessageInput(message)) })
      assert.deepEqual(projectInputListeners(projectId, { sessions, bots: store, directory: runtime }).filter(listener => listener.source.id === bot.id), [
        { source: { type: 'qq', id: bot.id }, kind: 'message', topic: 'dm', target: { kind: 'bot', id: 'shadow' } },
      ])
      await sessions.recordPassiveChannel({version:1,projectId,connectionId:bot.id,platform:'qq',conversationId:'dm',kind:'direct'},message,()=>{})
      await inputs.receive(message)
      await finished.promise
      assert.match(calls[0]!.prompt,/Scoped personal instructions/)
      assert.match(calls[0]!.prompt,/Custom role prompt/)
      assert.equal(calls[0]!.model,'role-model')
      assert.ok(calls[0]!.tools.includes('read'))
      assert.ok(admins.length > 0)
      assert.ok(admins.every(admin => !admin), 'channel-derived role must not acquire owner/admin authority')
      assert.equal(sessions.getSessionState(id)?.agentType,'personal-role')
      const runtimeContext = sessions.inspectBotContext(id, personal)
      assert.equal(runtimeContext?.source, 'active-history')
      assert.equal(runtimeContext.systemPrompt, calls[0]!.prompt)
      assert.deepEqual(runtimeContext.tools.map(tool => tool.name), calls[0]!.tools)
      assert.equal(sessions.inspectBotContext(id, { personalAgent: 'general' }), undefined)
      const output = outbound.find(message => message.event === 'response' && message.done && message.content === 'done')
      assert.ok(output, 'actual normal SessionManager must emit a stamped Personal response')
      assert.doesNotThrow(() => assertPersonalOutput(output))
      await (sessions as any).notifyInput({ sessionId: id, id: 'synthetic-input', recipient: { kind: 'user' }, question: 'Synthetic question' }, {})
      assert.doesNotThrow(() => assertPersonalOutput(outbound.at(-1)!))
      await (sessions as any).notifyYieldUser({ sessionId: id, id: 'synthetic-decision', question: 'Synthetic decision', options: ['A', 'B'], defaultOption: 'A' })
      const notification = outbound.at(-1)!
      assert.doesNotThrow(() => assertPersonalOutput(notification))
      execution = { enabled: false, generation: '1' }
      assert.throws(() => assertPersonalOutput(output), /paused/)
      execution = { enabled: true, generation: '2' }
      assert.throws(() => assertPersonalOutput(output), /execution changed/, 'queued response keeps the original turn generation after ABA')
      assert.throws(() => assertPersonalOutput(notification), /execution changed/)
      await assert.rejects((sessions as any).notifyInput({ sessionId: id, id: 'stale-input', recipient: { kind: 'user' }, question: 'Stale question' }, {}), /execution changed/)
      const second = Promise.withResolvers<void>()
      bus.on('session.turn.finished', () => second.resolve())
      await inputs.receive({ ...message, messageId: 'second' })
      await second.promise
      const fresh = outbound.filter(message => message.event === 'response' && message.done && message.content === 'done').at(-1)!
      assert.notEqual(fresh, output)
      assert.doesNotThrow(() => assertPersonalOutput(fresh))
      assert.ok(calls[1]!.tools.includes('read'), 'fencing must preserve ordinary Project role tools')
      assert.throws(() => assertPersonalOutput(output), /execution changed/)
      const preparing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
      prepareGate = async () => { preparing.resolve(); await release.promise }
      // Exercise the real asynchronous prompt/history preparation boundary. A
      // descriptor captured before the await must not take a new generation.
      const prepared = (sessions as any).prepareSessionContext(channelMessageInput(message), id) as Promise<unknown>
      const rejected = assert.rejects(prepared, /execution changed/)
      await preparing.promise
      execution = { enabled: true, generation: '4' }
      release.resolve()
      await rejected
      prepareGate = undefined
      const preloading = Promise.withResolvers<void>(), finishPreload = Promise.withResolvers<void>()
      preloadGate = async () => { preloading.resolve(); await finishPreload.promise }
      const state = sessions.getSessionState(id)!
      await (sessions as any).saveState(id, { ...state, preloadTools: { 'fixture-preload': [] } })
      const preload = (sessions as any).prepareSessionContext(channelMessageInput(message), id) as Promise<unknown>
      const rejectedPreload = assert.rejects(preload, /execution changed/)
      await Promise.race([preloading.promise, preload.then(() => assert.fail('Expected asynchronous tool preload'))])
      execution = { enabled: true, generation: '5' }
      finishPreload.resolve()
      await rejectedPreload
      preloadGate = undefined
      assert.equal(calls.length, 2, 'changed preparation must never start another provider call')
      await assert.rejects(sessions.deliver(channelSessionId({...address,conversationId:'other-dm'}),channelMessageInput(message)),/assignment|required|source/i)
      await assert.rejects(sessions.deliver(channelSessionId({...address,platform:'feishu'}),channelMessageInput(message)),/platform mismatch/)
      const cross=channelSessionId({...address,projectId:'other'})
      await assert.rejects(sessions.deliver(cross,channelMessageInput(message)),/Project mismatch/)
      store.update(bot.id,{config:{enabled:false}})
      assert.throws(() => assertPersonalOutput(fresh), /execution changed|disabled/)
      await assert.rejects(sessions.deliver(id,channelMessageInput(message)),/disabled/)
    } finally {await sessions.stop();await handoff.stop();await backgroundTasks.stop();await events.stop();bus.stopAll()}
  })
})
