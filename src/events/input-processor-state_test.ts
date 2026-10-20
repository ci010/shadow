import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { InputProcessor } from './input-processor.ts'

const code = `export function run({state,now}) {
 const count = Number(state?.count ?? 0) + 1;
 return { action: count === 2 ? 'emit' : 'ignore', state: {count,at:now} };
}`
test('JSON state is serialized per partition, code-version isolated and raw IDs deduplicated', async t => {
  const processor = new InputProcessor<string>()
  t.after(() => processor.stop())
  const output: string[] = []
  const send = (key: string, id: string, program = code) => processor.accept({ key, id, item:id, event:{},
    policy:{code:program,delayMs:10}, signal:new AbortController().signal,
    publish:async items => {output.push(...items)} })
  await Promise.all([send('a','1'), send('a','2'), send('a','3')])
  assert.deepEqual(output,['2'])
  await send('a','2')
  await send('b','4')
  await send('a','5',code+'\n// revision')
  assert.deepEqual(output,['2'])
  await send('b','6')
  await send('a','7',code+'\n// revision')
  assert.deepEqual(output,['2','6','7'])
})
test('state and seen IDs persist together across restart; expired state is unavailable', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'processor-state-'))
  const storage = {journalPath:path.join(root,'journal.json'),recover:() => undefined}
  let now = 100
  const clock = {now:() => now,setTimeout:(_fn:() => void,_ms:number) => ({unref(){}}),clearTimeout(){}}
  const output: string[] = []
  let processor = new InputProcessor<string>(() => {},100,clock,storage)
  const send = (id:string) => processor.accept({key:'a',id,item:id,event:{},policy:{code,delayMs:10},
    signal:new AbortController().signal,publish:async items => {output.push(...items)}})
  try {
    await send('1'); await processor.stop()
    processor = new InputProcessor<string>(() => {},100,clock,storage)
    await send('1'); await send('2')
    assert.deepEqual(output,['2'])
    now += 600001
    await send('3')
    assert.deepEqual(output,['2'],'TTL expiry starts a fresh state, not a third increment')
    await send('4')
    assert.deepEqual(output,['2','4'])
  } finally {await processor.stop();await rm(root,{recursive:true,force:true})}
})
test('oversized state fails closed without poisoning state or waking', async t => {
  const processor = new InputProcessor<string>()
  t.after(() => processor.stop())
  const output:string[] = []
  const program = `export function run({event,state}) {
    if(event.bad) return {action:'emit',state:{oversize:'x'.repeat(16001)}};
    return {action:state === null ? 'emit':'ignore',state:{ok:true}};
  }`
  const send = (id:string,bad:boolean) => processor.accept({key:'a',id,item:id,event:{bad},
    policy:{code:program,delayMs:10},signal:new AbortController().signal,publish:async items => {output.push(...items)}})
  await assert.rejects(send('bad',true),/state capacity/)
  await send('good',false)
  assert.deepEqual(output,['good'])
})
