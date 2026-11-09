import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeGrantedScript } from './granted-script.ts'

const run = (body: string, args: Record<string, unknown> = {}) => executeGrantedScript({
  code: `import {parseHtml} from '@shadow/html'; export function run(args) { ${body} }`,
  args, mode: 'test', imports: ['@shadow/html'], allowedModules: ['@shadow/html'],
  signal: new AbortController().signal,
  callModule: async () => { throw new Error('Pure parser must never call host') },
})

test('real child parses malformed HTML, entities, selectors and detached read-only wrappers', async () => {
  assert.deepEqual(await run(`
    const doc = parseHtml('<article><a href="/x?a=1&amp;b=2">A &amp; B<b>!</article><script>danger()</script><style>.x{}</style>');
    const a = doc.querySelector('article > a[href]');
    return {text:a.textContent, attr:a.getAttribute('href'), absent:a.getAttribute('missing'),
      child:a.querySelector('b').textContent, missing:doc.querySelector('.missing'),
      count:doc.querySelectorAll('a, script').length, script:doc.querySelector('script').textContent,
      style:doc.querySelector('style').textContent, frozen:Object.isFrozen(a), proto:Object.getPrototypeOf(a),
      hidden:['attr','html','load','root','constructor'].every(key => a[key] === undefined),
      fragment:a.getHtml(), globals:[typeof process,typeof fetch,typeof require]};
  `), {text:'A & B!',attr:'/x?a=1&b=2',absent:null,child:'!',missing:null,count:2,script:'danger()',style:'.x{}',frozen:true,proto:null,hidden:true,fragment:'<a href="/x?a=1&amp;b=2">A &amp; B<b>!</b></a>',globals:['undefined','undefined','undefined']})
})

test('parser bounds and errors are deterministic guest errors', async () => {
  for (const [expression, prefix] of [
    ["parseHtml('x'.repeat(1048577))", 'HTML_INPUT_LIMIT'],
    ["parseHtml('é'.repeat(524289))", 'HTML_INPUT_LIMIT'],
    ["parseHtml('').querySelector('a'.repeat(1025))", 'HTML_SELECTOR_LIMIT'],
    ["parseHtml('').querySelector('[')", 'HTML_SELECTOR'],
    ["parseHtml('').querySelector('<img src=x>')", 'HTML_SELECTOR'],
    ["parseHtml('<i></i>'.repeat(257)).querySelectorAll('i')", 'HTML_NODE_LIMIT'],
    ["parseHtml('<div>'+'x'.repeat(65536)+'</div>').querySelector('div').getHtml()", 'HTML_FRAGMENT_LIMIT'],
  ]) assert.equal(await run(`try { ${expression}; return false } catch(e) { return e.message.split(':')[0] }`), prefix)
  assert.equal(await run(`return parseHtml('<i></i>'.repeat(300)).querySelector('i').textContent`), '')
})

test('guest functions cannot escape to host constructors; imports remain denied', async () => {
  assert.equal(await run(`try { parseHtml.constructor('return process')(); return false } catch { return true }`), true)
  await assert.rejects(run(`return import('node:fs')`), /import|Import/)
  await assert.rejects(run(`return import('cheerio')`), /import|Import/)
  await assert.rejects(run(`return import('@shadow/fetch')`), /import|Import/)
})

test('relocated compiled child uses the self-contained production HTML bundle', async () => {
  const { build } = await import('esbuild')
  const { withTempWorkspace } = await import('../testing/workspace.ts')
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { pathToFileURL, fileURLToPath } = await import('node:url')
  await withTempWorkspace(async directory => {
    await writeFile(join(directory, 'package.json'), '{"type":"module"}')
    const source = fileURLToPath(new URL('.', import.meta.url))
    for (const name of ['runtime', 'worker']) await build({
      entryPoints: [join(source, name + '.ts')], outfile: join(directory, name + '.js'),
      bundle: true, platform: 'node', format: 'esm', packages: 'external',
    })
    const bundle = await build({
      entryPoints: [join(source, 'html-module.ts')], outfile: join(directory, 'html-module.bundle.js'),
      inject: [join(source, 'html-base64.ts')], bundle: true, platform: 'browser', format: 'esm', metafile: true,
    })
    assert.deepEqual(Object.values(bundle.metafile!.outputs).flatMap(output => output.imports), [])
    const { executeScript } = await import(pathToFileURL(join(directory, 'runtime.js')).href)
    const result = await executeScript({
      code: `import {parseHtml} from '@shadow/html';export function run(){return parseHtml('<p>compiled &amp; local</p>').querySelector('p').textContent}`,
      args: {}, entry: 'run', policy: {kind:'restricted', imports:['@shadow/html'], mode:'test'},
      signal: new AbortController().signal, maxCalls: 0,
    })
    assert.equal(result.value, 'compiled & local')
  })
})

test('HTML scripts retain child deadlines and cancellation', async () => {
  const { executeScript } = await import('./runtime.ts')
  const options = {
    code: `import {parseHtml} from '@shadow/html';export function run(){parseHtml('<p>ok</p>').querySelector('p');while(true){}}`,
    args: {}, entry: 'run' as const, policy: {kind:'restricted' as const, imports:['@shadow/html']},
  }
  await assert.rejects(executeScript({...options, signal:new AbortController().signal, timeoutMs:750}), /deadline/)
  const controller = new AbortController()
  const execution = executeScript({...options, signal:controller.signal})
  const timer = setTimeout(()=>controller.abort(), 500)
  try { await assert.rejects(execution, /aborted/) } finally { clearTimeout(timer) }
})
