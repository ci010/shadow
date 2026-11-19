import assert from 'node:assert/strict'
import test from 'node:test'
import { DesktopStdioTransport } from './transport.ts'

function environment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

test('EOF is bounded, stubborn direct child is terminated, pending dispatch blocks, close is idempotent', { timeout: 5000 }, async () => {
  const reasons: string[] = []
  // Inert server intentionally drains forever after EOF and ignores Unix TERM.
  const script = `process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);console.log(JSON.stringify({jsonrpc:'2.0',method:'ready'}));`
  const transport = new DesktopStdioTransport(process.execPath, ['-e', script], environment(), reason => reasons.push(reason), { eof: 30, term: 30 })
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  let closes = 0
  transport.onmessage = () => ready()
  transport.onclose = () => { closes++ }
  await transport.start()
  await started
  await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fake' } })
  const before = Date.now()
  const closing = transport.close()
  assert.equal(transport.close(), closing)
  await closing
  assert.ok(Date.now() - before < 2000)
  assert.equal(closes, 1)
  assert.ok(reasons.some(reason => reason.includes('dispatched')))
})

test('normal complete response plus EOF never reports uncertainty', async () => {
  const reasons: string[] = []
  const script = `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[]}}))});`
  const transport = new DesktopStdioTransport(process.execPath, ['-e', script], environment(), reason => reasons.push(reason))
  let received!: () => void
  const response = new Promise<void>(resolve => { received = resolve })
  transport.onmessage = () => received()
  await transport.start()
  await transport.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fake' } })
  await response
  await transport.close()
  assert.deepEqual(reasons, [])
})

test('startup ENOENT is bounded and does not fabricate a dispatched desktop action', async () => {
  const reasons: string[] = []
  const transport = new DesktopStdioTransport('/missing-shadow-mcp-fixture', [], environment(), reason => reasons.push(reason), { eof: 10, term: 10 })
  await assert.rejects(transport.start(), /ENOENT/)
  await transport.close()
  assert.equal(transport.dispatched, 0)
  assert.deepEqual(reasons, [])
})

test('disconnect without caller abort sends official request-id cancellation before EOF', async () => {
  const messages: unknown[] = []
  const script = `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.method==='notifications/cancelled')console.log(JSON.stringify({jsonrpc:'2.0',method:'saw-cancel',params:m.params}))});`
  const transport = new DesktopStdioTransport(process.execPath, ['-e', script], environment(), () => {})
  transport.onmessage = message => messages.push(message)
  await transport.start()
  await transport.send({ jsonrpc: '2.0', id: 123, method: 'tools/call', params: { name: 'fake' } })
  await transport.close()
  assert.ok(messages.some(message => typeof message === 'object' && message !== null && 'params' in message && (message.params as { requestId: number }).requestId === 123))
})

test('completed call with an inherited pipe holder does not poison the desktop or kill that process', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const reasons: string[] = []
  // Inert, self-expiring process models a user application's retained pipe, not
  // a desktop application. It is intentionally not a cancellation rollback target.
  const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},500)'],{detached:true,stdio:['ignore',1,2]});c.unref();const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[]}}))});r.on('close',()=>process.exit(0));`
  const transport = new DesktopStdioTransport(process.execPath, ['-e', script], environment(), reason => reasons.push(reason))
  let received!: () => void
  const response = new Promise<void>(resolve => { received = resolve })
  transport.onmessage = () => received()
  await transport.start()
  await transport.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'fake' } })
  await response
  const before = Date.now()
  await transport.close()
  assert.ok(Date.now() - before < 400)
  assert.deepEqual(reasons, [])
})
