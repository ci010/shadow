import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeBotTool, type ExecuteBotToolOptions } from './tool-runtime.ts'
import { botFiles } from './sdk-test-fixture.ts'

function options(source: string, extra: Partial<ExecuteBotToolOptions> = {}): ExecuteBotToolOptions {
  return { files: botFiles(source), tool: 'custom_tool', args: { text: 'hello' }, signal: new AbortController().signal, allowedTools: ['custom_tool'], authorize: () => {}, ...extra }
}
const tool = (body: string) => `import {defineTool} from '@shadow/bot-sdk'; export default defineTool({async execute(args: {text:string}, ctx) { ${body} }});`

test('executes typed SDK tool and packaged helper; named export supported', async () => {
  const input = options(`import {defineTool} from '@shadow/bot-sdk'; import {upper} from './helper.ts'; export const custom = defineTool({ execute(args) { return upper(args.text) } });`)
  input.files['tools/helper.ts'] = 'export const upper = (text: string) => text.toUpperCase();'
  const config = JSON.parse(input.files['bot.json']!)
  config.tools[0].export = 'custom'
  input.files['bot.json'] = JSON.stringify(config)
  assert.equal(await executeBotTool(input), 'HELLO')
})

test('binding isolation, parameter validation and mandatory authorization precede execution', async () => {
  await assert.rejects(executeBotTool(options(tool('return 1'), { allowedTools: [] })), /not allowed/)
  await assert.rejects(executeBotTool(options(tool('return 1'), { args: { text: 1 } })))
  await assert.rejects(executeBotTool(options(tool('return 1'), { authorize: () => { throw new Error('revoked') } })), /revoked/)
  await assert.rejects(executeBotTool(options(tool('return 1'), { authorize: undefined as never })), /authorization/)
})

test('capability backed context works and rechecks authorization for each host call', async () => {
  let checks = 0
  const seen: unknown[] = []
  const result = await executeBotTool(options(tool(`
    const result = await ctx.services.call('lookup', {text: args.text});
    await ctx.channel.call('reply', {text: result});
    await ctx.storage.set('key', result);
    const stored = await ctx.storage.get('key');
    await ctx.storage.delete('key');
    await ctx.log.info('done');
    ctx.signal.throwIfAborted();
    return {stored, aborted:ctx.signal.aborted};
  `), {
    authorize: () => { checks++ },
    services: async (name, input) => { seen.push([name, input]); return 'found' },
    channel: async (name, input) => { seen.push([name, input]); return null },
    storage: async (name, input) => { seen.push([name, input]); return name === 'get' ? 'found' : null },
    log: async (level, message) => { seen.push([level, message]) },
  }))
  assert.deepEqual(result, {stored: 'found', aborted: false})
  assert.equal(checks, 8)
  assert.equal(seen.length, 6)
})

test('missing callbacks, invalid context inputs and revoked capability fail closed', async () => {
  await assert.rejects(executeBotTool(options(tool("return ctx.services.call('lookup', {})"))))
  let touched = false
  await assert.rejects(executeBotTool(options(tool("return ctx.storage.get('')"), { storage: async () => { touched = true; return null } })))
  assert.equal(touched, false)
  let checks = 0
  await assert.rejects(executeBotTool(options(tool("return ctx.services.call('lookup', {})"), { authorize: () => { if (++checks > 2) throw new Error('revoked') }, services: async () => { touched = true; return null } })))
  assert.equal(touched, false)
})

test('approved @shadow module works, undeclared imports and native APIs are denied', async () => {
  const files = botFiles(`import lookup from '@shadow/lookup'; export default {execute: args => lookup(args)}`, { allowedModules: ['@shadow/lookup'], tools: [{ name: 'custom_tool', description: 'lookup', parameters: {type: 'object'}, module: 'tools/main.ts', imports: ['@shadow/lookup'] }] })
  assert.deepEqual(await executeBotTool(options('', { files, callModule: async (name, input) => ({name, ...input}) })), {name: 'lookup', text: 'hello'})
  for (const source of [
    `import fs from 'node:fs'; export default {execute:()=>fs.readFileSync('/etc/passwd','utf8')}`,
    `import secret from '/etc/passwd'; export default {execute:()=>secret}`,
    `import secret from '../../outside.ts'; export default {execute:()=>secret}`,
    `import secret from '@shadow/unapproved'; export default {execute:()=>secret}`,
    `import bridge from '@shadow/bot-runtime'; export default {execute:()=>bridge({})}`,
    tool('return process.env'), tool('return fetch("https://example.com")'),
    tool('return Function("return process")()'),
    tool('return import("node:fs")'),
    tool('const name = args.text; return import(name)'),
  ]) await assert.rejects(executeBotTool(options(source)), source)
})

test('cancellation kills CPU loops and aborts in-flight host callbacks', async () => {
  const controller = new AbortController()
  const execution = executeBotTool(options(tool('while(true) {}'), { signal: controller.signal }))
  setTimeout(() => controller.abort(), 200)
  await assert.rejects(execution, /abort/i)
  const next = new AbortController()
  let callbackSignal: AbortSignal | undefined
  const running = executeBotTool(options(tool("return ctx.services.call('wait', {})"), {
    signal: next.signal,
    services: async (_name, _input, signal) => {
      callbackSignal = signal
      next.abort()
      return await new Promise(() => {})
    },
  }))
  await assert.rejects(running, /abort/i)
  assert.equal(callbackSignal?.aborted, true)
})

