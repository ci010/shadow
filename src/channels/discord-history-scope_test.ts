import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Bus } from '../bus/bus.ts'
import { DiscordChannel } from './discord.ts'
import { DiscordPermission as P } from './discord-permissions.ts'
import { discordHistoryArguments, discordMessageArguments, type ChannelOperationRequest } from './operations.ts'
import type { DiscordHistoryScope } from './integration-contract.ts'

const scope:DiscordHistoryScope = {guildId:'100',channelIds:['201','202','205'],threads:'public-archived',preEpoch:true}
const signal = new AbortController().signal
const message = (id='800',channel='202',content='needle') => ({id,channel_id:channel,type:0,author:{id:'500',username:'author'},content,timestamp:'2000-01-01T00:00:00.000Z'})
function fixture(t:TestContext) {
  const channel = new DiscordChannel(new Bus(),{token:'synthetic',allowFrom:['500']})
  const channels:Record<string,Record<string,unknown>> = Object.fromEntries(['201','202','204','205'].map(id=>[id,{id,guild_id:'100',type:id==='205'?15:0,permission_overwrites:[]}]))
  channels['203']={id:'203',guild_id:'100',type:11,parent_id:'202',thread_metadata:{archived:false,archive_timestamp:'2020-01-01T00:00:00.000Z'}}
  channels['206']={id:'206',guild_id:'100',type:12,parent_id:'202',thread_metadata:{archived:false}}
  let actor = true, bot = true
  let duringRead = () => {}
  let history:unknown = [message('800'),message('799','202','other')]
  let threads:unknown = {threads:[],has_more:false}
  const calls:string[]=[]
  t.mock.method(channel as unknown as {api:(path:string)=>Promise<unknown>},'api',async (path:string)=>{
    calls.push(path)
    if(path==='/users/@me') return {id:'900',bot:true}
    if(path==='/guilds/100') return {id:'100',owner_id:'999'}
    if(path==='/guilds/100/roles') return [{id:'100',permissions:String(P.view|P.readHistory)}]
    if(path==='/guilds/100/members/900') return {user:{id:'900',bot:true},roles:[]}
    if(path==='/guilds/100/members/500') return {user:{id:'500',bot:false},roles:[]}
    if(path==='/guilds/100/threads/active'||path.includes('/threads/archived/public?')) return threads
    if(path.includes('/messages/800')) return message('800',path.split('/')[2])
    if(path.includes('/messages?')) {duringRead();return history}
    if(path.startsWith('/channels/')) {
      const value = structuredClone(channels[path.split('/')[2]!])
      if(!value) throw new Error('Unknown channel')
      if(!actor||!bot) value.permission_overwrites=[{id:!actor?'500':'900',type:1,allow:'0',deny:String(P.readHistory)}]
      return value
    }
    throw new Error('Unexpected '+path)
  })
  const run = (args:Record<string,unknown>={},grant:DiscordHistoryScope|null=scope) => channel.executeOperation({name:'discord_history',args:discordHistoryArguments.parse(args)}, {chatId:'201',senderId:'500',signal,discordReadScope:grant ?? undefined})
  return {channel,channels,calls,run,duringRead:(callback:()=>void)=>{duringRead=callback},revokeActor:()=>{actor=false},revokeBot:()=>{bot=false},history:(value:unknown)=>{history=value},threads:(value:unknown)=>{threads=value}}
}

