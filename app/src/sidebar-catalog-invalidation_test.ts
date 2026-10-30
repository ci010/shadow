import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createRenderer, h, nextTick, reactive } from 'vue'

// Exercise the real setup/watch/lifecycle code without a browser or unrelated
// child views. Rendering is intentionally inert; these are request-count tests.
const renderer = createRenderer<any, any>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null,
})
const settle = async () => { await nextTick(); await new Promise(done => setTimeout(done, 90)); await nextTick() }
async function component(name: string, fixture: any, t: any) {
  const directory = resolve('app/.test-artifacts', `catalog-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = await readFile(resolve('app/src/components', name + '.vue'), 'utf8')
  const script = compileScript(parse(source).descriptor, { id: name }).content
  const key = `catalog${randomUUID().replaceAll('-', '')}`
  ;(globalThis as any)[key] = fixture
  t.after(() => { delete (globalThis as any)[key] })
  const mocks: Record<string, string> = {
    'i18n.ts': `export const t = x => x; export const i18n = {global:{locale:{value:'en'}}}; export const formatDateTime = x => x`,
    'useProjectLiveState.ts': `export const useProjectLiveState = () => f.live`,
    'useLiveClient.ts': `export const useLiveClientPool = () => f.pool`,
    'service-groups.ts': `export const useServiceGroups = () => ({groups:{value:[]}}); export const projectGroupConversations = x => x; export const observedGroupId = () => ''`,
    'bot-settings.ts': `export const createBotSettingsClient = () => ({list:async () => {f.channels++; return []}})`,
    'folders-client.ts': `export const createFoldersClient = base => ({list:async signal => {f.folders++; return f.records || []}})`,
    'node-inventory.ts': `export const fetchNodeInventory = async () => {f.nodes++;return {nodes:[]}}`,
    'useComposerDraft.ts': `export const composerDraftRevision={value:0}; export const composerDraftKey=()=>''; export const composerDraftEditedAt=()=>0`,
  }
  await build({ stdin: { contents: script, loader: 'ts', resolveDir: resolve('app/src/components') },
    outfile: resolve(directory, 'component.mjs'), bundle: true, format: 'esm', platform: 'node', external: ['vue'],
    plugins: [{ name: 'fixture-dependencies', setup(builder) {
      builder.onResolve({ filter: /\.vue$/ }, () => ({ path: 'child', namespace: 'stub' }))
      builder.onResolve({ filter: /\.ts$/ }, args => {
        const name = args.path.split('/').at(-1)!
        return mocks[name] ? { path: name, namespace: 'stub' } : undefined
      })
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents:
        `const f = globalThis[${JSON.stringify(key)}];\n` + (args.path === 'child' ? 'export default {}' : mocks[args.path]), loader: 'ts' }))
    } }],
  })
  const definition = (await import(pathToFileURL(resolve(directory, 'component.mjs')).href)).default
  definition.render = () => null
  return definition
}
function fixture() {
  const observers = new Set<any>()
  const counts = { channels: 0, folders: 0, nodes: 0, records: [] as any[], observers,
    pool: { observeHost: (_: string, cb: any) => { cb({ phase: 'live' }); return () => {} },
      client: () => ({ subscribe: (topic: any, observer: any) => {
        const entry = {topic, observer}; observers.add(entry)
        return { ready: async () => {}, close: () => observers.delete(entry) }
      } }) },
    invalidate(projectId: string, resource: string) {
      for (const {topic, observer} of observers) if (topic.projectId === projectId)
        observer.event({ payload: {event: 'invalidate', resource} })
    },
  }
  return counts
}

test('ProjectGroup session start/end revisions do not refresh catalogs; channels remain resource driven', async t => {
  const f = fixture()
  const graph = { state: reactive<any>({ revision: 1, value: [{sessionId:'web:a',channelAddress:{}}], error:'' }) }
  const activity = { state: reactive<any>({revision:1,value:{stages:{}},error:''}), read: async () => {} }
  const lease = { graph, activity, refresh: async () => {}, release() {} }
  Object.assign(f, { live: { acquireProject: () => lease } })
  const definition = await component('ProjectGroup', f, t)
  const app = renderer.createApp({render: () => h(definition, {
    apiBase: 'http://localhost', project: {id:'a',name:'A'}, selectedProjectId:'a',
    selectedSessionId:'web:a', navigationKey:'a',remoteFolders:false,
  })})
  const vm = app.mount({})
  t.after(() => app.unmount())
  await settle()
  const initial = f.channels
  assert.equal(initial, 1, 'graph readiness and resource readiness share the initial catalog read')
  for (let i=0; i<4; i++) { graph.state.value = [...graph.state.value]; graph.state.revision++; await settle() }
  assert.equal(f.channels, initial, 'unchanged channel presence across graph revisions is not a catalog invalidation')
  f.invalidate('b','channels'); await settle(); assert.equal(f.channels, initial)
  f.invalidate('a','channels'); await settle(); assert.equal(f.channels, initial + 1)
  assert.equal((vm.$ as any).subTree.component.setupState.liveFolderRevision, 0)
})

test('FoldersSidebar folder and node resources refresh independently and release subscriptions', async t => {
  const f = fixture()
  const oldWindow = (globalThis as any).window, oldResize = (globalThis as any).ResizeObserver
  ;(globalThis as any).window = {innerWidth:1000,addEventListener(){},removeEventListener(){},localStorage:{getItem(){return null},setItem(){}}}
  ;(globalThis as any).ResizeObserver = class { observe(){} disconnect(){} }
  t.after(() => { (globalThis as any).window = oldWindow; (globalThis as any).ResizeObserver = oldResize })
  const definition = await component('FoldersSidebar', f, t)
  const sessions = reactive<any[]>([])
  const app = renderer.createApp({render: () => h(definition, {apiBase:'http://localhost/projects/a',projectId:'a',
    sessions,activeSessionId:'',collapsed:new Set(),stages:{},sessionsLoading:false,sessionsError:''})})
  app.mount({}); await settle()
  assert.deepEqual([f.folders,f.nodes], [1,1])
  sessions.push({sessionId:'web:new'}); await settle()
  assert.deepEqual([f.folders,f.nodes], [1,1])
  f.invalidate('b','folders'); f.invalidate('a','automations'); await settle()
  assert.deepEqual([f.folders,f.nodes], [1,1])
  f.invalidate('a','folders'); await settle()
  assert.deepEqual([f.folders,f.nodes], [2,1])
  f.invalidate('a','nodes'); await settle()
  assert.deepEqual([f.folders,f.nodes], [2,2])
  app.unmount(); assert.equal(f.observers.size,0)
  f.invalidate('a','folders'); await settle()
  assert.deepEqual([f.folders,f.nodes], [2,2])
})
