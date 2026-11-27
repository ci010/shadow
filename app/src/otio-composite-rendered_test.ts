import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { createServer } from 'vite'
import { pngFixture } from '../../src/testing/image.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const schema = (kind: string, fields = {}) => ({ OTIO_SCHEMA: `${kind}.1`, ...fields })
const time = (value: number) => schema('RationalTime', { value, rate: 24 })
const range = (start: number, duration: number) => schema('TimeRange', { start_time: time(start), duration: time(duration) })
const clip = (name: string, source: number, duration: number, url: string) => schema('Clip', {
  name, source_range: range(source, duration), media_reference: schema('ExternalReference', { target_url: url, available_range: range(source - 12, 144) }),
})
const track = (name: string, children: unknown[]) => schema('Track', { name, kind: 'Video', children })
const timeline = JSON.stringify(schema('Timeline', { name: 'Assembly', global_start_time: time(240), tracks: schema('Stack', { children: [
  track('Lower', [clip('Repeated', 48, 48, 'lower.png'), schema('Transition', { in_offset: time(4), out_offset: time(4), transition_type: 'SMPTE_Dissolve' }),
    clip('External', 12, 48, 'https://blocked.invalid/sentinel.png'), clip('Moonrise', 12, 96, 'moonrise.mp4'),
    schema('Gap', { source_range: range(0, 48) })]),
  track('Upper', [schema('Gap', { source_range: range(0, 24) }), clip('Repeated', 96, 24, 'upper.png')]),
  schema('Track', { name: 'A1', kind: 'Audio', children: [clip('Chime', 24, 96, 'tone.wav'),
    schema('Gap', { source_range: range(0, 24) }), clip('Repeat', 24, 48, 'tone.wav')] }),
  schema('Track', { name: 'A2', kind: 'Audio', children: [schema('Gap', { source_range: range(0, 144) }),
    clip('Other track', 24, 24, 'tone.wav')] }),
] }) }))
const legacyTimeline = JSON.stringify(schema('Timeline', { name: 'Legacy cut', tracks: schema('Stack', { children: [track('Video', [clip('Legacy source', 12, 96, 'moonrise.mp4')])] }) }))
const audioPath = 'cuts/tone.wav'
function waveFixture() {
  const rate = 8000, frames = 6 * rate
  const bytes = Buffer.alloc(44 + frames * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40)
  const events = [0.1, 0.75, 1.5, 2.25, 3, 3.75, 4.8] // First and last lie outside the visible trim.
  for (let i = 0; i < frames; i++) {
    const t = i / rate
    const event = events.findIndex(start => t >= start && t < start + 0.22)
    if (event < 0) continue
    const elapsed = t - events[event]
    const ring = 28500 * Math.exp(-elapsed * 10) * Math.sin(elapsed * 2 * Math.PI * (440 + event * 60))
    bytes.writeInt16LE(Math.round(ring), 44 + i * 2)
  }
  return bytes
}
const documentPath = 'cuts/assembly.OTIO'
const modified = '2026-01-01T00:00:00Z'
const images = { 'cuts/lower.png': pngFixture(240, 100), 'cuts/upper.png': pngFixture(180, 90) }

const entry = `import 'uno.css'; import '/src/styles.css';
import {createApp,h,ref,reactive} from 'vue';
import FilePreviewModal from '/src/components/files/FilePreviewModal.vue';
import {composeOtioReferenceMessage,createOtioDraftBridge,OtioDraftKey} from '/src/otio-draft.ts';
import {appendChatAttachments,imageAttachmentReference} from '/src/chat-attachments.ts';
window.fixtureVoices=[];
const NativeAudio=window.Audio;
window.Audio=function(){const voice=new NativeAudio();window.fixtureVoices.push(voice);return voice};
const apiBase=location.origin, active=ref(true), inline=ref(true), open=ref(true), closes=ref(0), canQuote=ref(true);
const pending=appendChatAttachments([], [new File(['existing pending image'], 'existing.png', {type:'image/png'})]);
const initialText='Existing note '+imageAttachmentReference(pending[0]);
const draft=reactive({key:'fixture-draft',label:'Fixture conversation',text:initialText,attachments:pending,canAttachFiles:true});
const references=reactive([]);
const bridge=createOtioDraftBridge(base=>base===apiBase?draft:null,reference=>references.push(reference));
window.fixture={draft,initialText,active,inline,closes,imageAttachmentReference,composeOtioReferenceMessage,references,canQuote};
const fileEntry={name:'assembly.OTIO',ext:'.otio',mtime:${JSON.stringify(modified)},size:${Buffer.byteLength(timeline)},type:'file'};
createApp({render:()=>h('main',{id:'workbench',style:{display:'flex',height:'calc(100dvh - 24px)',width:'calc(100dvw - 24px)',margin:'12px',minWidth:0,minHeight:0}},
  open.value?[h(FilePreviewModal,{apiBase,sessionId:'fixture',dir:'cuts',active:active.value,inline:inline.value,canQuote:canQuote.value,entry:fileEntry,
    onClose:()=>{closes.value++;open.value=false}})]:[])})
  .provide(OtioDraftKey,bridge).mount('#app');`