test('exact history allowlist and live actor/Bot checks, with conservative cross-channel audience proof',async t=>{
  const f=fixture(t)
  const result=await f.run({channelId:'202',limit:2,query:'needle'}) as {messages:unknown[];nextBefore:string;guildId:string;channelId:string}
  assert.equal(result.messages.length,1);assert.equal(result.nextBefore,'799');assert.equal(result.guildId,'100');assert.equal(result.channelId,'202')
  await assert.rejects(f.run({channelId:'204'}),/allowlist/)
  assert(!f.calls.some(path=>path.startsWith('/channels/204/messages')))
  await assert.rejects(f.run({channelId:'202'},null),/scope/)
  f.channels['202']!.permission_overwrites=[{id:'501',type:1,allow:'0',deny:String(P.view)}]
  await assert.rejects(f.run({channelId:'202'}),/audiences differ/)
  f.channels['202']!.permission_overwrites=[]
  f.revokeActor();await assert.rejects(f.run({channelId:'202'}),/revoked/)
})
test('Bot read-history revocation is checked on every read',async t=>{
  const f=fixture(t);await f.run({channelId:'202'});f.revokeBot();await assert.rejects(f.run({channelId:'202'}),/revoked/)
})
test('public threads, archived boundary and public-only discovery paging',async t=>{
  const f=fixture(t)
  f.history([message('800','203')])
  const result=await f.run({channelId:'203'}) as {threadId:string;channelId:string}
  assert.equal(result.threadId,'203');assert.equal(result.channelId,'202')
  await assert.rejects(f.run({channelId:'206'}),/scope/)
  await assert.rejects(f.run({channelId:'203'},{...scope,threads:'none'}),/allowlist/)
  f.channels['203']!.thread_metadata={archived:true,archive_timestamp:'2020-01-01T00:00:00.000Z'}
  await assert.rejects(f.run({channelId:'203'},{...scope,threads:'public-active'}),/Archived/)
  f.threads({threads:[f.channels['203']],has_more:true})
  const archived=await f.run({channelId:'202',threads:'archived',limit:1}) as {threads:unknown[];nextArchiveBefore:string}
  assert.equal(archived.threads.length,1);assert.equal(archived.nextArchiveBefore,'2020-01-01T00:00:00.000Z')
  await f.run({channelId:'202',threads:'archived',limit:1,archiveBefore:'2021-01-01T00:00:00.000Z'})
  assert(f.calls.some(path=>path.includes('before=2021-01-01T00%3A00%3A00.000Z')))
  await assert.rejects(f.run({channelId:'202',threads:'archived'},{...scope,threads:'public-active'}),/scope/)
  f.channels['203']!.thread_metadata={archived:false}
  f.channels['207']={...f.channels['203'],id:'207'}
  f.threads({threads:[f.channels['207'],f.channels['203']],has_more:false})
  const page=await f.run({channelId:'202',threads:'active',limit:1}) as {threads:Array<{id:string}>;nextThreadAfter:string}
  assert.equal(page.threads[0]!.id,'203');assert.equal(page.nextThreadAfter,'203')
  const page2=await f.run({channelId:'202',threads:'active',limit:1,threadAfter:'203'}) as {threads:Array<{id:string}>}
  assert.equal(page2.threads[0]!.id,'207')
})
test('history parameters are bounded, links and arbitrary API fields are rejected',async t=>{
  for(const args of [{limit:101},{query:'x'.repeat(201)},{channelId:'https://discord.com/channels/100/202'},{after:'1'},{archiveBefore:'bogus'}]) assert.throws(()=>discordHistoryArguments.parse(args))
  assert.throws(()=>discordMessageArguments.parse({messageId:'https://discord.com/messages/800'}))
  const f=fixture(t)
  await assert.rejects(f.run({threads:'active',before:'1'}),/paging/)
  await assert.rejects(f.channel.executeOperation({name:'discord_message_get',args:{messageId:'800',channelId:'204'}} as ChannelOperationRequest,{chatId:'201',senderId:'500',signal,discordReadScope:scope}),/allowlist/)
})


test('history rechecks permissions and audience after fetch, including inherited thread age restrictions',async t=>{
  const f=fixture(t)
  f.channels['202']!.nsfw=true
  await assert.rejects(f.run({channelId:'203'}),/age-restricted/)
  // An NSFW output thread inherits from its parent, not the thread payload itself.
  f.channels['201']!.nsfw=true
  f.history([message('800','203')]);await f.run({channelId:'203'})
  f.channels['202']!.nsfw=false;f.channels['201']!.nsfw=false
  f.history([message()])
  f.duringRead(()=>{f.channels['202']!.permission_overwrites=[{id:'501',type:1,allow:'0',deny:String(P.view)}]})
  await assert.rejects(f.run({channelId:'202'}),/audiences differ/)
  f.channels['202']!.permission_overwrites=[]
  f.duringRead(f.revokeActor)
  await assert.rejects(f.run({channelId:'202'}),/revoked/)
})
