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
const apiBase=location.origin, active=ref(true), inline=ref(true), open=ref(true), closes=ref(0);
const pending=appendChatAttachments([], [new File(['existing pending image'], 'existing.png', {type:'image/png'})]);
const initialText='Existing note '+imageAttachmentReference(pending[0]);
const draft=reactive({key:'fixture-draft',label:'Fixture conversation',text:initialText,attachments:pending,canAttachFiles:true});
const references=reactive([]);
const bridge=createOtioDraftBridge(base=>base===apiBase?draft:null,reference=>references.push(reference));
window.fixture={draft,initialText,active,inline,closes,imageAttachmentReference,composeOtioReferenceMessage,references};
const fileEntry={name:'assembly.OTIO',ext:'.otio',mtime:${JSON.stringify(modified)},size:${Buffer.byteLength(timeline)},type:'file'};
createApp({render:()=>h('main',{id:'workbench',style:{display:'flex',height:'calc(100dvh - 24px)',width:'calc(100dvw - 24px)',margin:'12px',minWidth:0,minHeight:0}},
  open.value?[h(FilePreviewModal,{apiBase,sessionId:'fixture',dir:'cuts',active:active.value,inline:inline.value,canQuote:true,entry:fileEntry,
    onClose:()=>{closes.value++;open.value=false}})]:[])})
  .provide(OtioDraftKey,bridge).mount('#app');`

test('OTIO file preview renders storyboards and stages reviews without writing the timeline', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `otio-viewer-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const videoPath = 'cuts/moonrise.mp4'
  const video = await readFile(resolve(root, 'examples/otio-first-cut/media/moonrise.mp4'))
  const wave = waveFixture()
  const requests: { method?: string; route: string; path: string | null }[] = []
  const server = await createServer({
    configFile: false, envDir: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', 'vue-i18n', 'dompurify', 'zod', 'markdown-exit', '@mdit/plugin-tasklist', '@mdit/plugin-katex', 'katex'] },
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
            res.end('<!doctype html><meta charset="utf-8"><div id="app"></div><script>window.fixtureErrors=[];addEventListener("error",e=>fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason)));</script><script type="module" src="/otio-fixture.ts"></script>')
            return
          }
          if (!url.pathname.includes('/api/')) return next()
          const path = url.searchParams.get('path')
          requests.push({ method: req.method, route: url.pathname, path })
          if (req.method === 'GET' && url.pathname === '/api/sessions/fixture/raw') {
            if (path === documentPath) { res.setHeader('Content-Type', 'application/json'); res.end(timeline); return }
            if (path === videoPath || path === audioPath) {
              const media = path === videoPath ? video : wave
              res.setHeader('Content-Type', path === videoPath ? 'video/mp4' : 'audio/wav')
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
  const screenshot = process.env.OTIO_VIEWER_TEST_SCREENSHOT
  const desktopScreenshot = process.env.OTIO_VIEWER_TEST_DESKTOP_SCREENSHOT
  await writeFile(main, `
const {app,BrowserWindow,Menu}=require('electron');
const assert=require('node:assert/strict');
const {writeFileSync}=require('node:fs');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.setPath('userData',${JSON.stringify(directory)});
app.whenReady().then(async()=>{
  Menu.setApplicationMenu(null);
  const win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  const external=[];
  win.webContents.session.webRequest.onBeforeRequest((request,done)=>{
    const allowed=request.url.startsWith(${JSON.stringify(url.origin + '/')}) || /^(blob:|data:)/.test(request.url);
    // Vite's injected dev client can probe loopback for HMR even when disabled.
    // Cancel those probes too, but do not count them as OTIO external media.
    if(!allowed && !(request.resourceType==='webSocket' && new URL(request.url).hostname==='127.0.0.1'))external.push(request.url);
    done({cancel:!allowed});
  });
  const run=(fn,...args)=>win.webContents.executeJavaScript('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  const wait=async(label,fn,...args)=>{
    for(let i=0;i<200;i++){
      const value=await run(fn,...args); if(value)return value;
      await new Promise(r=>setTimeout(r,50));
    }
    throw Error('Timed out: '+label+' '+JSON.stringify(await run(()=>({errors:window.fixtureErrors,body:document.body.innerText}))));
  };
  const click=async(label,scope='body')=>assert.ok(await run((label,scope)=>{
    const target=[...document.querySelectorAll(scope+' button')].find(e=>e.getClientRects().length && (e.getAttribute('aria-label')===label || e.textContent.trim()===label));
    if(!target||target.disabled)return false; target.click();return true;
  },label,scope),'enabled visible button: '+label);
  const state=()=>run(()=>{
    const {draft,initialText,imageAttachmentReference,composeOtioReferenceMessage,references}=window.fixture;
    const text=composeOtioReferenceMessage(draft.text,references), attachments=[...draft.attachments,...references.flatMap(r=>r.attachment?[r.attachment]:[])];
    return {text,editorText:draft.text,initialText,labels:references.map(r=>r.label),records:[...text.matchAll(/^\x60\x60\x60json\\n([^\\n]+)\\n\x60\x60\x60$/gm)].map(match=>JSON.parse(match[1])),
      refs:attachments.map(imageAttachmentReference),keys:attachments.map(a=>a.key)};
  });
  const layout=async(...selectors)=>{
    const result=await run(selectors=>{
      const workbench=document.querySelector('#workbench'), viewer=document.querySelector('.otio');
      const rect=e=>{const {left,right,top,bottom,width,height}=e.getBoundingClientRect();return {left,right,top,bottom,width,height}};
      return {workbench:rect(workbench),viewer:rect(viewer),spill:[workbench,viewer,viewer.querySelector('.bench')].map(e=>e.scrollWidth-e.clientWidth),
        panes:selectors.map(selector=>rect(viewer.querySelector(selector)))};
    },selectors);
    const inside=(inner,outer)=>inner.width>0&&inner.height>0&&inner.left>=outer.left-1&&inner.right<=outer.right+1&&inner.top>=outer.top-1&&inner.bottom<=outer.bottom+1;
    assert.ok(inside(result.viewer,result.workbench),JSON.stringify(result));
    assert.ok(result.spill.every(p=>p<=1),JSON.stringify(result));
    for(const pane of result.panes)assert.ok(inside(pane,result.viewer),JSON.stringify(result));
    return result.panes;
  };
  await win.loadURL(${JSON.stringify(url.href)});
  await wait('timeline and lower still',()=>document.querySelector('.mark-action:enabled') && document.querySelector('.picture img')?.naturalWidth===240);
  const renderedWave = await wait('real WAV peaks painted inside all three audio clips',()=>{
    const wave=document.querySelector('[aria-label="Clip: Chime"] svg.waveform');
    if(!wave || document.querySelectorAll('.block .waveform').length!==3)return;
    const bins=wave.viewBox.baseVal.width, path=wave.querySelector('path');
    const points=Array.from(path.getAttribute('d').matchAll(/M([\\d.]+) [\\d.]+v([\\d.]+)/g),m=>[Number(m[1])/bins, Number(m[2])]);
    const box=wave.getBoundingClientRect(), label=wave.previousElementSibling.getBoundingClientRect();
    return {points, gap:!!document.querySelector('.gap .waveform'), width:box.width, height:box.height, clearsLabel:box.top>=label.bottom};
  });
  assert.ok(renderedWave.width>0 && renderedWave.height>0 && renderedWave.clearsLabel);
  assert.equal(renderedWave.gap,false);
  const starts=[.0625,.25,.4375,.625,.8125];
  for(const start of starts)assert.ok(renderedWave.points.some(([x,h])=>x>=start-.005&&x<start+.025&&h>14));
  assert.ok(renderedWave.points.every(([x])=>starts.some(start=>x>=start-.005&&x<start+.061)), JSON.stringify(renderedWave));
  for(const scheme of ['light','dark']){
    const colors=await run(scheme=>{
      document.documentElement.classList.toggle('dark',scheme==='dark');
      const lanes=[...document.querySelectorAll('.lane-row[data-kind]')].slice(0,3);
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const cx=canvas.getContext('2d',{willReadFrequently:true});
      const luminance=color=>{
        cx.clearRect(0,0,1,1);cx.fillStyle=color;cx.fillRect(0,0,1,1);
        const rgb=[...cx.getImageData(0,0,1,1).data].slice(0,3).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);
        return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
      };
      const ratio=(a,b)=>{const values=[luminance(a),luminance(b)];return (Math.max(...values)+.05)/(Math.min(...values)+.05)};
      return lanes.map(lane=>{
        const row=getComputedStyle(lane), label=getComputedStyle(lane.querySelector('.lane-label'));
        const clip=getComputedStyle(lane.querySelector('.block.clip'));
        return [row.backgroundColor,clip.backgroundColor,ratio(row.backgroundColor,label.color),ratio(clip.backgroundColor,clip.color)];
      });
    },scheme);
    assert.equal(new Set(colors.map(c=>c[0])).size,3,JSON.stringify(colors));
    assert.equal(new Set(colors.map(c=>c[1])).size,3,JSON.stringify(colors));
    assert.ok(colors.every(c=>c[2]>=4.5&&c[3]>=4.5),JSON.stringify(colors));
  }
  await run(()=>{document.documentElement.classList.remove('dark')});
  assert.equal(await run(()=>window.fixtureVoices.length),0,'waveform must not create playback elements');
  assert.equal(await run(()=>performance.getEntriesByType('resource').filter(entry=>entry.initiatorType==='fetch' && new URL(entry.name).searchParams.get('path')==='cuts/tone.wav').length),1,
    'three clips sharing a WAV use one request');
  await click('Play preview');
  const first=await wait('real WAV plays from trimmed offset',()=>{
    const v=window.fixtureVoices[0];return v?.duration===6 && !v.paused && v.currentTime>=0.5 && v.currentTime<1.6 && v.currentTime;
  });
  await wait('native audio clock advances', first=>window.fixtureVoices[0].currentTime>first+0.12, first);
  await click('Mute audio track: A1');
  await wait('muted track releases media',()=>window.fixtureVoices[0].paused && !window.fixtureVoices[0].hasAttribute('src'));
  assert.ok(await run(()=>{
    const clip=document.querySelector('[aria-label="Clip: Chime"]');
    return clip.closest('.lane-row').classList.contains('excluded') && getComputedStyle(clip).borderStyle==='dashed' && !!clip.querySelector('.waveform path');
  }));
  await click('Mute audio track: A1');
  await wait('unmuted track resumes',()=>window.fixtureVoices[1]?.readyState>=2 && !window.fixtureVoices[1].paused);
  for(const key of ['Home','PageUp','PageUp']) await run(key=>{document.querySelector('.ruler').dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));},key);
  await wait('seek pauses and releases prior media',()=>window.fixtureVoices[1].paused && !window.fixtureVoices[1].hasAttribute('src') && document.querySelector('.transport .readout').textContent==='Frame 48');
  await click('Play preview');
  await wait('seek restarts WAV at source offset',()=>{const v=window.fixtureVoices[2];return v?.readyState>=2 && !v.paused && v.currentTime>=2.5 && v.currentTime<3.6});
  await click('Pause playback');
  await wait('pause releases media',()=>window.fixtureVoices[2].paused && !window.fixtureVoices[2].hasAttribute('src'));
  await win.reload();
  await wait('restored initial monitor',()=>document.querySelector('.picture img')?.naturalWidth===240);
  assert.equal(await run(()=>document.querySelector('.compact-tabs').getClientRects().length),0);
  assert.equal(await run(()=>document.querySelector('.file-modal').getAttribute('role')),'region');
  const [monitor,tracks,inspector]=await layout('.monitor-pane','.tracks-pane','.inspector');
  assert.ok(monitor.right<=inspector.left+1 && monitor.bottom<=tracks.top+1 && inspector.bottom<=tracks.top+1);
  assert.ok(await run(()=>{
    const limits=document.querySelector('.inspector details.limits'), actions=document.querySelector('.reference-actions');
    return limits && !limits.open && limits.nextElementSibling===actions &&
      document.querySelectorAll('.reference-actions').length===1 && actions.querySelectorAll('button').length===2;
  }), 'both actions follow the collapsed Preview limits in the inspector');
  if(${JSON.stringify(desktopScreenshot || '')}) writeFileSync(${JSON.stringify(desktopScreenshot || '')},(await win.webContents.capturePage()).toPNG(),{flag:'wx'});
  await click('Storyboard','.viewer-modes');
  const [board,boardTracks,boardInspector]=await layout('.storyboard-pane','.tracks-pane','.inspector');
  assert.ok(board.left<=monitor.left && board.right<=boardInspector.left+1 && board.bottom<=boardTracks.top+1);
  await wait('decoded storyboard still and video pixels',()=>{
    const cards=[...document.querySelectorAll('.storyboard .card')];
    const pixels=card=>card?.querySelector('[data-state=ready] canvas')?.getContext('2d').getImageData(160,90,1,1).data;
    return cards.length===4 && pixels(cards[0])?.[3]===255 && pixels(cards[3])?.[3]===255;
  });
  const setSampling=interval=>run(interval=>{
    const select=document.querySelectorAll('.storyboard select')[1];select.selectedIndex=interval?1:0;select.dispatchEvent(new Event('change'));
  },interval);
  await setSampling(true);
  await wait('interval ordering and labeled gap',()=>{
    const board=document.querySelector('.storyboard');
    return [...board.querySelectorAll('time')].map(e=>e.textContent).join(',')==='0 s,2 s,4 s,6 s,8 s' && board.querySelector('.card:last-child').textContent.includes('No picture / gap');
  });
  assert.equal(await run(()=>[...document.querySelectorAll('.card')].filter(e=>e.textContent.includes('Moonrise')).reduce((n,e)=>n+e.querySelectorAll('.caption-action').length,0)),1);
  const fill=async text=>run(text=>{
    const field=document.querySelector('.description-editor textarea'); field.value=text; field.dispatchEvent(new Event('input'));
  },text);
  await click('Add description','.card:nth-child(3)');
  await fill('Moonrise <b>wide</b>');
  await run(()=>{const save=Storage.prototype.setItem; Storage.prototype.setItem=function(key,value){if(key.startsWith('shadow:otio-description:'))throw new DOMException('Full','QuotaExceededError');return save.call(this,key,value)};window.restoreStorage=()=>{Storage.prototype.setItem=save}});
  await click('Save','.description-editor');
  assert.ok(await run(()=>document.querySelector('.description-editor [role=alert]').textContent.includes('could not be saved')));
  await run(()=>window.restoreStorage());
  await click('Save','.description-editor');
  assert.deepEqual(await run(()=>[...document.querySelectorAll('.caption')].map(e=>[e.textContent,e.children.length])),[['Moonrise <b>wide</b>',0]]);
  await run(()=>document.querySelector('.storyboard input[type=checkbox]').click());
  assert.deepEqual(await run(()=>[...document.querySelectorAll('.storyboard time')].map(e=>e.textContent)),['0 s','2 s']);
  assert.equal((await state()).records.length,0);
  await win.reload();
  await wait('reloaded monitor',()=>document.querySelector('.picture img')?.naturalWidth===240);
  await click('Storyboard','.viewer-modes');
  assert.equal(await run(()=>document.querySelector('.caption').textContent),'Moonrise <b>wide</b>');
  await click('Edit description','.card:nth-child(4)');
  assert.equal(await run(()=>document.querySelector('.description-editor textarea').value),'Moonrise <b>wide</b>');
  await fill('Moonrise wide'); await click('Save','.description-editor');
  await run(()=>document.querySelector('.card:nth-child(2) .sample').click());
  assert.equal(await run(()=>document.querySelector('.card:nth-child(2) .sample').getAttribute('aria-current')),'true');
  await run(()=>document.querySelector('.card:nth-child(2) .sample').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
  await wait('card opens monitor at exact selected shot',()=>document.querySelector('.picture img')?.naturalWidth===180 && document.querySelector('.transport .readout').textContent==='Frame 24');
  await run(()=>document.querySelectorAll('.outline .row')[2].click());
  await click('Storyboard','.viewer-modes');
  await run(()=>{const source=document.querySelector('.storyboard select');source.selectedIndex=1;source.dispatchEvent(new Event('change'))});
  assert.equal(await run(()=>document.querySelectorAll('.storyboard .card').length),3);
  win.setSize(420,820);
  await wait('narrow storyboard tabs',()=>!!document.querySelector('.compact-tabs').getClientRects().length);
  await layout('.storyboard-pane','.tracks-pane');
  await click('Selection','.compact-tabs');
  await layout('.inspector','.tracks-pane');
  await click('Storyboard','.compact-tabs');
  await click('Monitor','.viewer-modes');
  win.setSize(1180,850);
  await wait('desktop monitor restored',()=>!document.querySelector('.compact-tabs').getClientRects().length);
  const initial=await state();
  const baseDocument={path:${JSON.stringify(documentPath)},owner:{session:'fixture',space:'workdir'},modified:${JSON.stringify(modified)},sha256:${JSON.stringify(createHash('sha256').update(timeline).digest('hex'))}};
  const elements=[[0,'Timeline.1',''],[1,'Stack.1','/tracks'],[2,'Track.1','/tracks/children/0'],[3,'Clip.1','/tracks/children/0/children/0'],[4,'Transition.1','/tracks/children/0/children/1'],[9,'Gap.1','/tracks/children/1/children/0']];
  for(const [index,[row,schema,pointer]] of elements.entries()){
    await run(row=>document.querySelectorAll('.outline .row')[row].click(),row);
    assert.equal(await run(()=>document.querySelector('.inspector .schema')?.textContent),schema);
    await click('Reference selection');
    const staged=await state();
    assert.equal(staged.records.length,index+1);
    const record=staged.records.at(-1);
    assert.deepEqual(record.document,baseDocument);
    assert.equal(record.element.pointer,pointer);
    assert.equal(record.element.schema,schema);
    assert.ok(!record.markedFrame);
    assert.equal(staged.editorText,initial.initialText);
    assert.ok(staged.labels.at(-1).startsWith('OTIO selection:'));
    assert.equal(await run(()=>!!document.querySelector('.otio textarea,.frame-editor')),false);
    assert.deepEqual(staged.refs,initial.refs);
  }
  await click('Clip: External','.tracks');
  assert.ok(await run(()=>document.querySelector('.mark-action:disabled')&&!document.querySelector('.picture img,.picture video')));
  await click('Clip: Repeated','.tracks .lane-row[data-kind=Video]:nth-child(3)');
  await wait('upper still',()=>document.querySelector('.picture img')?.naturalWidth===180);
  await click('Clip: Repeated','.tracks .lane-row:nth-child(2)');
  await wait('lower solo',()=>document.querySelector('.picture img')?.naturalWidth===240);
  await click('Timeline','.modes');
  await wait('upper composite',()=>document.querySelector('.picture img')?.naturalWidth===180);
  const before=await state();
  for(const [mode,width,height] of [['timeline',180,90],['clip',240,100]]){
    if(mode==='clip'){
      win.setSize(420,820);
      await wait('compact panels',()=>!!document.querySelector('.compact-tabs').getClientRects().length);
      const [monitor,tracks]=await layout('.monitor-pane','.tracks-pane');
      assert.ok(monitor.bottom<=tracks.top+1);
      await click('Selection','.compact-tabs');
      const [inspector,selectionTracks]=await layout('.inspector','.tracks-pane');
      assert.ok(inspector.bottom<=selectionTracks.top+1);
      await click('Outline','.compact-tabs');
      assert.ok(await run(()=>document.querySelector('.outline').getClientRects().length&&!document.querySelector('.monitor-pane').getClientRects().length));
      await click('Picture monitor','.compact-tabs');
      await click('Clip source','.modes');
      await click('Selection','.compact-tabs');
      await wait('compact actions ready in Selection',()=>{
        const pane=document.querySelector('.inspector'), button=pane.querySelector('.mark-action:enabled');
        if(!button || !button.getClientRects().length) return false;
        button.focus();
        const bounds=pane.getBoundingClientRect(), action=button.getBoundingClientRect();
        return document.activeElement===button && pane.scrollWidth<=pane.clientWidth+1 &&
          action.top>=bounds.top-1 && action.bottom<=bounds.bottom+1;
      });
    }
    await wait('ready '+mode,()=>!!document.querySelector('.mark-action:enabled'));
    await click('Draw on frame');
    await wait('frozen editor',width=>document.querySelector('canvas.image-annotation-canvas')?.width===width && !!document.querySelector('.image-annotation-tool:enabled'),width);
    assert.equal(await run(()=>document.querySelector('.review-actions button').disabled),true,'marks required before staging');
    assert.equal(await run(()=>!!document.querySelector('.otio textarea')),false);
    assert.equal((await state()).records.length,before.records.length+(mode==='clip'?1:0));
    const point=await run(()=>{
      const c=document.querySelector('canvas.image-annotation-canvas'); c.scrollIntoView({block:'center'});
      const r=c.getBoundingClientRect(),x=Math.round(r.left+r.width*.65),y=Math.round(r.top+r.height*.33);
      return {x,y,pixelX:Math.floor((x-r.left)/r.width*c.width),pixelY:Math.floor((y-r.top)/r.height*c.height),hit:document.elementFromPoint(x,y)===c};
    });
    assert.ok(point.hit,'canvas location is visible at '+mode+' width');
    const {x,y,pixelX,pixelY}=point;
    assert.ok(pixelX>width*.6 && pixelX<width*.7 && pixelY>height*.28 && pixelY<height*.38);
    win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});
    await wait('PNG ready',()=>!document.querySelector('.review-actions button').disabled);
    if(mode==='timeline'){
      await run(()=>{window.fixture.draft.key='another-draft'});
      await wait('changed destination cannot take frozen review',()=>document.querySelector('.review-actions button').disabled);
      assert.deepEqual(await state(),before);
      await run(()=>{window.fixture.draft.key='fixture-draft'});
      await wait('original destination restored',()=>!document.querySelector('.review-actions button').disabled);
    }
    if(mode==='clip'&&${JSON.stringify(screenshot || '')}) writeFileSync(${JSON.stringify(screenshot || '')},(await win.webContents.capturePage()).toPNG(),{flag:'wx'});
    await click('Add reference');
    const staged=await state(), record=staged.records.at(-1);
    assert.equal(staged.records.length,before.records.length+(mode==='clip'?2:1),await run(()=>document.querySelector('.review-error')?.textContent));
    assert.deepEqual(record.document,baseDocument);
    assert.deepEqual(record.playhead,{relative:{value:24,rate:24},global:{value:264,rate:24}});
    assert.equal(record.element.pointer,'/tracks/children/0/children/0');
    assert.deepEqual(record.element.sourceAtPlayhead,{value:72,rate:24});
    assert.equal(record.monitor.mode,mode);
    assert.equal(record.monitor.clip.pointer,mode==='clip'?record.element.pointer:'/tracks/children/1/children/1');
    assert.deepEqual(record.monitor.clip.source,{value:mode==='clip'?72:96,rate:24});
    assert.equal(record.monitor.clip.requestedMediaSeconds,mode==='clip'?1.5:0.5);
    assert.deepEqual(record.markedFrame,{presentedMediaSeconds:null});
    assert.equal(staged.labels.at(-1),'OTIO marked picture: Repeated · Frame 24');
    assert.equal(staged.editorText,initial.initialText);
    const png=await run(async(px,py,path)=>{
      const file=window.fixture.references.at(-1).attachment.file;
      const decoded=await createImageBitmap(file), original=await createImageBitmap(await (await fetch(path)).blob());
      const c=document.createElement('canvas');c.width=decoded.width;c.height=decoded.height;
      const ctx=c.getContext('2d',{willReadFrequently:true});
      ctx.drawImage(decoded,0,0);
      const sample=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
      const marked=sample(px,py), untouched=sample(20,20);
      ctx.drawImage(original,0,0);
      return {type:file.type,name:file.name,width:decoded.width,height:decoded.height,changed:marked.join()!==sample(px,py).join(),untouched:untouched.join()===sample(20,20).join()};
    },pixelX,pixelY,'/api/sessions/fixture/raw?path=cuts/'+(mode==='clip'?'lower':'upper')+'.png');
    assert.deepEqual(png,{type:'image/png',name:'assembly-f24-marked.png',width,height,changed:true,untouched:true});
  }
  const final=await state();
  assert.ok(final.text.startsWith(before.text));
  assert.equal(final.keys.length,initial.keys.length+2);
  assert.equal(new Set(final.keys).size,final.keys.length);
  assert.equal(new Set(final.refs).size,final.refs.length);
  for(const ref of final.refs)assert.ok(final.text.includes(ref));
  await run(()=>{window.fixture.active.value=false});
  await wait('inactive media and review disabled',()=>!document.querySelector('.picture img,.picture video,.mark-action:enabled'));
  assert.deepEqual(await state(),final);
  assert.equal(await run(()=>window.fixture.closes.value),0,'review-added must leave the inline tab open');
  await run(()=>{window.fixture.inline.value=false;window.fixture.active.value=true});
  await wait('standalone dialog',()=>document.querySelector('.file-modal[role=dialog] .mark-action:enabled'));
  await click('Reference selection');
  await wait('standalone closes after review-added',()=>window.fixture.closes.value===1&&!document.querySelector('.file-modal'));
  assert.equal((await state()).records.length,final.records.length+1);
  assert.deepEqual((await state()).refs,final.refs);
  assert.deepEqual(external,[]);
  assert.deepEqual(await run(()=>window.fixtureErrors),[]);
  console.log('OTIO_VIEWER_OK'); app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});`)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 70_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /OTIO_VIEWER_OK/)
  assert.ok(requests.every(({ method, route, path }) => method === 'GET' && route === '/api/sessions/fixture/raw' && path && [documentPath, videoPath, audioPath, ...Object.keys(images)].includes(path)), JSON.stringify(requests))
  assert.deepEqual(new Set(requests.map(({ path }) => path)), new Set([documentPath, videoPath, audioPath, ...Object.keys(images)]))
  if (desktopScreenshot) t.diagnostic(`Desktop overview screenshot: ${desktopScreenshot}`)
  if (screenshot) t.diagnostic(`Narrow review screenshot: ${screenshot}`)
})
