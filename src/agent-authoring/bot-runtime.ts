import { AgentAuthoringService } from './service.ts'
import type { PublishedTool } from './contracts.ts'
import { feishuHistoryArguments, feishuMessageArguments, type ChannelOperationRequest, type ChannelOperationContext } from '../channels/operations.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync, lstatSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { assertPrivateFileBoundary } from '../utils/private-document.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { parseBot, type BotDefinition } from '../bots/sdk.ts'
import { executeBotTool } from '../bots/tool-runtime.ts'
import { parseAgentFile } from '../agent/types/parse.ts'
import { conversationBindingKey, type ResolvedConversationPolicy } from './contracts.ts'
import type { ChannelAddress } from '../bus/events.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { CapabilityBroker } from './capabilities.ts'
import type { IntegrationAgent, DiscordBinding } from '../channels/integration-contract.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const agentName = (id:string) => `bot_${id.slice(0,40)}_${digest(id).slice(0,16)}`
const uuid = (id: string) => { const h = digest(['bot', id]); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}` }

/** Directory-backed BOT policy adapter. No source or release snapshots are persisted in policy JSON. */
export class DirectoryBots {
  constructor(readonly deployments: BotDeployments, private broker?: CapabilityBroker) {}
  setBroker(broker: CapabilityBroker): void { this.broker = broker }
  private channelOperation?: (request:ChannelOperationRequest,context:ChannelOperationContext)=>Promise<unknown>
  setChannelOperations(call:(request:ChannelOperationRequest,context:ChannelOperationContext)=>Promise<unknown>):void {this.channelOperation=call}
  definitions() {
    return this.deployments.list().map(deployment => {
      const current = this.deployments.read(deployment.id)
      if (!current) throw new Error('BOT deployment disappeared.')
      const bot = parseBot(current.files)
      if (bot.id !== deployment.id) throw new Error('BOT deployment identity mismatch.')
      return { bot, files: current.files, deployment: current.deployment }
    })
  }
  personal(connection: string) {
    const matches = this.definitions().filter(({bot}) => bot.mode === 'personal' && bot.connection === connection)
    if (matches.length > 1) throw new Error('Connection is owned by multiple personal BOT deployments.')
    return matches[0]?.bot
  }
  isManaged(address: Pick<ChannelAddress, 'botInstanceId' | 'platform' | 'conversationId'>): boolean {
    return this.definitions().some(({bot}) => bot.bindings.some(binding => binding.platform === address.platform && binding.botInstanceId === address.botInstanceId))
  }
  resolve(address: Pick<ChannelAddress, 'botInstanceId' | 'platform' | 'conversationId'>): ResolvedConversationPolicy | undefined {
    const matches = this.definitions().flatMap(({ bot, deployment }) => bot.bindings.flatMap(binding => {
      if (binding.platform === 'discord' || conversationBindingKey(binding) !== conversationBindingKey(address)) return []
      const { tools, ...data } = binding
      const agent = parseAgentFile(`---\n${stringify({name:agentName(bot.id), defaultMode:'session', allowedTools:tools, allowedModules:bot.allowedModules})}---\n${bot.prompt}`, agentName(bot.id), this.deployments.runtimeDirectory(bot.id))
      return [{ revision: deployment.revision, binding: { ...data, agent: agentName(bot.id) }, agent,
        skillPrompts: bot.skills ?? [], tools: bot.tools.filter(tool => tools.includes(tool.name)).map(tool => ({...tool,source:tool.module,skill:bot.id,code:''})) }]
    }))
    if (matches.length > 1) throw new Error('Conversation is owned by multiple BOT deployments.')
    return matches[0]
  }
  discord(candidates = this.definitions()): { agents: IntegrationAgent[]; bindings: DiscordBinding[] } {
    const agents: IntegrationAgent[] = [], bindings: DiscordBinding[] = []
    for (const {bot,deployment} of candidates) {
      const selected = bot.bindings.filter(binding => binding.platform === 'discord')
      if (!selected.length) continue
      const id = uuid(bot.id)
      const tools = [...new Set(selected.flatMap(binding => binding.tools))]
      agents.push({ id,name:agentName(bot.id),displayName:bot.id,markdown:`---\n${stringify({name:agentName(bot.id),defaultMode:'session',allowedTools:tools})}---\n${bot.prompt}`,
        execution:'restricted',tools,readDomains:bot.readDomains ?? [],sourceFolders:bot.sourceFolders,discordHistory:bot.discordHistory,skills:bot.skills ?? [],
        version:deployment.revision,publishedAt:new Date(0).toISOString() })
      for (const binding of selected) {
        const {platform: _platform,...data} = binding
        bindings.push({...data,agentId:id,epochRevision:parseInt(deployment.revision.slice(0,12),16)})
      }
    }
    if (new Set(bindings.map(binding => binding.id)).size !== bindings.length || new Set(bindings.map(binding => JSON.stringify([binding.botInstanceId,binding.target]))).size !== bindings.length) throw new Error('Discord conversation is owned by multiple BOT deployments.')
    return {agents,bindings}
  }
  customTools(name: string) { return this.definitions().find(({bot}) => agentName(bot.id) === name)?.bot.tools ?? [] }
  async execute(botId: string, revision: string, allowedTools: readonly string[], name: string, args: Record<string,unknown>, context: ExecutionContext, bindingId?:string, authorize?: (signal:AbortSignal)=>Promise<void>) {
    const identity=this.definitions().find(({bot})=>bot.id===botId || agentName(bot.id)===botId)
    if(identity)botId=identity.bot.id
    const current = this.deployments.read(botId)
    if (!current || current.deployment.revision !== revision) throw new Error('BOT deployment changed.')
    const bot = parseBot(current.files)
    const check = () => {
      context.signal.throwIfAborted()
      if (this.deployments.read(botId)?.deployment.revision !== revision) throw new Error('BOT deployment changed.')
    }
    // Storage is per BOT and binding; scripts never receive a host path or filesystem API.
    const scope = digest([context.channelAddress?.botInstanceId,context.channelAddress?.conversationId,context.sessionId])
    const directory = join(this.deployments.dataDirectory(botId),'storage',scope)
    const storage = async (operation:'get'|'set'|'delete', input:Record<string,unknown>) => {
      check()
      if (typeof input.key !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.key)) throw new Error('Invalid storage key.')
      const file = join(directory,`${input.key}.json`)
      assertPrivateFileBoundary(file)
      if(existsSync(file) && lstatSync(file).size > 256_000)throw new Error('Stored value exceeds limit.')
      const data = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : null
      if (operation === 'get') return data
      if(operation === 'delete'){if(existsSync(file))unlinkSync(file);return {ok:true}}
      mkdirSync(directory,{recursive:true,mode:0o700})
      const value = input.value
      const text = JSON.stringify(value)
      if (text === undefined || Buffer.byteLength(text) > 256_000) throw new Error('Storage value exceeds limit.')
      const entries=readdirSync(directory).filter(name=>name.endsWith('.json'))
      if(!existsSync(file) && entries.length>=256)throw new Error('BOT storage key quota exceeded.')
      const total=entries.reduce((bytes,name)=>{const entry=join(directory,name);assertPrivateFileBoundary(entry);return bytes+lstatSync(entry).size},0)
      if(total-(existsSync(file)?lstatSync(file).size:0)+Buffer.byteLength(text)>8*1024*1024)throw new Error('BOT storage byte quota exceeded.')
      const temporary = `${file}.tmp`
      assertPrivateFileBoundary(temporary)
      writeFileSync(temporary,text,{mode:0o600}); renameSync(temporary,file)
      return {ok:true}
    }
    const services = async (grantId:string,input:Record<string,unknown>, signal:AbortSignal) => {
      check()
      const address = context.channelAddress
      const binding = bot.bindings.find(binding => binding.platform === 'discord' ? binding.id === bindingId : address && conversationBindingKey(binding) === conversationBindingKey(address))
      if (!binding) throw new Error('No service grant on this BOT binding.')
      const module = `@shadow/${grantId.replace(/^@shadow\//,'')}`
      if (!bot.tools.find(tool => tool.name === name)?.imports.includes(module)) throw new Error('Service is not declared by this tool.')
      const grant = (binding.grants ?? []).find(grant => `@shadow/${grant.id}` === module)
      if (!grant) throw new Error('Service is not granted to this BOT binding.')
      if (!this.broker) throw new Error('BOT service broker unavailable.')
      return this.broker.execute(grant,input,{sessionId:context.sessionId,inputId:context.messageId,toolCallId:context.toolCallId ?? context.messageId,bindingKey:binding.platform === 'discord' ? binding.id : conversationBindingKey(binding),revision,signal,assertCurrent:check})
    }
    const result = await executeBotTool({files:current.files,tool:name,args,signal:context.signal,allowedTools,
      authorize:async(_request,signal) => {check();await authorize?.(signal);check()},callModule:services,services,storage,
      channel:async (operation,input) => {
        check()
        if (!allowedTools.includes(operation) || bot.tools.some(tool => tool.name === operation)) throw new Error('Channel operation is not exposed on this binding.')
        if (context.channelAddress?.platform === 'feishu' && this.channelOperation) {
          if(operation === 'feishu_history')return this.channelOperation({name:operation,args:feishuHistoryArguments.parse(input)},context)
          if(operation === 'feishu_message_get')return this.channelOperation({name:operation,args:feishuMessageArguments.parse(input)},context)
        }
        const tool = context.tools.get(operation)
        if (!tool || !['discord_history','discord_message_get'].includes(operation)) throw new Error('Unsupported controlled channel operation.')
        return tool.execute(input,context)
      },
      log:async (level,message) => { check(); console[level](`[bot:${botId}] ${message.slice(0,4096)}`) },
    })
    check(); return result
  }
}

/** Explicit directory policy provider. Generic resource authoring is not a BOT fallback. */
export class DirectoryBotService extends AgentAuthoringService {
  constructor(options: ConstructorParameters<typeof AgentAuthoringService>[0],private readonly bots:DirectoryBots){super(options)}
  protected override get policyStore(){return this.bots}
  protected override async executeDeclaredTool(policy:ResolvedConversationPolicy,tool:PublishedTool,args:Record<string,unknown>,context:ExecutionContext,assertCurrent:()=>void):Promise<unknown>{
    assertCurrent()
    return this.bots.execute(policy.agent.name,policy.revision,policy.agent.allowedTools ?? [],tool.name,args,context)
  }
}
