import type { Processor } from '@shadow/input-processor'
import { signature } from './signature.ts'

type Window = { identity:string; signature:string; start:number; channels:string[];
  evidence:Record<string,unknown>[]; cooldownUntil:number }
// The host partitions state by reviewed scope revision + guild + observed sender.
// An individual four-image post is not a campaign. Three distinct channels within
// 20 seconds are required. Detection emits immediately, not at the window end.
export const run: Processor = ({event,state,now}) => {
  const data = event.data
  const author = data.author as Record<string,unknown> | undefined
  if (!author?.id || !data.guild_id || !data.channel_id) return {action:'ignore'}
  const identity = JSON.stringify([data.guild_id,author.id])
  const candidate = state?.window as Window | undefined
  if (candidate?.identity === identity && candidate.cooldownUntil > now) return {action:'ignore'}
  const currentSignature = signature(data)
  if (!currentSignature) return {action:'ignore'}
  const window: Window = candidate?.identity === identity && candidate.signature === currentSignature && now-candidate.start <= 20000
    ? candidate : {identity,signature:currentSignature,start:now,channels:[],evidence:[],cooldownUntil:0}
  const channelId = String(data.channel_id)
  if (window.channels.includes(channelId)) return {action:'ignore'}
  window.channels.push(channelId)
  window.evidence.push({messageId:data.id,channelId,content:String(data.content ?? '').slice(0,1000)})
  if (window.channels.length < 3) return {action:'ignore',state:{window}}
  window.cooldownUntil = now+60000
  return {action:'emit',state:{window},semantic:{type:'advertising.campaign',data:{
    signatureKind:'metadata-only',guildId:data.guild_id,observedSenderId:author.id,
    channelIds:window.channels,evidence:window.evidence,
  }}}
}
