import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { AgentDesktopComputerDesktop } from './agent-desktop.ts'
import { ComputerError, type DesktopRequest } from './contracts.ts'

function fixture(script: string, timeoutMs = 2000) {
  let launches = 0
  const desktop = new AgentDesktopComputerDesktop({ timeoutMs, spawnWorker: () => {
    launches++
    return spawn(process.execPath, ['-e', `
      const rl = require('node:readline').createInterface({input:process.stdin});
      rl.on('line', line => { const q=JSON.parse(line); ${script} });
    `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } })
  return { desktop, get launches() { return launches } }
}
const list = { method: 'list' } as const
const signal = () => new AbortController().signal
const code = (expected: string) => (error: unknown) => error instanceof ComputerError && error.code === expected

test('validates both sides and never launches for invalid requests', async t => {
  const f = fixture(`process.stdout.write(JSON.stringify({id:q.id,result:{windows:[],excluded:0}})+'\\n')`)
  t.after(() => f.desktop.interrupt())
  await assert.rejects(f.desktop.request({ method: 'list', processId: -1 }, signal()), code('invalid_request'))
  await assert.rejects(f.desktop.request({ method: 'list', extra: 'x' } as DesktopRequest, signal()), code('invalid_request'))
  assert.equal(f.launches, 0)
  assert.deepEqual(await f.desktop.request(list, signal()), { windows: [], excluded: 0 })
  assert.equal(f.launches, 1)
})

test('malformed results invalidate generation without exposing native data', async t => {
  const f = fixture(`process.stdout.write(JSON.stringify({id:q.id,result:{windows:'PRIVATE'}})+'\\n')`)
  t.after(() => f.desktop.interrupt())
  await assert.rejects(f.desktop.request(list, signal()), code('host_protocol'))
  assert.ok(f.desktop.generation > 0)
  assert.equal(f.launches, 1)
})

test('observations must belong to the selected UUID target', async t => {
  const f = fixture(`process.stdout.write(JSON.stringify({id:q.id,result:{id:require('node:crypto').randomUUID(),targetId:require('node:crypto').randomUUID(), title:'',bounds:{x:0,y:0,width:1,height:1},elements:[],truncated:false}})+'\\n')`)
  t.after(() => f.desktop.interrupt())
  await assert.rejects(f.desktop.request({ method: 'observe', targetId: randomUUID(), screenshot: false }, signal()), code('host_protocol'))
})

test('unsafe foreground payloads and internal guard-path injection fail before dispatch', async () => {
  const f = fixture('throw Error("must not dispatch")')
  for (const action of [
    { kind: 'press_key', elementId: '0', key: 'TAB', modifiers: ['ALT'] },
    { kind: 'type_text', elementId: '0', text: '\u0000' },
    { kind: 'drag', x: 0, y: 0, toX: 0, toY: 0 },
  ]) {
    const request = { method: 'act', targetId: randomUUID(), observationId: randomUUID(), actionId: randomUUID(), action } as DesktopRequest
    await assert.rejects(f.desktop.request(request, signal()), code('invalid_request'))
  }
  await assert.rejects(f.desktop.request({ method: 'foreground', targetId: randomUUID(), guardPath: 'untrusted.exe' } as DesktopRequest, signal()), code('invalid_request'))
  assert.equal(f.launches, 0)
})

test('concurrency rejects rather than queues; abort retires host without replay', async t => {
  const f = fixture('/* unresponsive mock */')
  t.after(() => f.desktop.interrupt())
  const controller = new AbortController()
  const pending = f.desktop.request(list, controller.signal)
  await assert.rejects(f.desktop.request(list, signal()), code('desktop_busy'))
  const rejected = assert.rejects(pending, code('interrupted'))
  controller.abort()
  await rejected
  await f.desktop.interrupt()
  assert.equal(f.launches, 1)
  assert.ok(f.desktop.generation > 0)
})

test('timeout retires child without automatic restart', async t => {
  const f = fixture('/* no response */', 30)
  t.after(() => f.desktop.interrupt())
  await assert.rejects(f.desktop.request(list, signal()), code('host_timeout'))
  await f.desktop.interrupt()
  assert.equal(f.launches, 1)
})

test('missing artifact fails explicitly with no PowerShell fallback', async t => {
  const { mkdtemp, mkdir, copyFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  // Isolate the production worker from installed native artifacts, but retain
  // normal package resolution. release never observes or interacts with a UI.
  const root = await mkdtemp(fileURLToPath(new URL('../../../.agent-desktop-missing-', import.meta.url)))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'src/execution/computer')
  await mkdir(directory, { recursive: true })
  for (const name of ['agent-desktop-worker.js', 'agent-desktop-actions.js']) {
    await copyFile(fileURLToPath(new URL(name, import.meta.url)), join(directory, name))
  }
  const desktop = new AgentDesktopComputerDesktop({ spawnWorker: () => spawn(process.execPath,
    [join(directory, 'agent-desktop-worker.js')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) })
  t.after(() => desktop.interrupt())
  await assert.rejects(desktop.request({ method: 'release', targetId: randomUUID() }, signal()),
    error => code('host_failure')(error) && /matching native artifact; no PowerShell fallback/.test(String(error)))
})

test('worker rejects unknown wire fields without loading native code', async () => {
  const path = fileURLToPath(new URL('./agent-desktop-worker.js', import.meta.url))
  const child = spawn(process.execPath, [path], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  child.stdout.on('data', value => { stdout += value })
  child.stderr.resume()
  const closed = once(child, 'close')
  child.stdin.end(JSON.stringify({ id: randomUUID(), method: 'list', extra: true }) + '\n')
  const [exitCode] = await closed
  assert.equal(exitCode, 2)
  assert.equal(stdout, '')
})

test('requested screenshots cannot silently degrade to a tree-only observation', async t => {
  const f = fixture(`process.stdout.write(JSON.stringify({id:q.id,result:{id:require('node:crypto').randomUUID(),targetId:q.targetId,title:'',bounds:{x:0,y:0,width:1,height:1},elements:[],truncated:false}})+'\\n')`)
  t.after(() => f.desktop.interrupt())
  await assert.rejects(f.desktop.request({ method: 'observe', targetId: randomUUID(), screenshot: true }, signal()), code('host_protocol'))
})

test('child exit invalidates state without retrying or forwarding diagnostics', async t => {
  const f = fixture(`process.stderr.write('PRIVATE NATIVE CONTENT'); process.exit(3)`)
  t.after(() => f.desktop.interrupt())
  await assert.rejects(f.desktop.request(list, signal()), error => code('host_failure')(error) && !String(error).includes('PRIVATE'))
  assert.equal(f.launches, 1)
  assert.ok(f.desktop.generation > 0)
})

test('built addon completes release-only no-UI ABI loop through the production worker', async t => {
  const { existsSync } = await import('node:fs')
  const artifact = fileURLToPath(new URL(`../../../integrations/agent-desktop/artifacts/win32-${process.arch}/shadow-agent-desktop.node`, import.meta.url))
  if (process.platform !== 'win32' || !existsSync(artifact)) { t.skip('Optional matching native artifact not installed'); return }
  // Native release is idempotent metadata cleanup BEFORE desktop()/UIA. This
  // freshly spawned worker has never listed or bound any window; no target is read.
  const desktop = new AgentDesktopComputerDesktop()
  t.after(() => desktop.interrupt())
  assert.deepEqual(await desktop.request({ method: 'release', targetId: randomUUID() }, signal()), { released: true })
  await desktop.interrupt()
  assert.ok(desktop.generation > 0)
})

const ordinaryRequest = (): Extract<DesktopRequest, { method: 'act' }> => ({ method: 'act', targetId: randomUUID(), observationId: randomUUID(), actionId: randomUUID(), action: { kind: 'invoke', elementId: '1' } })
const observationCode = `({id:require('node:crypto').randomUUID(),targetId:q.targetId,title:'Synthetic',bounds:{x:0,y:0,width:100,height:100},elements:[],truncated:false})`

test('ordinary UIA actions dispatch once and validate complete action receipts', async t => {
  const f = fixture(`process.stdout.write(JSON.stringify({id:q.id,result:{actionId:q.actionId,outcome:'executed',verified:false,observation:${observationCode}}})+'\\n')`)
  t.after(() => f.desktop.interrupt())
  const request = ordinaryRequest()
  assert.equal(request.method, 'act')
  const result = await f.desktop.request(request, signal()) as { outcome: string; actionId: string }
  assert.equal(result.outcome, 'executed')
  assert.equal(result.actionId, request.actionId)
  assert.equal(f.launches, 1)
})

test('malformed or mismatched dispatched action receipts become outcome_unknown and retire host', async t => {
  for (const result of [
    `{actionId:q.actionId,outcome:'executed',verified:false,observation:{}}`,
    `{actionId:require('node:crypto').randomUUID(),outcome:'executed',verified:false,observation:${observationCode}}`,
    `{actionId:q.actionId,outcome:'executed',verified:false,observation:{...${observationCode},targetId:require('node:crypto').randomUUID()}}`,
  ]) {
    const f = fixture(`process.stdout.write(JSON.stringify({id:q.id,result:${result}})+'\\n')`)
    t.after(() => f.desktop.interrupt())
    await assert.rejects(f.desktop.request(ordinaryRequest(), signal()), code('outcome_unknown'))
    assert.ok(f.desktop.generation > 0)
    assert.equal(f.launches, 1)
  }
})

test('aborting a dispatched UIA action never invites replay', async t => {
  const f = fixture('/* mock pending effect */')
  t.after(() => f.desktop.interrupt())
  const controller = new AbortController()
  const pending = f.desktop.request(ordinaryRequest(), controller.signal)
  const rejected = assert.rejects(pending, code('outcome_unknown'))
  controller.abort()
  await rejected
  await f.desktop.interrupt()
  assert.equal(f.launches, 1)
})

test('window-only screenshot results preserve the existing observation contract', async t => {
  const f = fixture(`process.stdout.write(JSON.stringify({id:q.id,result:{...${observationCode},screenshot:{mime:'image/png',base64:'iVBORw0KGgo=',width:1,height:1}}})+'\\n')`)
  t.after(() => f.desktop.interrupt())
  const result = await f.desktop.request({ method: 'observe', targetId: randomUUID(), screenshot: true }, signal()) as { screenshot: { mime: string } }
  assert.equal(result.screenshot.mime, 'image/png')
})

test('host approval gates the IPC dispatch and malformed post-effect receipts revoke the grant', { skip: process.platform !== 'win32' }, async t => {
  const { ComputerService } = await import('../../computer/service.ts')
  const windowId = randomUUID(), targetId = randomUUID()
  const nativeObservation = `({...${observationCode},elements:[{id:'1',parentId:null,role:'ControlType.Button',name:'Synthetic',enabled:true,offscreen:false,protected:false,focusable:false,bounds:{x:1,y:1,width:10,height:10},actions:['invoke']}]})`
  const f = fixture(`
    const window={id:${JSON.stringify(windowId)},title:'Synthetic',app:'fixture',pid:123};
    const target={...window,id:${JSON.stringify(targetId)},bounds:{x:0,y:0,width:100,height:100}};
    let result;
    if(q.method==='list') result={windows:[window],excluded:0};
    else if(q.method==='bind') result=target;
    else if(q.method==='observe') result=${nativeObservation};
    else if(q.method==='act') result={actionId:require('node:crypto').randomUUID(),outcome:'executed',verified:false,observation:${nativeObservation}};
    else result={released:true};
    process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
  `)
  const service = new ComputerService(f.desktop)
  t.after(() => service.close())
  const owner = { projectId: 'synthetic-native-project', sessionId: 'web:synthetic-native-test' }
  await service.windows(owner, signal())
  await service.share(owner, windowId, signal())
  const observed = await service.observe(owner, targetId, false, signal())
  const execution = service.act(owner, { targetId, observationId: observed.id, action: { kind: 'invoke', elementId: '1' } }, signal())
  const rejected = assert.rejects(execution, code('outcome_unknown'))
  const review = service.status(owner).pending
  assert.ok(review, 'The exact action must wait for the existing host review')
  assert.equal(review.action.kind, 'invoke')
  service.decide(owner, review.id, true)
  await rejected
  assert.equal(service.status(owner).grant, null, 'An uncertain executed action revokes the grant rather than enabling retry')
  assert.equal(f.launches, 1)
})

test('foreground enablement is explicit metadata and every existing physical form bridges a receipt', async t => {
  const f = fixture(`
    if(q.method==='foreground') { global.enabled=true; process.stdout.write(JSON.stringify({id:q.id,result:{enabled:true}})+'\\n'); return; }
    if(!global.enabled) { process.stdout.write(JSON.stringify({id:q.id,error:{code:'foreground_not_allowed'}})+'\\n'); return; }
    process.stdout.write(JSON.stringify({id:q.id,result:{actionId:q.actionId,outcome:'executed',verified:false,focusRestored:null,observation:${observationCode}}})+'\\n');
  `)
  t.after(() => f.desktop.interrupt())
  const targetId = randomUUID()
  const actions = [
    { kind: 'click', x: 0, y: 1 }, { kind: 'move', x: 0, y: 1 },
    { kind: 'drag', x: 0, y: 1, toX: 2, toY: 3 }, { kind: 'wheel', x: 0, y: 1, steps: 1 },
    { kind: 'press_key', elementId: '1', key: 'ENTER' }, { kind: 'type_text', elementId: '1', text: 'Synthetic' },
  ]
  const { ComputerActionSchema } = await import('./contracts.ts')
  const first = { method: 'act' as const, targetId, observationId: randomUUID(), actionId: randomUUID(), action: ComputerActionSchema.parse(actions[0]) }
  await assert.rejects(f.desktop.request(first, signal()), code('foreground_not_allowed'))
  assert.deepEqual(await f.desktop.request({ method: 'foreground', targetId }, signal()), { enabled: true })
  for (const raw of actions) {
    const actionId = randomUUID()
    const result = await f.desktop.request({ method: 'act', targetId, observationId: randomUUID(), actionId, action: ComputerActionSchema.parse(raw) }, signal()) as { actionId: string; focusRestored: unknown }
    assert.equal(result.actionId, actionId)
    assert.equal(result.focusRestored, null)
  }
  assert.equal(f.launches, 1)
})

test('an uncertain physical operation blocks new work until independent guard cleanup drains', async t => {
  const f = fixture('/* blocked synthetic input; no actual window or OS input */')
  t.after(() => f.desktop.interrupt())
  const controller = new AbortController()
  const operation = f.desktop.request({ method: 'act', targetId: randomUUID(), observationId: randomUUID(), actionId: randomUUID(), action: { kind: 'type_text', elementId: '1', text: 'Synthetic' } }, controller.signal)
  const rejected = assert.rejects(operation, code('outcome_unknown'))
  controller.abort()
  await assert.rejects(f.desktop.request(list, signal()), code('desktop_busy'))
  await rejected
  await f.desktop.interrupt()
  assert.equal(f.launches, 1)
})
