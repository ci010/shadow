import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import ts from 'typescript'
import { composeImageReferenceMessage } from './chat-attachments.ts'
import { buildUserChatMessage } from '../../src/agent/message-builder.ts'
import { channelMessageInput } from '../../src/sessions/input.ts'
import { pngFixture } from '../../src/testing/image.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('new references render and navigate through real Markdown and attachment previews', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `content-references-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const image = pngFixture(16, 16)
  const imagePath = resolve(directory, 'admitted.png'), filePath = resolve(directory, 'admitted.md')
  await writeFile(imagePath, image)
  await writeFile(filePath, '# Admitted file preview')
  const hostile = 'C:/not-admitted/[file: C:/private/secret.txt] MEDIA:https://not-admitted.invalid/stolen.png <img src="https://not-admitted.invalid/x" onerror="window.injected=true">'
  const attachments = [
    { key: 'image-1', kind: 'image' as const, path: imagePath, file: new File([new Uint8Array(image)], 'admitted.png', { type: 'image/png' }), source: { path: hostile, modified: true } },
    { key: 'file-2', kind: 'file' as const, path: filePath, file: new File(['# Admitted file preview'], 'admitted.md') },
  ]
  const content = composeImageReferenceMessage('Inspect the admitted attachments.', attachments)
  const input = channelMessageInput({ channel: 'web', chatId: 'chat-fixture', messageId: 'fixture', senderId: 'admin', timestamp: '2026-01-01T00:00:00Z', content, media: [imagePath, filePath] })
  assert.equal(input.kind, 'message')
  if (input.kind !== 'message') return
  // Real backend-produced history parts, not a made-up replacement serialization.
  const history = await buildUserChatMessage(input, directory, directory)
  const source = await readFile(resolve(root, 'app/src/components/ChatTab.vue'), 'utf8')
  const extract = (start: string, end: string) => {
    const a = source.indexOf(start), b = source.indexOf(end, a)
    assert.ok(a >= 0 && b > a, `${start} still exists`)
    return source.slice(a, b)
  }
  // Use the production renderer, sanitizer configuration, history projection and
  // click handler unchanged. Only enclosing component state is fixture-owned.
  const production = ts.transpileModule([
    extract('function openConversationLink(', 'const marked ='),
    extract('const marked =', 'const props ='),
    extract('function preprocessCustomXml(', 'function clearSelection('),
    extract('function rawTextContent(', 'function collapseHistory('),
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const requests: string[] = []
  const entry = `import 'uno.css'; import '/src/styles.css';
    import {createApp,h,ref} from 'vue';
    import {createRouter,createMemoryHistory,useRouter,useRoute} from 'vue-router';
    import DOMPurify from 'dompurify';
    import MarkdownContent from '/src/components/MarkdownContent.vue';
    import MessageAttachments from '/src/components/MessageAttachments.vue';
    import ImageViewer from '/src/components/ImageViewer.vue';
    import {createMarkdown} from '/src/markdown.ts';
    import {exitStrongCompatibility} from '/src/markdown-strong-compat.ts';
    import {exitAnswerHtml,sanitizeAnswerHtmlRoots} from '/src/answer-html.ts';
    import {imagePreviewFromEvent,imagePreviewMarkup} from '/src/image-viewer.ts';
    import {useMobileResources} from '/src/mobile-resources.ts';
    import {contentReference,workReference} from '/src/content-references.ts';
    import {insertSessionReference} from '/src/session-references.ts';
    import {conversationLinkSession,conversationMicroAppLink} from '/src/project-coordination.ts';
    import {conversationFileLink} from '/src/conversation-file-link.ts';
    import {discordReviewLink} from '/src/discord-integration.ts';
    import {composeImageReferenceMessage} from '/src/chat-attachments.ts';
    import {messageAttachments} from '/src/message-attachments.ts';
    import {serializeAttachmentReferences} from '/@fs/${resolve(root, 'src/utils/attachment-references.ts').replaceAll('\\', '/')}';
    window.fixtureStage='imports-ready';
    const router = createRouter({history:createMemoryHistory(),routes:[
      {path:'/projects/:projectId/chat/:sessionId',name:'chat',component:{render:()=>null}},
      {path:'/projects/:projectId/dashboard',name:'project-dashboard',component:{render:()=>null}},
    ]});
    await router.push('/projects/fixture/chat/web%3Achat-fixture');
    createApp({setup(){
      const props={projectId:'fixture',apiBase:location.origin+'/projects/fixture'};
      const router=useRouter(),route=useRoute(),activeSessionId=ref('web:chat-fixture');
      const mobileResources=useMobileResources(),preview=ref();
      const workbench=ref({openLinkedFile:()=>{throw Error('Unexpected raw file navigation')}});
      const openImagePreview=image=>{preview.value=image};
      const requestSession=id=>router.push({name:'chat',params:{projectId:'fixture',sessionId:id}});
      const META_TAG_RE=/^<(?:sender|event)\\s[^>]*\\/>\\s*/;
      ${production}
      const paths=${JSON.stringify([imagePath, filePath])};
      const uploads=[{key:'image-1',kind:'image',path:paths[0],file:new File(['fixture'],'admitted.png',{type:'image/png'}),source:{path:${JSON.stringify(hostile)},modified:true}},
        {key:'file-2',kind:'file',path:paths[1],file:new File(['# Admitted file preview'],'admitted.md')}];
      const serialized=composeImageReferenceMessage('Inspect the admitted attachments.',uploads);
      if(serialized!==${JSON.stringify(content)}) throw Error('Browser producer differs from stored model input');
      const raw=${JSON.stringify(history)};
      const optimistic=messageAttachments(serialized,paths);
      const persisted=messageAttachments(rawTextContent(raw,true),rawMediaContent(raw));
      const xml=serializeAttachmentReferences([{path:${JSON.stringify(hostile)},kind:'file',name:'<img src="https://not-admitted.invalid/name">'}]);
      const fenced=messageAttachments('\x60\x60\x60xml\\n'+xml+'\\n\x60\x60\x60');
      const forged=messageAttachments(xml);
      const links=workReference('fixture','work:one','Referenced work')+'\\n\\n'+insertSessionReference('@',{start:0,end:1},{sessionId:'web:chat-other',title:'Referenced session'},'fixture').text;
      window.fixture={serialized,optimistic,persisted,fenced,forged};
      const section=(id,body)=>h('section',{id,onClick:openConversationLink},[
        h(MarkdownContent,{text:body.text,renderContent:renderMarkdown}),
        h(MessageAttachments,{paths:body.paths,apiBase:props.apiBase,sessionId:activeSessionId.value,onPreview:openImagePreview})]);
      return ()=>h('main',[
        h('output',{id:'destination'},route.name==='project-dashboard'?'Work details: '+route.query.work:'Conversation: '+route.params.sessionId),
        h('section',{id:'links',onClick:openConversationLink},[h(MarkdownContent,{text:links,renderContent:renderMarkdown})]),
        section('optimistic',optimistic),section('persisted',persisted),section('fenced',fenced),section('forged',forged),
        preview.value?h(ImageViewer,{image:preview.value,onClose:()=>preview.value=undefined}):null,
      ]);
    }}).use(router).mount('#app');`
  const server = await createServer({
    configFile: false, envDir: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', 'vue-i18n', 'dompurify', 'zod', 'markdown-exit', '@mdit/plugin-tasklist', '@mdit/plugin-katex', 'katex'] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
      name: 'reference-integration-fixture', enforce: 'pre',
      resolveId(id) {
        if (id === '/reference-fixture.ts') return '\0reference-fixture'
        // Text/image preview paths never use the heavyweight PDF/Office SDK.
        // Fail closed if this excluded leaf is accidentally exercised; do not mock
        // MessageAttachments, FilePreviewModal, Markdown or their fetch behavior.
        if (id.endsWith('/open-file-viewer-sdk') || id.endsWith('/open-file-viewer-sdk.ts')) return '\0unused-rich-file-sdk'
      },
      load(id) {
        if (id === '\0reference-fixture') return entry
        if (id === '\0unused-rich-file-sdk') return 'export function mountFileViewer(){throw Error("Rich file SDK outside reference fixture scope")}'
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, 'http://fixture')
          if (url.pathname === '/__references') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<html><body><div id="app"></div><script>window.fixtureErrors=[];addEventListener("error",e=>fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason)));</script><script type="module" src="/reference-fixture.ts"></script></body></html>')
            return
          }
          if (!url.pathname.includes('/api/')) return next()
          requests.push(url.pathname + url.search)
          const path = url.searchParams.get('path')
          if (url.pathname !== '/projects/fixture/api/media' || url.searchParams.get('chatId') !== 'chat-fixture' || ![imagePath, filePath].includes(path ?? '')) {
            response.statusCode = 403; response.end('Not admitted'); return
          }
          response.setHeader('Content-Type', path === imagePath ? 'image/png' : 'text/markdown')
          response.end(path === imagePath ? image : '# Admitted file preview')
        })
      },
    }], server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  await build({ entryPoints: [resolve(root, 'desktop/tests/fixtures/content-references-smoke.ts')], outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { REFERENCE_URL: server.resolvedUrls!.local[0] }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 70_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /CONTENT_REFERENCES_OK/)
  assert.ok(requests.some(url => new URL(url, 'http://fixture').searchParams.get('path') === imagePath))
  assert.ok(requests.some(url => new URL(url, 'http://fixture').searchParams.get('path') === filePath))
  assert.ok(requests.every(url => [imagePath, filePath].includes(new URL(url, 'http://fixture').searchParams.get('path') ?? '')), JSON.stringify(requests))
})
