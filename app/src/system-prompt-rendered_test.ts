import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { createServer } from 'vite'

// Exercise the component's actual rendering functions with real Marked, KaTeX,
// DOMPurify and a browser DOM, rather than substituting a sanitizer mock.
test('system prompt treats HTML as text without losing the tail or generated formatting', { timeout: 90_000 }, async t => {
  const source = readFileSync(new URL('./components/SystemPromptCard.vue', import.meta.url), 'utf8')
  const rendering = source.slice(source.indexOf('// Prompt HTML'), source.indexOf('const props ='))
    + source.slice(source.indexOf('function preprocessCustomXml'), source.indexOf('const rendered ='))
  const js = ts.transpileModule(rendering, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const script = `import { Marked } from '/node_modules/marked/lib/marked.esm.js';
import DOMPurify from '/node_modules/dompurify/dist/purify.es.mjs';
import katex from '/node_modules/katex/dist/katex.mjs';
const mobileResources = {html: s => s};
${js}
const check = (ok, message) => {if (!ok) throw Error(message)};
try {
const box = document.createElement('div'); document.body.append(box);
const tail = '\\n\\n## Current environment\\n\\n**Working directory**: C:/fixture';
for (const example of ['Visual fragments are sanitized: isolated <style>', '<style>body { display:none }', '<div onclick="window.executed=true">HTML example</div>\\n<script>window.executed=true</script>', '<img src=x onerror="window.executed=true">', '<sub>raw sub</sub>']) {
  box.innerHTML = renderMarkdown(example + tail);
  check(box.textContent.includes('Working directory') && box.textContent.includes('C:/fixture'), 'tail swallowed: ' + example);
  check(box.textContent.includes(example), 'HTML example not literal: ' + example);
  check(!box.querySelector('style,script,img,sub,[onclick],[onerror]'), 'raw HTML became DOM');
  check(box.querySelector('h2')?.textContent === 'Current environment', 'tail Markdown lost');
  check(box.querySelector('strong')?.textContent === 'Working directory', 'bold lost');
}
box.innerHTML = renderMarkdown('~~~html\\n<style>code</style>\\n~~~\\n\\ninline \`<script>example</script>\`');
check(box.querySelector('pre code')?.textContent.includes('<style>code</style>'), 'fenced code changed');
check(box.textContent.includes('<script>example</script>'), 'inline code changed');
box.innerHTML = renderMarkdown('<available_skills>\\n<skill name="demo">Description</skill>\\n<category name="tools" count="2" skills="one, <style>">Category</category>\\n</available_skills>\\n\\n<available_agent_types><agent_type name="explore">Read only</agent_type></available_agent_types>\\n\\nInline $x^2$ and display $$x+1$$' + tail);
check(box.textContent.includes('Available Skills') && box.textContent.includes('Available Agent Types'), 'XML preprocessing lost');
check(box.querySelector('sub')?.textContent === 'one, <style>', 'generated sub lost or content interpreted');
check(!box.querySelector('style,script'), 'category HTML escaped boundary');
check(box.querySelector('.katex') && box.querySelector('.katex-display') && box.querySelector('math'), 'KaTeX lost');
check(!window.executed, 'HTML executed');
window.result = 'SYSTEM_PROMPT_OK';
} catch(e) { window.result = e.stack; }
`
  const server = await createServer({ root: resolve('app'), configFile: false, optimizeDeps: { noDiscovery: true }, plugins: [{ name: 'prompt-test', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === '/prompt-test.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(script); return }
      if (req.url !== '/prompt-test') return next()
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script type="module" src="/prompt-test.js"></script>')
    })
  } }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => server.close())
  const directory = await mkdtemp(resolve(tmpdir(), 'shadow-prompt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const main = `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{try{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true}});await w.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'prompt-test')});let result;for(let i=0;i<100;i++){result=await w.webContents.executeJavaScript('window.result');if(result)break;await new Promise(r=>setTimeout(r,50));}if(result!=='SYSTEM_PROMPT_OK')throw Error(result||'timeout');console.log(result);app.exit(0)}catch(e){console.error(e);app.exit(1)}});`
  await writeFile(resolve(directory, 'main.cjs'), main)
  const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(desktopRequire('electron'), [resolve(directory, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', c => { output += c }); child.stderr.on('data', c => { output += c })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output); assert.match(output, /SYSTEM_PROMPT_OK/)
})
