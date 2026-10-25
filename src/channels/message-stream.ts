import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { Journal } from '../watermarks/journal.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
const text = z.string().min(1).max(512)
const event = z.object({ position:z.number().int().positive(), connection:text, conversation:text, parent:text.optional(), platform:text,
  kind:z.enum(['created','updated','deleted','discovered','gap']), message:text.optional(), sender:text.optional(), content:z.string().max(32000).optional(), detail:z.string().max(1000).optional(), revision:text.optional(), historical:z.boolean().optional(), time:z.string(), fingerprint:text })
const schema=z.object({version:z.literal(1),project:text,next:z.number().int().positive(),floor:z.number().int().nonnegative(),events:z.array(event)})
export type ChannelStreamEvent=z.infer<typeof event>
export type StreamInput=Omit<ChannelStreamEvent,'position'|'time'|'fingerprint'>
/** Bounded Project-owned append log. Local positions, never platform timestamps, are consumption cursors. */
export class ChannelMessageStream {
  constructor(private home:string,readonly project:string,private maxEvents=10000) {}
  private load(){const journal=new Journal(projectStoragePath(this.home,'.channel-stream','events.json'),v=>schema.parse(v));const state=journal.read({version:1,project:this.project,next:1,floor:0,events:[]});if(state.project!==this.project)throw new Error('Channel stream Project mismatch');return {journal,state}}
  append(input:StreamInput){
    const {journal,state}=this.load()
    const fingerprint=createHash('sha256').update(JSON.stringify([input.connection,input.conversation,input.kind,input.message,input.kind==='created'?null:input.content,input.kind==='created'?null:input.parent,input.kind==='gap'?randomUUID():input.detail])).digest('hex')
    const related = state.events.filter(e => e.connection === input.connection &&
      e.conversation === input.conversation && e.message === input.message)
    const latest = related.at(-1)
    // A reliable adapter event/revision identity can dedupe non-adjacent replays.
    // Without one, equal content from an earlier state is NOT evidence of replay:
    // updates (and delete/recreate cycles) may legitimately return to that state.
    const existing = input.revision
      ? related.find(e => e.kind === input.kind && e.revision === input.revision)
      : input.kind === 'created'
        ? (input.historical || latest?.kind !== 'deleted' ? latest : undefined)
        : latest?.fingerprint === fingerprint ? latest : undefined
    if(existing)return existing
    const row=event.parse({...input,position:state.next++,time:new Date().toISOString(),fingerprint})
    state.events.push(row)
    while(state.events.length>this.maxEvents || Buffer.byteLength(JSON.stringify(state))>16*1024*1024){state.floor=state.events.shift()!.position}
    journal.save(state);return row
  }
  snapshot(){return structuredClone(this.load().state)}
  latest(connection:string,conversation:string,message:string){return this.snapshot().events.filter(e=>e.connection===connection&&e.conversation===conversation&&e.message===message).at(-1)}
  directory(){const entries=new Map<string,ChannelStreamEvent>();for(const e of this.snapshot().events){const key=JSON.stringify([e.connection,e.conversation]);entries.set(key,{...e,parent:e.parent??entries.get(key)?.parent})};return [...entries.values()].map(e=>({connection:e.connection,conversation:e.conversation,parent:e.parent,platform:e.platform,capabilities:{received:true,history:e.platform==='discord',changes:e.platform==='discord',send:e.platform==='discord'},notice:'Only admitted, actually received conversations. Not a complete platform directory.'}))}
  page(connection:string,conversations:string[],children:boolean,after:number,limit:number,through?:number){
    const state=this.snapshot();if(after<state.floor)throw new Error(`Channel cursor expired; retention gap through local position ${state.floor}. Explicitly choose a new consumer/baseline; not silently skipped.`)
    const selected=new Set(conversations)
    if(children){let changed=true;while(changed){changed=false;for(const e of state.events)if(e.connection===connection&&e.parent&&selected.has(e.parent)&&!selected.has(e.conversation)){selected.add(e.conversation);changed=true}}}
    const all=state.events.filter(e=>e.connection===connection&&selected.has(e.conversation)&&e.position>after&&(through===undefined||e.position<=through))
    return {events:all.slice(0,limit),hasMore:all.length>limit,floor:state.floor}
  }
}
