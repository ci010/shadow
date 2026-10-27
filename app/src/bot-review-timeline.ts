import { ref, watch, onUnmounted, onMounted } from 'vue'
import { z } from 'zod'
import { BotReviewRecordSchema, type BotReviewRecord } from '../../src/agent-authoring/bot-review-contract.ts'
import { apiUrl } from './api-url.ts'

/** Prefer the host tool-call anchor; timestamps are only a legacy display fallback. */
export function botReviewPositions(records:BotReviewRecord[], messages:{toolCallId?:string;timestamp?:string;event?:string}[]) {
  const positions = new Map<number,BotReviewRecord[]>()
  for (const record of records) {
    let index = messages.findIndex(msg => msg.toolCallId === record.origin.toolCallId && msg.event === 'tool_result')
    if (index < 0) index = messages.findIndex(msg => msg.toolCallId === record.origin.toolCallId)
    if (index < 0) {
      index = -1
      for (let i=0;i<messages.length;i++) if (messages[i]?.timestamp && messages[i]!.timestamp! <= record.createdAt) index=i
    }
    positions.set(index,[...(positions.get(index) ?? []),record])
  }
  return positions
}
export function useBotReviews(source:() => {apiBase:string;projectId:string;sessionId:string;physicalId?:string|null;active:boolean;stage?:string|null;messageCount:number}) {
  const reviews = ref<BotReviewRecord[]>([]), error = ref('')
  let controller:AbortController|undefined
  let generation=0
  async function refresh() {
    const current=++generation
    controller?.abort(); controller=undefined
    const input=source()
    if (!input.active || !input.sessionId) {reviews.value=[];return}
    const abort = new AbortController();controller=abort
    try {
      const path=`/api/bot-package/reviews/${encodeURIComponent(input.sessionId)}${input.physicalId ? `?physicalId=${encodeURIComponent(input.physicalId)}` : ''}`
      const response=await fetch(apiUrl(input.apiBase,path),{cache:'no-store',redirect:'error',signal:abort.signal})
      if (!response.ok) throw new Error('Review history unavailable')
      const value=z.object({projectId:z.literal(input.projectId),reviews:z.array(BotReviewRecordSchema)}).strict().parse(await response.json())
      if (value.reviews.some(record=>record.origin.sessionId!==input.sessionId || record.projectId!==input.projectId) || new Set(value.reviews.map(r=>r.id)).size!==value.reviews.length) throw new Error('Review history mismatch')
      if (current===generation) {reviews.value=value.reviews;error.value=''}
    } catch {if(current===generation && !abort.signal.aborted) {reviews.value=[];error.value='Review history unavailable'}}
  }
  watch(()=>[source().apiBase,source().projectId,source().sessionId,source().physicalId,source().active],()=>{reviews.value=[];error.value='';void refresh()},{immediate:true})
  watch(()=>[source().stage,source().messageCount],()=>{void refresh()})
  const focus=()=>{void refresh()}
  onMounted(()=>window.addEventListener('focus',focus))
  onUnmounted(()=>{generation++;controller?.abort();window.removeEventListener('focus',focus)})
  return {reviews,error,refresh}
}
