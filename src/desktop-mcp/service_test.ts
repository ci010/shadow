import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DesktopConnection, DesktopDeviceGate, managedDesktopSource } from './service.ts'
import { McpConnection } from '../mcp/client.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { ToolOutcomeUnknownError } from '../tools/tool.ts'

const fake = `
const rl=require('node:readline').createInterface({input:process.stdin});
const reply=(id,result)=>console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
rl.on('line',line=>{ const m=JSON.parse(line);
 if(m.method==='tools/call')require('node:fs').writeFileSync(process.env.SHADOW_FAKE_CALL_LOG,JSON.stringify({id:m.id}));
 if(m.method==='notifications/cancelled')require('node:fs').appendFileSync(process.env.SHADOW_FAKE_CANCEL_LOG,JSON.stringify(m.params)+'\\n');
 if(m.method==='initialize')reply(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fake-official',version:'1.2.0'}});
 if(m.method==='tools/list')reply(m.id,{tools:[{name:'desktop',description:'official schema',inputSchema:{type:'object',properties:{mode:{type:'string'}},required:['mode'],additionalProperties:false}}]});
 if(m.method==='tools/call'&&m.params.arguments.mode==='ok')reply(m.id,{content:[{type:'text',text:'literal\\\\ntext'},{type:'image',mimeType:'image/png',data:'aW1n'}],structuredContent:{nested:{unchanged:true}}});
 if(m.method==='tools/call'&&m.params.arguments.mode==='crash')process.exit(2);
 if(m.method==='tools/call'&&m.params.arguments.mode==='malformed')console.log('{invalid-json');
 if(m.method==='tools/call'&&m.params.arguments.mode==='error')reply(m.id,{isError:true,content:[{type:'text',text:'official failure'}]});
});
rl.on('close',()=>process.exit(0));
`
async function fixture(t: { after(fn: () => Promise<unknown>): void }, gate = new DesktopDeviceGate()) {
  const root = await mkdtemp(join(tmpdir(), 'shadow-mcp-fake-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const script = join(root, 'server.cjs')
  await writeFile(script, fake)
  const conn = new DesktopConnection({ name: 'agent-desktop', transport: 'stdio', command: process.execPath, args: [script], env: { SHADOW_FAKE_CALL_LOG: join(root, 'call.json'), SHADOW_FAKE_CANCEL_LOG: join(root, 'cancel.json') } }, gate, undefined, { eof: 50, term: 50 })
  t.after(() => conn.disconnect())
  await conn.connect()
  return { conn, gate, root }
}

test('fake official stdio initialize, complete schema, text/structured content/image, normal completion remains usable', async t => {
  const { conn, gate } = await fixture(t)
  const tools = await conn.listTools()
  assert.deepEqual(tools[0].inputSchema, { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'], additionalProperties: false })
  const result = await conn.callTool('desktop', { mode: 'ok' })
  assert.notEqual(typeof result, 'string')
  if (typeof result === 'string') return
  assert.deepEqual(result.content, [
    { type: 'text', text: 'literal\\ntext' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n', detail: 'auto' } },
    { type: 'text', text: JSON.stringify({ structuredContent: { nested: { unchanged: true } } }) },
  ])
  assert.equal((await conn.callTool('desktop', { mode: 'error' }) as { isError: boolean }).isError, true)
  gate.assertReady() // A completed official failure is not an unknown outcome.
})

test('dispatched cancellation is not replayed; cleanup is bounded and device stays blocked', async t => {
  const { conn, gate, root } = await fixture(t)
  const signal = AbortSignal.timeout(100)
  await assert.rejects(conn.callTool('desktop', { mode: 'hang' }, signal), ToolOutcomeUnknownError)
  assert.throws(() => gate.assertReady(), /blocked/)
  const call = JSON.parse(await readFile(join(root, 'call.json'), 'utf8'))
  const cancellations = (await readFile(join(root, 'cancel.json'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(cancellations.some(cancelled => cancelled.requestId === call.id))
  await assert.rejects(conn.callTool('desktop', { mode: 'ok' }), /blocked/)
  await conn.disconnect()
})

test('device FIFO spans connections; cancelled waiters never run or release a preceding action', async () => {
  const gate = new DesktopDeviceGate()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const order: string[] = []
  const first = gate.run(new AbortController().signal, async () => { order.push('first'); await held })
  await new Promise(resolve => setImmediate(resolve))
  const cancel = new AbortController()
  const second = gate.run(cancel.signal, async () => { assert.fail('cancelled waiter dispatched') })
  cancel.abort(new Error('queued cancellation'))
  await assert.rejects(second, /queued cancellation/)
  const third = gate.run(new AbortController().signal, async () => { order.push('third') })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['first'])
  release(); await Promise.all([first, third])
  assert.deepEqual(order, ['first', 'third'])
})

function context(): ExecutionContext {
  const tools = new SessionTools(new Tools('/tmp'), '/tmp')
  tools.setExecutionScope('session', [])
  return { projectId: 'p', sessionId: 'web:test', channel: 'web', tools, signal: new AbortController().signal } as ExecutionContext
}
test('host local-device and role admission precede startup; binding cannot move to another conversation', () => {
  const source = managedDesktopSource('p', '/tmp', () => {}, true)
  const ctx = context()
  source.managed.authorize(ctx)
  assert.throws(() => source.managed.authorize({ ...ctx, sessionId: 'web:other' }), /binding mismatch/)
  assert.throws(() => source.managed.authorize({ ...context(), channel: 'telegram' }), /host-device authorization/)
  assert.throws(() => managedDesktopSource('p', '/tmp', () => {}, false).managed.authorize(context()), /host-device authorization/)
  const denied = context()
  denied.tools = new SessionTools(new Tools('/tmp'), '/tmp', ['read'])
  denied.tools.setExecutionScope('session', [])
  assert.throws(() => source.managed.authorize(denied), /role/)
})

for (const mode of ['crash', 'malformed']) test(`dispatched ${mode} blocks another queued connection without replay`, async t => {
  const gate = new DesktopDeviceGate()
  const a = await fixture(t, gate)
  const b = await fixture(t, gate)
  const original = McpConnection.prototype.callTool
  let bDispatches = 0
  t.mock.method(McpConnection.prototype, 'callTool', async function(this: McpConnection, ...args: Parameters<McpConnection['callTool']>) {
    if (this === b.conn) bDispatches++
    return original.apply(this, args)
  })
  const first = a.conn.callTool('desktop', { mode })
  const second = b.conn.callTool('desktop', { mode: 'ok' })
  await assert.rejects(first, ToolOutcomeUnknownError)
  await assert.rejects(second, /blocked/)
  assert.equal(bDispatches, 0)
})

test('authority revoked while queued is rechecked before dispatch without poisoning the device', async t => {
  const gate = new DesktopDeviceGate()
  const f = await fixture(t, gate)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const first = gate.run(new AbortController().signal, () => held)
  await new Promise(resolve => setImmediate(resolve))
  let authorized = true
  const original = McpConnection.prototype.callTool
  let dispatches = 0
  t.mock.method(McpConnection.prototype, 'callTool', async function(this: McpConnection, ...args: Parameters<McpConnection['callTool']>) {
    dispatches++
    return original.apply(this, args)
  })
  t.mock.method(f.conn, 'validateContext', () => { if (!authorized) throw new Error('device authority revoked') })
  const pending = f.conn.callToolInContext('desktop', { mode: 'ok' }, context())
  authorized = false
  release()
  await first
  await assert.rejects(pending, /authority revoked/)
  assert.equal(dispatches, 0)
  gate.assertReady()
})
