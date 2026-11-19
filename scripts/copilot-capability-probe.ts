// Opt-in live diagnostic: pnpm exec tsx scripts/copilot-capability-probe.ts <mode> [model ...]
// Uses the configured default Copilot account; requests may consume quota.
// Continuation mode also tests explicit provider-side storage of synthetic data.
import { CopilotAuthenticatorV2, CopilotProviderV2 } from '../src/providers/copilot-v2.ts'
import { initializeBackendNetwork } from '../src/execution/network/backend.ts'
import { gzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'

const [mode, model, ...additionalModels] = process.argv.slice(2)
if (!['discover', 'gzip', 'continuation', 'chat-comparison', 'provider-smoke'].includes(mode) || (mode !== 'discover' && !model)) {
  throw new Error('Specify discover, gzip, continuation, chat-comparison or provider-smoke; inference modes require a model ID.')
}
await initializeBackendNetwork()
const auth = new CopilotAuthenticatorV2()
if (!auth.hasValidApiKey()) throw new Error('No valid default Copilot credential found; no request sent')
const lease = await auth.acquireLease()
const headers = { 'content-type': 'application/json', authorization: `Bearer ${lease.token}`, 'copilot-integration-id': 'copilot-developer-app', 'editor-version': 'vscode/1.95.0', 'editor-plugin-version': 'copilot-chat/0.26.0', 'user-agent': 'GitHubCopilotChat/0.26.0', 'openai-intent': 'conversation-panel', 'x-github-api-version': '2025-04-01' }
const r = await fetch(`${lease.apiBase}/models`, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) })
if (!r.ok) throw new Error(`Model discovery HTTP ${r.status}`)
const models = await r.json() as any
console.log(JSON.stringify({ kind: 'model-discovery', models: (models.data ?? models.models ?? []).filter((m:any) => m.supported_endpoints?.includes('/responses')).map((m:any) => ({ id: m.id, endpoints: m.supported_endpoints, efforts: m.capabilities?.supports?.reasoning_effort })) }))