test('timeout and callback budgets are enforced', async () => {
  await assert.rejects(executeBotTool(options(tool('while(true) {}'), { timeoutMs: 200 })), /timed out/)
  await assert.rejects(executeBotTool(options(tool("await ctx.services.call('x',{}); return ctx.services.call('x',{})"), { maxCalls: 1, services: async () => null })))
})


test('adversarial constructor chains cannot recover host process from any exposed capability', async () => {
  const attempts = [
    'ctx.services.call',
    '(await ctx.services.call("lookup", {}))',
    '(await ctx.services.call("lookup", {})).nested',
    'ctx.services.call("lookup", {})',
    'ctx.services.call("lookup", {}).then',
    'ctx.log.info', 'ctx.log.info("test").then',
    'ctx.signal', 'ctx.signal.throwIfAborted',
  ]
  for (const expression of attempts) {
    const source = tool(`try { const exposed = ${expression}; const ctor = typeof exposed === 'function' ? exposed.constructor : exposed.constructor.constructor; const value = await ctor('return process.version')(); return {escaped:value}; } catch { return {blocked:true}; }`)
    assert.deepEqual(await executeBotTool(options(source, { services: async () => ({nested:{value:1}}), log: async () => {} })), {blocked:true}, expression)
  }
  // Rejected host errors are replaced with a fresh guest Error, never passed through.
  assert.deepEqual(await executeBotTool(options(tool(`try { await ctx.services.call('fail', {}); } catch (error) { try { return {escaped:error.constructor.constructor('return process.version')()}; } catch { return {blocked:true}; } }`), { services: async () => { throw new Error('host private diagnostic') } })), {blocked:true})
  // Static imports go through guest-realm adapters too, including namespace exports.
  const imports = ['lookup', 'lookup.call', 'lookup.fetch', 'lookup.default', 'lookup.default({}).then']
  for (const expression of imports) {
    const files = botFiles(`import * as lookup from '@shadow/lookup'; export default {async execute() { try {const exposed = ${expression}; const ctor = typeof exposed === 'function' ? exposed.constructor : exposed.constructor.constructor; return {escaped:await ctor('return process.version')()}; } catch {return {blocked:true};} }}`, { allowedModules: ['@shadow/lookup'], tools: [{name:'custom_tool',description:'test',parameters:{type:'object'},module:'tools/main.ts',imports:['@shadow/lookup']}] })
    assert.deepEqual(await executeBotTool(options('', {files, callModule: async () => ({value:1})})), {blocked:true}, expression)
  }
})


test('all native module loading routes fail, even pure builtins and re-exports', async () => {
  for (const source of [
    `import {join} from 'node:path'; export default {execute:()=>join('a','b')}`,
    `import {join} from 'path'; export default {execute:()=>join('a','b')}`,
    `export {default} from 'node:path'`,
    `export * from 'node:fs'`,
    `import fs = require('node:fs'); export default {execute:()=>fs}`, 
    `const fs = require('node:fs'); export default {execute:()=>fs}`,
    tool(`return import('node:path')`),
    tool(`return import('@shadow/bot-runtime')`),
    `import x from 'data:text/javascript,export default 1'; export default {execute:()=>x}`,
    `import x from 'file:///etc/passwd'; export default {execute:()=>x}`,
  ]) await assert.rejects(executeBotTool(options(source)), source)
  const files = botFiles(tool('return 1'), {allowedModules:['node:path']})
  await assert.rejects(executeBotTool(options('', {files})))
})

test('host inputs are finite plain JSON, hard execution limits cannot be increased', async () => {
  let accessed = false
  const args = {get text() { accessed = true; return 'hello' }}
  await assert.rejects(executeBotTool(options(tool('return 1'), {args})))
  assert.equal(accessed, false)
  await assert.rejects(executeBotTool(options(tool('return 1'), {timeoutMs:60_001})))
  await assert.rejects(executeBotTool(options(tool('return 1'), {maxCalls:129})))
})


test('completion thenables cannot expose host resolver constructors', async () => {
  const source = tool(`return { then(resolve) { try { resolve({escaped:resolve.constructor('return process.version')()}); } catch { resolve({blocked:true}); } } };`)
  assert.deepEqual(await executeBotTool(options(source)), {blocked:true})
})

test('poisoned guest Promise.then cannot capture host completion callbacks', async () => {
  const source = tool(`
    const result = {blocked:true};
    const original = Promise.prototype.then;
    Promise.prototype.then = function(resolve, reject) {
      try { result.escaped = resolve.constructor('return process.version')(); } catch {}
      return original.call(this, resolve, reject);
    };
    return result;
  `)
  assert.deepEqual(await executeBotTool(options(source)), {blocked:true})
})

test('defineTool supports description/schema metadata and rejects declarations different from approved config',async()=>{
  const input=options('')
  const declaration=JSON.parse(input.files['bot.json']!).tools[0]
  input.files['tools/main.ts']=`import {defineTool} from '@shadow/bot-sdk'; export default defineTool({description:${JSON.stringify(declaration.description)},parameters:${JSON.stringify(declaration.parameters)},execute:args=>args.text});`
  assert.equal(await executeBotTool(input),'hello')
  input.files['tools/main.ts']=`import {defineTool} from '@shadow/bot-sdk'; export default defineTool({description:'unapproved',execute:()=>true});`
  await assert.rejects(executeBotTool(input),/guest_failed/)
})
