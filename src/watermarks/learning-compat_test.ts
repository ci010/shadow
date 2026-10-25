import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { LearningLedger } from '../agent/learning/ledger.ts'
import { projectStoragePath } from '../utils/data-paths.ts'

test('learning old v1 document, same-session retry fencing, ack and concurrent restart', () => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-learning-core-'))
  try {
    const file = projectStoragePath(root, '.learning', 'state.v1.json')
    mkdirSync(dirname(file), {recursive:true})
    // Existing version-one progress is loaded in place, not copied to a sidecar.
    writeFileSync(file, JSON.stringify({version:1,projectId:'p',cursors:{physical:4},legacy:{},
      batches:[],outcomes:{},consumed:{encapsulator:[],soulReflector:[]},retries:{}}))
    const ledger = new LearningLedger(root,'p')
    const stale = new LearningLedger(root,'p')
    const source = {sessionId:'s',physicalId:'physical',segmentIndex:0,offset:4,end:8}
    assert.equal(ledger.cursor(source),4)
    const b = ledger.create('reflector',[source],[])
    assert.throws(() => stale.create('reflector',[source],[]), /conflict/)
    ledger.bind(b.id,'attempt-one')
    const recovered = new LearningLedger(root,'p')
    recovered.interrupt(b.id,'process died')
    assert.equal(recovered.cursor(source),4)
    // Dispatcher issues a fresh execution session for each retry. Reusing a session
    // is now deliberately rejected so an old receipt cannot acknowledge new work.
    assert.throws(() => recovered.bind(b.id,'attempt-one'), /unique/)
    recovered.bind(b.id,'attempt-two')
    recovered.propose(b.id,'blocked','not finished'); recovered.complete(b.id)
    assert.equal(recovered.cursor(source),4)
    recovered.bind(b.id,'attempt-three')
    recovered.propose(b.id,'no_change','verified'); recovered.complete(b.id)
    assert.equal(new LearningLedger(root,'p').cursor(source),8)
    assert.equal(new LearningLedger(root,'p').pending('reflector'),undefined)
  } finally { rmSync(root,{recursive:true,force:true}) }
})
