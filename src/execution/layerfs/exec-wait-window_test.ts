import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { branchWorkspace } from './workspace-identity.ts'
import { runBridge, layerfsName } from './bridge.ts'
import { ToolOutcomeUnknownError } from '../../tools/tool.ts'

const project = layerfsName('wait-window-fixture')
const workspace = branchWorkspace(project, 'feature')

test('lifecycle-managed exec ignores bridge receipt timeout while forwarding live output', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-wait-'))
  try {
    const sdkModule = join(dir, 'sdk.mjs')
    await writeFile(sdkModule, `export const LayerFS = {open: async()=>({project:{list_sandboxes:async()=>({items:[],hasMore:false})},sandbox:{create:async()=>({sandbox:'1'}),close:async()=>({kind:'Closed'})},workspace:{mount:async()=>({sandbox:'1',path:'/workspaces/1'}),commit:async()=>({kind:'UpToDate',head:null,root:'d'.repeat(64)}),unmount:async()=>({kind:'Unmounted'}),exec:async(_ws,_command,_message,sinks)=>{
      await new Promise((ok,no)=>sinks.stdout.write('before-wait;',e=>e?no(e):ok()));
      await new Promise(ok=>setTimeout(ok,100));
      await new Promise((ok,no)=>sinks.stdout.write('after-wait',e=>e?no(e):ok()));
      return {code:0};
    }},close:async()=>{}})};`)
    const observed: string[] = []
    const result = await runBridge({ sdkModule, env: {} }, project, 'exec', { workspace, command: 'fixture-only', journal:join(dir,'operation.jsonl') },
      new AbortController().signal, 1, { observe: text => observed.push(text) })
    assert.equal(JSON.parse(result).result.code, 0)
    assert.equal(JSON.parse(result).result.stdout.text, 'before-wait;after-wait')
    assert.equal(observed.join(''), 'before-wait;after-wait')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('unconfirmed sandbox cancellation remains UNKNOWN rather than reporting cancelled', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-wait-'))
  try {
    const sdkModule = join(dir, 'sdk.mjs')
    await writeFile(sdkModule, `export const LayerFS = {open: async()=>({project:{list_sandboxes:async()=>({items:[],hasMore:false})},sandbox:{create:async()=>({sandbox:'1'}),close:async()=>({kind:'Closed'})},workspace:{mount:async()=>({sandbox:'1',path:'/workspaces/1'}),commit:async()=>({kind:'UpToDate',head:null,root:'d'.repeat(64)}),unmount:async()=>({kind:'Unmounted'}),exec:async(_ws,command,_message,sinks)=>{
      if(command.startsWith('umask 077; mkdir -p ')) return {code:1};
      await new Promise((ok,no)=>sinks.stdout.write('started',e=>e?no(e):ok()));
      return await new Promise(()=>{});
    }},close:async()=>{}})};`)
    const controller = new AbortController()
    let requested = false
    const result = runBridge({ sdkModule, env: {} }, project, 'exec', { workspace, command: 'fixture-only', journal:join(dir,'operation.jsonl') }, controller.signal, 1,
      { observe: () => { if (!requested) { requested = true; controller.abort() } } })
    await assert.rejects(result, error => error instanceof ToolOutcomeUnknownError && /cancellation marker failed/.test(error.message))
    assert.equal(requested, true)
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