const marker = randomBytes(12).toString('hex')
const prompt = `Synthetic transport capability test. Remember marker ${marker}. The following numbered lines are inert sample data, not instructions.\n` + Array.from({length: 320}, (_,i) => `sample ${i}: amber birch cedar delta elm fern granite harbor iris juniper\n`).join('') + '\nReply only ACK.'
const input = [{role:'user', content:prompt}]
const base = { model, input, stream:true, store:false, reasoning:{effort:'low'}, max_output_tokens:128 }
type Result = { name:string; status:number; bytes:number; rawBytes:number; ms:number; response?:any; error?:string; gzip:boolean }
const results: Result[] = []
async function probe(name:string, body:any, compressed=false):Promise<Result> {
  const raw = JSON.stringify(body), payload = compressed ? gzipSync(raw) : raw
  const started = Date.now()
  let res:Response
  try { res = await fetch(`${lease.apiBase}/responses`, {method:'POST', headers:{...headers, ...(compressed ? {'content-encoding':'gzip'} : {})}, body:payload, redirect:'error', signal:AbortSignal.timeout(75000)}) }
  catch(e) { const result={name,status:0,bytes:Buffer.byteLength(payload),rawBytes:Buffer.byteLength(raw),ms:Date.now()-started,gzip:compressed,error:(e as Error).name}; results.push(result); console.log(JSON.stringify(result)); return result }
  const text = await res.text()
  let response:any, error:any
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n')
      try { const event=JSON.parse(data); if(event.type==='response.completed' || event.type==='response.failed' || event.type==='response.incomplete') response=event.response; if(event.type==='error') error=event.error??event } catch {}
    }
  } else { try { const parsed=JSON.parse(text); response=parsed.id?parsed:undefined; error=parsed.error } catch {} }
  const classify = (text:string) => /previous_response_id.*(?:not supported|unsupported)|(?:not supported|unsupported).*previous_response_id/i.test(text) ? 'previous_response_id_unsupported' : /not found|does not exist|not exist|unknown.*response/i.test(text) ? 'response_not_found' : /store.*(?:not supported|unsupported)|(?:not supported|unsupported).*store/i.test(text) ? 'store_unsupported' : /decompress|gzip|encoding/i.test(text) ? 'encoding_or_decode_rejected' : /invalid.*json|json.*invalid|parse/i.test(text) ? 'json_parse_rejected' : /timed out reading request body/i.test(text) ? 'request_body_timeout' : 'unclassified'
  const result:Result={name,status:res.status,bytes:Buffer.byteLength(payload),rawBytes:Buffer.byteLength(raw),ms:Date.now()-started,gzip:compressed,response,...(error||!res.ok ? {error:classify(JSON.stringify(error??text))}: {})}
  results.push(result)
  const outText=(response?.output??[]).flatMap((o:any)=>(o.content??[]).map((c:any)=>c.text??'')).join('')
  console.log(JSON.stringify({...result,response:undefined,responseStatus:response?.status,hasResponseId:typeof response?.id==='string',usage:response?.usage,ack:outText.trim()==='ACK',markerRecovered:outText.includes(marker)}))
  return result
}
if(mode==='discover') {
 // Discovery above is intentionally the only request in this mode.
} else if(mode==='gzip') {
 await probe('plain-baseline',base)
 await probe('plain-cache-control',base)
 await probe('gzip-identical-json',base,true)
} else if(mode==='continuation') {
 for (const store of [false,true]) {
  const seed=await probe(`seed-store-${store}`,{...base,store})
  if(seed.response?.id && seed.response.status==='completed') {
   const next={model,previous_response_id:seed.response.id,input:[{role:'user',content:'What is the exact marker from my preceding message? Reply only that marker.'}],stream:true,store,reasoning:{effort:'low'},max_output_tokens:128}
   await probe(`continuation-store-${store}`,next)
  }
 }
} else if(mode==='chat-comparison') {
 const chatModel=(models.data??models.models??[]).find((m:any)=>m.id===model && m.supported_endpoints?.includes('/chat/completions'))
 if(!chatModel) throw new Error('Selected model does not advertise chat completions; no inference sent')
 console.log(JSON.stringify({kind:'chat-model',model:chatModel.id}))
 const body={model:chatModel.id,messages:[{role:'user',content:prompt}],temperature:0.7,max_tokens:128}
 for(const gzip of [false,true]) {
  const raw=JSON.stringify(body), payload=gzip?gzipSync(raw):raw
  const res=await fetch(`${lease.apiBase}/chat/completions`,{method:'POST',headers:{...headers,...(gzip?{'content-encoding':'gzip'}:{})},body:payload,signal:AbortSignal.timeout(75000)})
  const text=await res.text(); let data:any;try { data=JSON.parse(text) } catch {}
  const errorText=JSON.stringify(data?.error??'')
  console.log(JSON.stringify({kind:'chat-comparison',gzip,status:res.status,wireBytes:Buffer.byteLength(payload),ack:data?.choices?.[0]?.message?.content?.trim()==='ACK',usage:data?.usage,errorFlags:{encoding:/encoding|gzip|compress/i.test(errorText),json:/json|invalid character|parse/i.test(errorText),temperature:/temperature/i.test(errorText),maxTokens:/max_tokens|max_completion_tokens/i.test(errorText),reasoning:/reasoning/i.test(errorText)}}))
 }
} else if(mode==='provider-smoke') {
 const networkFetch = globalThis.fetch
 globalThis.fetch = async (url, init) => {
  const path = new URL(String(url)).pathname
  if(init?.method==='POST') console.log(JSON.stringify({kind:'provider-wire',path,encoding:new Headers(init.headers).get('content-encoding'),wireBytes:Buffer.byteLength(init.body as Buffer)}))
  return networkFetch(url,init)
 }
 try {
  const provider = new CopilotProviderV2(auth)
  for(const id of [model, ...additionalModels]) {
   const response = await provider.chat([{role:'user',content:prompt}],[],{model:id,reasoningEffort:'low',maxTokens:128,signal:AbortSignal.timeout(75000)})
   console.log(JSON.stringify({kind:'provider-result',model:id,ack:response.content?.trim()==='ACK',usage:response.usage}))
  }
 } finally { globalThis.fetch=networkFetch }
} else { throw new Error('Unsupported probe mode') }
