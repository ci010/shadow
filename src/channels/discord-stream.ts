import { z } from 'zod'
import { ChannelMessageStream } from './message-stream.ts'
import { Journal } from '../watermarks/journal.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { discordReadMessage } from './discord-operations.ts'
import type { DiscordApi } from './discord-directory.ts'
const progress=z.record(z.string(),z.object({after:z.string().regex(/^\d{1,20}$/),initial:z.boolean()}))
/** Explicit bounded catch-up, independent of agent consumer state. One page per conversation per read.
 * The initial latest page is a bounded baseline, never a claim of complete historical coverage. */
export async function collectDiscordHistory(home:string,project:string,connection:string,conversation:string,api:DiscordApi,signal:AbortSignal,parent?:string,admit?:(sender:string,message:string)=>Promise<boolean>){
 if(!/^\d{1,20}$/.test(conversation))throw new Error('Invalid Discord channel ID')
 const journal=new Journal(projectStoragePath(home,'.channel-stream','discord-progress.json'),v=>progress.parse(v)),state=journal.read({}),key=JSON.stringify([connection,conversation]),old=state[key]
 const raw=z.array(z.unknown()).max(100).parse(await api(`/channels/${conversation}/messages?limit=100${old?`&after=${old.after}`:''}`,{signal}))
 const messages=raw.map(m=>discordReadMessage(m,conversation)).sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1)
 if(new Set(messages.map(m=>m.id)).size!==messages.length||messages.some(m=>old&&BigInt(m.id)<=BigInt(old.after)))throw new Error('Discord history pagination failed to advance')
 const stream=new ChannelMessageStream(home,project)
 if(!old)stream.append({connection,conversation,platform:'discord',kind:'gap',detail:'Initial bounded latest-100 history baseline; older messages and offline edits/deletes may be absent.',...(parent?{parent}:{})})
 let skipped=0
 for(const m of messages) { if(admit && !await admit(m.author.id,m.id)) {skipped++;continue}; stream.append({connection,conversation,platform:'discord',kind:'created',historical:true,message:m.id,sender:m.author.id,content:(m.content ?? '').slice(0,32000),...(parent?{parent}:{})}) }
 state[key]={after:messages.at(-1)?.id ?? old?.after ?? '0',initial:true};journal.save(state)
 return {hasMore:messages.length===100,skippedUnauthorized:skipped,notice:'Only message creations can be backfilled; offline edits/deletes cannot be reconstructed. Continue bounded reads while hasMore. Gateway receipt and consumer watermarks are independent.'}
}
