import { createHash } from 'node:crypto'
import { channelSessionId } from '../bus/events.ts'
import type { Hono } from 'hono'
import type { BotInstanceStore } from './bot-store.ts'
import type { ServiceDiscoveryStore } from './service-discovery.ts'
import type { DirectoryBots } from '../agent-authoring/bot-runtime.ts'

/** Observation inventory only. All BOT configuration lives in deployed directories. */
export function serviceGroupsPlugin(options:{bots:BotInstanceStore;discovery:ServiceDiscoveryStore;runtime:DirectoryBots;authorize:(request:Request)=>boolean|Promise<boolean>}) {
  return (app:Hono) => {
    app.get('/api/service-groups',async c=>{
      c.header('Cache-Control','no-store')
      if(!await options.authorize(c.req.raw))return c.json({error:'unauthorized'},401)
      const definitions=options.runtime.definitions(),bots=options.bots.list()
      const revision=createHash('sha256').update(JSON.stringify(definitions.map(item=>item.deployment.revision))).digest('hex')
      return c.json({revision,agentRequirements:{},skills:[],agentSetups:[],agents:definitions.map(item=>item.bot.id),groups:options.discovery.list().filter(group=>bots.some(bot=>bot.id===group.botInstanceId && bot.purpose==='service' && bot.platform===group.platform)).map(group=>{
        const binding=definitions.flatMap(item=>item.bot.bindings.map(binding=>({binding,agent:item.bot.id}))).find(({binding})=>binding.platform!=='discord' && binding.platform===group.platform && binding.botInstanceId===group.botInstanceId && binding.conversationId===group.conversationId)
        const sessionId=channelSessionId({projectId:options.bots.get(group.botInstanceId).projectId,botInstanceId:group.botInstanceId,platform:group.platform,conversationId:group.conversationId})
        return {...group,sessionId,botName:bots.find(bot=>bot.id===group.botInstanceId)!.displayName,enabled:binding?.binding.enabled ?? false,agent:binding?.agent,pending:false,messages:c.req.query('group')===JSON.stringify([group.botInstanceId,group.conversationId]) || c.req.query('session')===sessionId ? group.messages : []}
      })})
    })
  }
}
