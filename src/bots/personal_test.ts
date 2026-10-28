import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { BotDeployments } from './deployments.ts'
import { parseBot } from './sdk.ts'
import { DirectoryBots } from '../agent-authoring/bot-runtime.ts'
import { botConversationPolicies } from '../channels/bot-policies.ts'
import { BotInstanceStore } from '../channels/bot-store.ts'
import { channelSessionId } from '../bus/events.ts'
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
import type { ConversationPolicies } from '../agent-authoring/service.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { channelMessageInput } from '../sessions/input.ts'

const files = (connection: string, extra = {}) => ({
  'BOT.md': '---\nid: shadow\nconfig: bot.json\n---\nScoped personal instructions.',
  'bot.json': JSON.stringify({mode:'personal',connection,agent:'general',allowedModules:[],tools:[],bindings:[],...extra}),
})
test('personal discriminator denies package-defined authority and service escalation', () => {
  const connection='00000000-0000-4000-8000-000000000001'
  assert.equal(parseBot(files(connection)).mode,'personal')
  for(const extra of [{admin:true},{verifiedOwner:{senderId:'attacker'}},{tools:[{name:'read'}]},{agent:undefined},{mode:'service'},{mode:undefined},{readDomains:[]}]) assert.throws(()=>parseBot(files(connection,extra)))
})
test('personal deployment uses real normal SessionManager prompt/tools, live owner gate; service stays restricted', async () => {
  await withTempWorkspace(async workspace => {
    const projectId='p', store=new BotInstanceStore({projectId,path:join(workspace,'bots.json')})
    const bot=store.create('qq','Owner',{appId:'synthetic',secret:'synthetic',enabled:true},undefined,'personal')
    store.bindOwner(bot.id,'owner','dm')
    const deployments=new BotDeployments({directory:join(workspace,'deployments'),projectId,runGit:async()=>{throw new Error('No git')}})
    const frozen=deployments.freeze(files(bot.id,{agent:'personal-role'}))
    await deployments.deploy({id:'shadow',source:{folderId:'f',directory:'shadow'},files:frozen.files,revision:frozen.revision,signal:new AbortController().signal})
    const runtime=new DirectoryBots(deployments)
    const existing={managed:()=>true,resolve:()=>undefined,authorize:()=>{},tools:()=>{throw new Error('Restricted service tools')},prompt:()=>{throw new Error('Restricted prompt')}} as unknown as ConversationPolicies
    const policies=botConversationPolicies(store,existing,runtime)
    const id=channelSessionId({projectId,botInstanceId:bot.id,platform:'qq',conversationId:'dm'})
    const bus=new Bus(), agents=new AgentTypesManager(workspace);await agents.load()
    agents.setWorkspaceType('personal-role',{...agents.resolve('general')!,name:'personal-role',source:'workspace',model:'role-model',prompt:'Custom role prompt'})
    const tools=new Tools(workspace)
    tools.register({name:'read',description:'ordinary owner tool',parameters:{type:'object',properties:{}},execute:async()=>''})
    const context=new ContextBuilder(workspace)
    const admins:boolean[]=[]
    context.register({name:'role',getPromptSection:ctx=>{admins.push(ctx.admin===true);return ctx.agent.prompt}})
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
      const message={channel:'qq',chatId:'dm',channelAddress:address,senderId:'owner',isGroup:false,admin:true,content:'hello',messageId:'m',timestamp:new Date().toISOString()}
      assert.equal(policies.managed(id),false)
      const finished=Promise.withResolvers<void>()
      bus.on('session.turn.finished',()=>finished.resolve())
      await sessions.deliver(id,channelMessageInput(message))
      await finished.promise
      assert.match(calls[0]!.prompt,/Scoped personal instructions/)
      assert.match(calls[0]!.prompt,/Custom role prompt/)
      assert.equal(calls[0]!.model,'role-model')
      assert.ok(calls[0]!.tools.includes('read'))
      assert.ok(admins.includes(true))
      assert.equal(sessions.getSessionState(id)?.agentType,'personal-role')
      for(const sender of [{senderId:'stranger'},{isGroup:true}]) await assert.rejects(sessions.deliver(id,channelMessageInput({...message,...sender})),/Verified owner/)
      const cross=channelSessionId({...address,projectId:'other'})
      await assert.rejects(sessions.deliver(cross,channelMessageInput(message)),/Project mismatch/)
      store.update(bot.id,{purpose:'service'})
      await assert.rejects(sessions.deliver(id,channelMessageInput(message)),/service assignment/)
      store.update(bot.id,{purpose:'personal'})
      store.bindOwner(bot.id)
      await assert.rejects(sessions.deliver(id,channelMessageInput(message)),/Verified owner/)
    } finally {await sessions.stop();await handoff.stop();await backgroundTasks.stop();await events.stop();bus.stopAll()}
  })
})
