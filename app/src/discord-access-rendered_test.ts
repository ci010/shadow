import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { IntegrationChangeSchema, IntegrationDraftSchema, IntegrationOverviewSchema, integrationToolNames } from '../../src/channels/integration-contract.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('Discord settings render named resources, exact human reviews, learning domains and narrow-screen forms', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `discord-access-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const agentId = randomUUID(), domainId = randomUUID(), resourceId = randomUUID(), conversationDomainId = randomUUID(), epoch = randomUUID()
  const bot = { id: 'fixture-bot', projectId: 'fixture-project', platform: 'discord', displayName: 'Community Bot',
    label: 'Discord', enabled: true, configured: true, state: 'connected', config: {}, secrets: { token: true } }
  const now = new Date().toISOString()
  const overview = IntegrationOverviewSchema.parse({
    projectId: bot.projectId, version: 1, revision: 0, deploymentIssues: [],
    agents: [{ id: agentId, name: 'customer-support', displayName: 'Customer support', markdown: 'Answer from approved help articles.',
      execution: 'restricted', tools: ['read', 'search', 'memory_save', 'learned_skill'], readDomains: [domainId], skills: [],
      version: 'a'.repeat(64), publishedAt: now }],
    bindings: [], drafts: [], audit: [],
    domains: [
      { id: domainId, name: 'Public help articles', kind: 'shared', revision: 1, revoked: false, createdAt: now },
      { id: conversationDomainId, name: 'Customer help', kind: 'conversation', revision: 1, revoked: false, createdAt: now,
        owner: { sessionId: 'fixture-conversation', epoch } },
    ],
    resources: [{ id: resourceId, domainId, kind: 'note', title: 'Getting started', version: 'b'.repeat(64), contentHash: 'c'.repeat(64),
      current: true, revoked: false, createdAt: now, sources: [], publication: { id: randomUUID(), actor: 'shadow-owner', at: now } }],
    tools: integrationToolNames, templates: [], legacy: [], sessions: [],
    learning: [{ sessionId: 'fixture-conversation', epoch, domainId: conversationDomainId, bindingId: randomUUID(),
      revision: 'f'.repeat(64), botInstanceId: bot.id, pipeline: 'reflector', status: 'paused',
      summary: 'Automatic retries paused. The source cursor has not advanced.' }],
  })
  const server = await createServer({
    configFile: false, envDir: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { entries: [] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'discord-access-fixture',
      resolveId: id => id === '/discord-fixture.ts' ? '\0discord-fixture' : undefined,
      load(id) {
        if (id !== '\0discord-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h, reactive, nextTick } from 'vue';
          import DiscordAccess from '/src/components/DiscordAccess.vue';
          import ChannelsView from '/src/components/ChannelsView.vue';
          const state=reactive({apiBase:location.origin,projectId:'fixture-project',bot:${JSON.stringify(bot)},active:true});
          const reviewUi=reactive({open:false,id:'',botId:'fixture-bot'});
          const app=createApp({setup:()=>()=>h('main',{style:'max-width:960px;margin:0 auto;padding:24px;box-sizing:border-box'},[
            reviewUi.open ? h(ChannelsView,{apiBase:location.origin,projectId:'fixture-project',available:true,active:true,
              requestedReviewId:reviewUi.id,reviewBotId:reviewUi.botId}) : h(DiscordAccess,state)
          ])});
          app.provide(Symbol.for('shadow.live-client-pool'),{client:()=>({subscribe:()=>({close(){},ready:async()=>{}})})});
          window.__switchProject=()=>{state.projectId='another-project'};
          window.__refreshBot=async()=>{state.bot={...state.bot,config:{...state.bot.config},secrets:{...state.bot.secrets}};await nextTick()};
          window.__switchBot=async()=>{state.bot={...state.bot,id:'another-bot'};await nextTick()};
          window.__openReviewSettings=async(id,botId='fixture-bot')=>{reviewUi.id=id;reviewUi.botId=botId;reviewUi.open=true;await nextTick()};
          app.mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, 'http://127.0.0.1')
          const path = url.pathname
          const json = (data: unknown, status = 200) => {
            response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data))
          }
          if (path === '/') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/discord-fixture.ts"></script></body></html>')
            return
          }
          if (path === '/api/channels') { json({channels:[bot]}); return }
          if (!path.startsWith('/api/integrations/discord')) { next(); return }
          void (async () => {
            if (request.method === 'GET') {
              if (path.endsWith('/discord')) { json(overview); return }
              if (path.includes('/directory/')) {
                const guildId = url.searchParams.get('guildId')
                json({ botInstanceId: path.split('/').at(-1), botUserId: '900', guilds: [{ id: '100', name: 'Community workspace', icon: null }],
                  guildId, guildCursor: null, channels: guildId ? [
                    { id: '201', name: 'customer-help', type: 0, parentId: null, canView: true, canSend: true, canReadHistory: true, supported: true },
                    { id: '202', name: 'product-questions', type: 15, parentId: null, canView: true, canSend: true, canReadHistory: true, supported: true },
                  ] : [], roles: guildId ? [{ id: '700', name: 'Support team' }] : [],
                  synchronizedAt: now, completeness: guildId ? 'channels-and-active-threads' : 'guild-page',
                  notice: 'Archived and private threads are not enumerated.' })
                return
              }
              if (path.includes('/resources/')) { json({ resource: overview.resources[0], content: 'Use the supported setup instructions. No private account details are shared.' }); return }
              if (path.includes('/agents/')) { json({ id: agentId, markdown: overview.agents[0].markdown }); return }
              json({ message: 'Unsupported fixture read' }, 404); return
            }
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(Buffer.from(chunk))
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
            if (path.endsWith('/drafts')) {
              const input = body as { change: unknown; baseRevision: number }
              const change = IntegrationChangeSchema.parse(input.change)
              assert.equal(input.baseRevision, overview.revision)
              const draft = IntegrationDraftSchema.parse({
                id: randomUUID(), actor: { kind: 'owner', id: 'shadow-owner' }, change, baseRevision: overview.revision,
                hash: 'd'.repeat(64), validationHash: 'e'.repeat(64), createdAt: now,
                expiresAt: new Date(Date.now() + 900_000).toISOString(), status: 'pending', affectedBindings: [],
                warning: 'Changed Agent and access settings start a fresh context. Same-Agent conversations never share customer memory.',
              })
              overview.drafts.push(draft); json(draft, 201); return
            }
            if (path.endsWith('/commit')) {
              const draft = overview.drafts.find(draft => path.includes(draft.id))!
              assert.equal((body as { hash: string }).hash, draft.hash)
              if (draft.change.kind === 'bindings.save') overview.bindings = draft.change.bindings
              draft.status = 'applied'; draft.appliedRevision = ++overview.revision
              json(draft); return
            }
            json({ message: 'Unsupported fixture change' }, 400)
          })().catch(error => { json({ message: error instanceof Error ? error.message : 'Fixture failed' }, 500) })
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]
  assert(url)
  await build({ entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'discord-access-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { DISCORD_ACCESS_URL: url, DISCORD_ACCESS_ARTIFACTS: process.env.DISCORD_ACCESS_ARTIFACTS }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, log)
  assert.match(log, /DISCORD_ACCESS_SMOKE_OK/)
  assert.equal(overview.bindings.length, 2)
  assert(overview.bindings.every(binding => !binding.manage && binding.tools.every(tool => tool !== 'exec')))
  const publication = overview.drafts.find(draft => draft.change.kind === 'knowledge.publish')!
  assert.equal(publication.status, 'pending', 'A knowledge copy remains unpublished until human approval')
  assert(publication.change.kind === 'knowledge.publish' && publication.change.sources[0].resourceId === resourceId)
})
