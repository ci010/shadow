import assert from 'node:assert/strict'
import test from 'node:test'
import { adjustNoteRange, layoutAnnotationNotes } from './annotation-notes.ts'
import { parseAlignmentTarget } from './alignment-lab-model.ts'
test('note drag preserves span and source bounds; edge edits retain a minimum span',()=>{
  assert.deepEqual(adjustNoteRange({start:2,end:4},'move',20,12),{start:10,end:12})
  assert.deepEqual(adjustNoteRange({start:2,end:4},'move',-20,12),{start:0,end:2})
  assert.deepEqual(adjustNoteRange({start:2,end:4},'start',20,12),{start:3.9,end:4})
  assert.deepEqual(adjustNoteRange({start:2,end:4},'end',-20,12),{start:2,end:2.1})
  assert.deepEqual(adjustNoteRange({start:0,end:.05},'end',10,.05),{start:0,end:.05})
  for(const delta of [NaN,Infinity])assert.throws(()=>adjustNoteRange({start:2,end:4},'move',delta,12))
  assert.throws(()=>adjustNoteRange({start:0,end:13},'move',1,12))
})
test('overlapping notes occupy separate rows; identity remains independent of display order',()=>{
  const result=layoutAnnotationNotes([{id:'b',label:'B',start:1,end:3},{id:'a',label:'A',start:0,end:2},{id:'c',label:'C',start:3,end:4}])
  assert.equal(result.rows,2)
  assert.deepEqual(result.items.map(x=>x.note.id),['b','a','c'],'DOM order stays stable during range edits')
  assert.equal(result.items.find(x=>x.note.id==='a')!.row,0)
  assert.equal(result.items.find(x=>x.note.id==='b')!.row,1)
  assert.equal(result.items.find(x=>x.note.id==='c')!.row,0)
})
test('note export preserves explicit source versus sequence time basis and accepts old ranges',()=>{
  const target={id:'n1',label:'Note',selector:{type:'time-range',start:1,end:3,duration:12,trackId:'video'}}
  assert.equal(parseAlignmentTarget(target).selector.type,'time-range')
  for(const timeBasis of ['source','sequence']){
    const parsed=parseAlignmentTarget({...target,selector:{...target.selector,timeBasis}})
    assert.deepEqual(parsed,{...target,selector:{...target.selector,timeBasis}})
  }
  assert.throws(()=>parseAlignmentTarget({...target,selector:{...target.selector,timeBasis:'screen'}}))
})
