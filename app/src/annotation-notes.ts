export interface AnnotationNote { id: string; label: string; description?: string; start: number; end: number }
export type NoteEdit = 'move' | 'start' | 'end'
export function adjustNoteRange(range: {start:number;end:number}, mode: NoteEdit, delta: number, duration: number) {
  const {start,end}=range
  if(![start,end,delta,duration].every(Number.isFinite) || duration<=0 || start<0 || start>=end || end>duration) throw new Error('Invalid note range')
  const minimum=Math.min(.1,end-start,duration), clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n))
  if(mode==='move') { const next=clamp(start+delta,0,duration-(end-start));return {start:next,end:Math.min(duration,next+(end-start))} }
  if(mode==='start') return {start:clamp(start+delta,0,end-minimum),end}
  return {start,end:clamp(end+delta,start+minimum,duration)}
}
/** Overlapping notes remain independently reachable instead of hiding each other. */
export function layoutAnnotationNotes(notes: readonly AnnotationNote[]) {
  const ends:number[]=[], result:{note:AnnotationNote;row:number}[]=[]
  for(const note of [...notes].sort((a,b)=>a.start-b.start || a.end-b.end || a.id.localeCompare(b.id))){
    if(!Number.isFinite(note.start)||!Number.isFinite(note.end)||note.start<0||note.start>=note.end) continue
    let row=ends.findIndex(end=>end<=note.start)
    if(row<0) row=ends.length
    ends[row]=note.end;result.push({note,row})
  }
  // Keep DOM identity/order stable while temporal sorting changes row placement.
  const order=new Map(notes.map((note,index)=>[note.id,index]))
  result.sort((a,b)=>(order.get(a.note.id) ?? 0)-(order.get(b.note.id) ?? 0))
  return {items:result,rows:Math.max(1,ends.length)}
}