test('composite file preview reloads a verified sidecar, maps interval and never starts independent audio', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `otio-viewer-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const videoPath = 'cuts/moonrise.mp4'
  // Standalone fixture, generated with ffmpeg: -f lavfi -i testsrc2=size=96x54:rate=12:duration=5
  // -an -c:v libx264 -pix_fmt yuv420p -crf 30 -movflags +faststart
  const video = await readFile(new URL('./fixtures/otio-storyboard-motion.mp4', import.meta.url))
  const wave = waveFixture()
  const requests: { method?: string; route: string; path: string | null }[] = []
  let failNextFolderRead = false
  let admitPreview = false, legacy = false
  const server = await createServer({
    configFile: false, envDir: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', 'vue-i18n', '@vue-flow/core', 'dompurify', 'zod', 'markdown-exit', '@mdit/plugin-tasklist', '@mdit/plugin-katex', 'katex'] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
      name: 'otio-viewer-fixture', enforce: 'pre',
      resolveId(id) {
        if (id === '/otio-fixture.ts') return '\0otio-fixture'
        if (/\/open-file-viewer-sdk(?:\.ts)?$/.test(id)) return '\0unused-rich-file-sdk'
      },
      load(id) {
        if (id === '\0otio-fixture') return entry
        if (id === '\0unused-rich-file-sdk') return 'export function mountFileViewer(){throw Error("Unexpected rich file SDK use")}'
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url!, 'http://fixture')
          if (url.pathname === '/__otio') {
            res.setHeader('Content-Type', 'text/html')
            res.end(`<!doctype html><meta charset="utf-8"><div id="app"></div><script>window.fixtureErrors=[];addEventListener("error",e=>fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason)));</script><script type="module" src="/otio-fixture.ts"></script>`)
            return
          }
          if (url.pathname === '/__legacy') { legacy = true; res.end('ok'); return }
          if (url.pathname === '/__admit-preview') { admitPreview = true; res.end('ok'); return }
          if (url.pathname === '/__fail-next-folder-read') { failNextFolderRead = true; res.end('ok'); return }
          if (!url.pathname.includes('/api/')) return next()
          const path = url.searchParams.get('path')
          requests.push({ method: req.method, route: url.pathname, path })
          if (req.method === 'GET' && url.pathname === '/projects/review/api/folders/edit/raw') {
            if (path === 'assembly.OTIO') { res.end(legacy ? legacyTimeline : timeline); return }
            const png = images[`cuts/${path}` as keyof typeof images]
            if (png) { res.setHeader('Content-Type', 'image/png'); res.end(png); return }
          }
          if (req.method === 'GET' && (url.pathname === '/api/projects' || /^\/projects\/(review|other)\/api\//.test(url.pathname) || url.pathname.startsWith('/api/providers'))) {
            const json = (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
            if (url.pathname === '/api/projects') return json({ projects: [{ id: 'review', name: 'Review project', createdAt: '2026-01-01' }, { id: 'other', name: 'Other project', createdAt: '2026-01-01' }] })
            if (url.pathname === '/projects/other/api/folders') return json({ folders: [] })
            if (url.pathname.endsWith('/api/folders')) {
              if (failNextFolderRead) { failNextFolderRead = false; res.statusCode = 503; return json({ error: 'unavailable' }) }
              return setTimeout(() => json({ folders: [{ id: 'edit', name: 'Edit workspace', path: '/synthetic/edit', createdAt: '2026-01-01' }] }), 60)
            }
            if (url.pathname.endsWith('/folders/edit/files')) return json({ path: '', entries: [{ name: 'assembly.OTIO', type: 'file', ext: '.otio', size: Buffer.byteLength(timeline), mtime: modified }] })
            return json({ sessions: [], nodes: [], messages: [], tools: [], jobs: [], requests: [], models: [], providers: [], agent: { model: '' } })
          }
          if (req.method === 'GET' && url.pathname === '/api/sessions/fixture/raw') {
            if (path === `${documentPath}.preview.json` && admitPreview) { res.end(JSON.stringify({version:1,profileVersion:1,sourceSha256:createHash('sha256').update(timeline).digest('hex'),media:'../out/preview.MP4',start:1,end:3,rate:24,frames:48})); return }
            if (path === documentPath) { res.setHeader('Content-Type', 'application/json'); res.end(legacy ? legacyTimeline : timeline); return }
            if (path === videoPath || path === 'out/preview.MP4' || path === audioPath) {
              const media = path === audioPath ? wave : video
              res.setHeader('Content-Type', path === audioPath ? 'audio/wav' : 'video/mp4')
              res.setHeader('Accept-Ranges', 'bytes')
              const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
              if (range) {
                const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : media.length - 1, media.length - 1)
                res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${media.length}`, 'Content-Length': end + 1 - start })
                res.end(media.subarray(start, end + 1))
              } else { res.setHeader('Content-Length', media.length); res.end(media) }
              return
            }
            if (path && Object.hasOwn(images, path)) { res.setHeader('Content-Type', 'image/png'); res.end(images[path as keyof typeof images]); return }
          }
          res.statusCode = 403; res.end('Outside fixture scope')
        })
      },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, ws: false },
  })
  await server.listen()
  t.after(() => server.close())
  const url = new URL('__otio', server.resolvedUrls!.local[0])
  const main = resolve(directory, 'main.cjs')
  // Optional diagnostic, never a baseline or a prerequisite for the test.
  await writeFile(main, `
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.setPath('userData',${JSON.stringify(directory)});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
 const wait=async(fn)=>{for(let i=0;i<200;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,40))}throw Error('timeout '+await run(()=>document.body.innerText))};
 await win.loadURL(${JSON.stringify(url.href)});
 await wait(()=>document.body.innerText.includes('Generate a composite preview'));
 assert.equal(await run(()=>!!document.querySelector('.picture video,.picture img')),false);
 assert.equal(await run(()=>window.fixtureVoices.length),0);
 assert.equal(await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Storyboard').disabled),true);
 await run(()=>fetch('/__admit-preview'));
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reload preview').click());
 await wait(()=>document.querySelector('.otio-file')?.getAttribute('aria-busy')==='false' && !document.querySelector('.panel-bar[role=status]')?.textContent.includes('Generate a composite preview'));
 // Selection may inspect a source clip, but cannot leave composite mode.
 await run(()=>[...document.querySelectorAll('.outline-pane button')].find(b=>b.textContent.includes('Repeated'))?.click());
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Play preview').click());
 await wait(()=>!!document.querySelector('.picture video'));
 assert.equal(await run(()=>window.fixtureVoices.length),0);
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Pause playback').click());
 assert.equal(await run(()=>document.querySelector('.picture video').muted),true);
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Next frame').click());
 await wait(()=>{const video=document.querySelector('.picture video');const frame=Number(document.querySelector('.transport .readout').textContent.replace(/[^0-9]/g,''));return video && !video.seeking && Math.abs(video.currentTime-(frame/24-1))<0.015});
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Composite audio').click());
 await wait(()=>document.querySelector('.picture video')?.muted===false);
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reference selection').click());
 await wait(()=>window.fixture.references.length===1);
 assert.equal(await run(()=>window.fixture.references[0].text.includes('renderedPreview')),true);
 assert.equal(await run(()=>window.fixture.references[0].text.includes('sourceSha256')),true);
 const anchor=await run(()=>JSON.parse(window.fixture.references[0].text.split('\\n').slice(2,-1).join('\\n')));
 assert.equal(anchor.document.path,'cuts/assembly.OTIO');
 assert.equal(anchor.document.owner.session,'fixture');
 assert.equal(anchor.monitor.clip,null);
 assert.equal(anchor.monitor.renderedPreview.manifestPath,'cuts/assembly.OTIO.preview.json');
 assert.ok(anchor.element.pointer!==undefined);
 assert.equal(anchor.monitor.renderedPreview.mediaPath,'out/preview.MP4');
 await run(()=>{window.fixture.inline.value=false;window.fixture.canQuote.value=false});
 await wait(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reference selection').disabled);
 await run(()=>{window.fixture.inline.value=true;window.fixture.canQuote.value=true});
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Play preview').click());
 await wait(()=>!document.querySelector('.picture video'));
 assert.equal(await run(()=>window.fixtureVoices.length),0);
 assert.equal(await run(()=>!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Clip source')),false);
 await run(()=>window.fixture.active.value=false);
 await wait(()=>!document.querySelector('.picture video'));
 assert.equal(await run(()=>window.fixtureVoices.filter(v=>!v.paused).length),0);
 await run(()=>fetch('/__legacy'));
 await win.reload();
 await wait(()=>!!document.querySelector('.picture video'));
 assert.equal(await run(()=>document.body.innerText.includes('Composite preview')),false);
 // The ordinary one-video-track cut still supports clip source and Storyboard.
 await run(()=>[...document.querySelectorAll('.outline-pane button')].find(b=>b.textContent.includes('Legacy source'))?.click());
 await wait(()=>!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Clip source'));
 assert.equal(await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Storyboard').disabled),false);
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reference selection').click());
 await wait(()=>window.fixture.references.length===1);
 assert.equal(await run(()=>window.fixture.references[0].text.includes('Legacy source')),true);
 assert.equal(await run(()=>window.fixture.references[0].text.includes('renderedPreview')),false);
 assert.deepEqual(await run(()=>window.fixtureErrors),[]);
 console.log('COMPOSITE_OK');app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});`)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 60_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /COMPOSITE_OK/)
  assert.ok(requests.every(({ method }) => method === 'GET'))
  assert.ok(requests.some(r => r.path === `${documentPath}.preview.json`))
  assert.ok(requests.some(r => r.path === 'out/preview.MP4'))
})
