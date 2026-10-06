import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import type { KnowledgeCatalog, KnowledgeEntry } from './knowledge.ts'
import type { KnowledgeMaintenanceReport, KnowledgeRepairPreview } from './knowledge-maintenance.ts'
import { KNOWLEDGE_TAB_KEY, projectTabKey } from './file-workbench.ts'

interface ElementNode {
  tag: string; text: string; props: Record<string, unknown>; children: ElementNode[]; parent?: ElementNode
  scrollTop: number
  showModal(): void; close(): void; focus(): void
}
const element = (tag: string, text = ''): ElementNode => ({ tag, text, props: {}, children: [], scrollTop: 0, showModal() {}, close() {}, focus() {} })
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick() }
const wiki: KnowledgeEntry = { id: 'memory/topics/node.md', path: 'memory/topics/node.md', title: 'Node wiki', kind: 'wiki', source: 'project', deletable: true, revision: 'r1' }
const memory: KnowledgeEntry = { ...wiki, id: 'memory/sessions/chat.md', path: 'memory/sessions/chat.md', title: 'Chat memory', kind: 'memory' }
const builtin: KnowledgeEntry = { ...wiki, id: 'builtin:skills/node', path: 'skills/node/SKILL.md', title: 'Node skill', kind: 'skill', source: 'builtin', deletable: false }
const catalog: KnowledgeCatalog = { entries: [wiki, memory, builtin], links: [{ source: memory.id, target: wiki.id, label: 'node' }] }

function mount(t: TestContext, filename: string, initial: Record<string, unknown>, selected = '') {
  const route = Vue.reactive({ name: 'chat', params: { projectId: 'a' }, query: { entry: selected } })
  const history: number[] = []
  if (filename === 'KnowledgeView.vue') initial = { entryId: selected, ...initial }
  const scope = Vue.ref({ uiScopes: ['main:admin'] })
  const dialogStub = Vue.defineComponent({
    props: ['target', 'incoming', 'apiBase', 'projectId'],
    setup: (props, { emit }) => () => Vue.h('button', { 'data-test': 'confirm-delete', onClick: () => emit('deleted', props.target.id) }, 'Confirm stub'),
  })
  const url = new URL(`./components/${filename}`, import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const script = compileScript(descriptor, { id: filename, inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const require = createRequire(url)
  const module = { exports: {} as { default: Vue.Component } }
  new Function('require', 'module', 'exports', 'document', outputText)((id: string) => {
    if (id === 'vue') return {
      ...Vue, vModelText: {}, vModelCheckbox: {}, vModelSelect: {},
      vShow: {
        beforeMount: (node: ElementNode, binding: { value: boolean }) => { node.props.hidden = !binding.value },
        updated: (node: ElementNode, binding: { value: boolean }) => { node.props.hidden = !binding.value },
      },
      ...(filename === 'files/FileWorkbench.vue' ? { onMounted() {}, onUnmounted() {} } : {}),
    }
    if (id === 'vue-router') return { useRoute: () => route, useRouter: () => ({
      replace: ({ query }: { query: typeof route.query }) => { route.query = query },
      back: () => history.push(-1), forward: () => history.push(1), go: (direction: number) => history.push(direction),
    }) }
    if (id.endsWith('useInstallationContext.ts')) return { useInstallationContext: () => scope }
    if (id.endsWith('/knowledge-markdown.ts')) return {
      renderKnowledgeMarkdown: (content: string) => require('marked').marked.parse(content),
    }
    if (id.endsWith('/useWorkdirGit.ts')) return { useWorkdirGit: () => ({
      status: Vue.ref(), loading: Vue.ref(false), error: Vue.ref(''), offline: Vue.ref(false), revision: Vue.ref(0), refresh() {},
    }) }
    if (id === '../HoverInfo.vue') return { default: Vue.defineComponent({
      props: ['text'],
      setup: (_props, { slots }) => () => slots.default?.({ triggerProps: {} }),
    }) }
    if (id === '../KnowledgeView.vue') return { default: Vue.defineComponent({
      props: ['apiBase', 'projectId', 'entryId', 'active', 'sidebarTarget'],
      emits: ['select', 'catalog'],
      setup: (props, { emit }) => () => Vue.h('div', { 'data-test': 'knowledge-panel', ...props, onClick: () => emit('select', builtin.id) }),
    }) }
    if (id === './FileTreeNode.vue') return { default: Vue.defineComponent({
      props: ['entry'],
      setup: props => () => Vue.h('div', { 'data-test': 'file-entry' }, props.entry.name),
    }) }
    if (id === './KnowledgeDeleteDialog.vue') return { default: dialogStub }
    if (id === './KnowledgeGraph.vue') return { default: Vue.defineComponent({
      setup: () => () => Vue.h('div', { 'data-test': 'knowledge-graph' }),
    }) }
    if (id === './KnowledgeRepairDialog.vue') return { default: Vue.defineComponent({
      props: ['preview'],
      setup: (props, { emit }) => () => Vue.h('button', { 'data-test': 'confirm-repair', onClick: () => emit('applied', props.preview.sourceId) }, 'Confirm repair stub'),
    }) }
    if (id.endsWith('.vue')) return { default: Vue.defineComponent({ setup: () => () => Vue.h('div') }) }
    return require(id)
  }, module, module.exports, filename === 'files/FileWorkbench.vue'
    ? { getElementById: () => undefined } : Reflect.get(globalThis, 'document'))
  const body = element('body')
  const renderer = Vue.createRenderer<ElementNode, ElementNode>({
    createElement: element, createText: text => element('#text', text), createComment: text => element('#comment', text),
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value },
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    querySelector: selector => selector === 'body' ? body : find(root, selector) ?? null,
  })
  const props = Vue.reactive(initial)
  const root = element('root')
  if (initial.sidebarTarget) {
    const sidebar = element('aside')
    sidebar.props.id = String(initial.sidebarTarget).slice(1)
    sidebar.parent = root
    root.children.push(sidebar)
  }
  const find = (node: ElementNode, selector: string): ElementNode | undefined =>
    node.props.id === selector.slice(1) ? node : node.children.map(child => find(child, selector)).find(Boolean)
  const app = renderer.createApp(Vue.defineComponent({ setup: () => () => Vue.h(module.exports.default, props) }))
  app.mount(root)
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  t.after(unmount)
  const nodes = (): ElementNode[] => {
    const visit = (node: ElementNode): ElementNode[] => [node, ...node.children.flatMap(visit)]
    return [...visit(root), ...visit(body)]
  }
  const text = () => nodes().filter(node => node.tag !== '#comment').map(node => node.text).join(' ')
  const button = (label: string) => {
    const node = nodes().find(node => node.tag === 'button' && node.text === label)
    assert(node, `Missing button ${label}: ${text()}`)
    return node
  }
  return { route, history, props, scope, nodes, text, button, unmount }
}

test('workbench renders Knowledge next to Conversation, deduplicates and closes without deleting', async t => {
  const navigation: Array<[boolean, string | undefined]> = []
  const view = mount(t, 'files/FileWorkbench.vue', {
    apiBase: 'http://fixture/projects/a', projectId: 'a', sessionId: '', contextKey: 'a:draft',
    active: true, knowledgeEnabled: true, knowledgeRequest: { entryId: wiki.id },
    onKnowledgeNavigation: (active: boolean, entryId?: string) => navigation.push([active, entryId]),
  })
  await settle()
  const tabs = () => view.nodes().filter(node => node.props.role === 'tab')
  const knowledgeTab = () => tabs().find(node => String(node.props.id).endsWith(encodeURIComponent(KNOWLEDGE_TAB_KEY)))!
  const entryTab = (id: string) => tabs().find(node => String(node.props.id).endsWith(encodeURIComponent(`\0knowledge-entry:${id}`)))!
  const panel = () => view.nodes().find(node => node.props['data-test'] === 'knowledge-panel')
  assert.equal(tabs().length, 3)
  assert.equal(entryTab(wiki.id).props['aria-selected'], true)
  assert.equal(panel()?.props.apiBase, 'http://fixture/projects/a')
  assert.equal(panel()?.props.entryId, wiki.id)
  assert(view.nodes().some(node => node.props['aria-label'] === 'Knowledge explorer'))
  assert(!view.nodes().some(node => node.props['aria-label'] === 'File explorer'))
  assert.deepEqual(navigation.at(-1), [true, wiki.id])
  view.props.knowledgeRequest = {}
  await settle()
  assert.equal(tabs().length, 3)
  assert.equal(knowledgeTab().props['aria-selected'], true)
  assert.equal(panel()?.props.entryId, '')
  ;(entryTab(wiki.id).props.onClick as () => void)()
  await settle()
  assert.equal(panel()?.props.entryId, wiki.id)
  ;(panel()?.props.onClick as () => void)()
  await settle()
  assert.equal(tabs().length, 4)
  assert.equal(entryTab(builtin.id).props['aria-selected'], true)
  assert.deepEqual(navigation.at(-1), [true, builtin.id])
  ;(tabs()[0].props.onClick as () => void)()
  await settle()
  assert.equal(panel()?.props.active, false)
  assert.equal(panel()?.parent?.props.hidden, true)
  assert.deepEqual(navigation.at(-1), [false, undefined])
  ;(knowledgeTab().props.onClick as () => void)()
  await settle()
  assert.equal(panel()?.props.active, true)
  const close = view.nodes().find(node => node.props['aria-label'] === 'Close Knowledge')!
  ;(close.props.onClick as () => void)()
  await settle()
  assert.equal(tabs().length, 1)
  assert.equal(tabs()[0].props['aria-selected'], true)
  assert.equal(panel(), undefined, 'Closing destroys Knowledge, not the conversation')
  view.props.knowledgeRequest = { entryId: builtin.id }
  await settle()
  assert.equal(tabs().length, 3)
  assert.equal(panel()?.props.entryId, builtin.id)
  ;(knowledgeTab().props.onKeydown as (event: object) => void)({ key: 'ArrowLeft', preventDefault() {} })
  await settle()
  assert.equal(tabs()[0].props['aria-selected'], true)
  ;(tabs()[0].props.onKeydown as (event: object) => void)({ key: 'End', preventDefault() {} })
  await settle()
  assert.equal(entryTab(builtin.id).props['aria-selected'], true)
  ;(knowledgeTab().props.onKeydown as (event: object) => void)({ key: 'Delete', preventDefault() {} })
  await settle()
  assert.equal(panel(), undefined)
  view.props.knowledgeRequest = {}
  await settle()
  view.props.active = false
  await settle()
  assert.equal(panel()?.props.active, false)
  view.props.knowledgeEnabled = false
  await settle()
  assert.equal(tabs().length, 1)
  assert.equal(panel(), undefined)
})

test('project Settings and Agents deep links open independent workbench tabs and return to Conversation', async t => {
  const changes: Array<string | undefined> = []
  const view = mount(t, 'files/FileWorkbench.vue', {
    apiBase: 'http://fixture/projects/a', projectId: 'a', sessionId: '', contextKey: 'a:draft',
    active: true, knowledgeEnabled: true, onProjectNavigation: (tab?: string) => changes.push(tab),
  })
  const tab = (key: string) => view.nodes().find(node =>
    node.props.role === 'tab' && String(node.props.id).endsWith(encodeURIComponent(key)))!
  view.route.name = 'project-settings'
  await settle()
  assert.equal(tab(projectTabKey('settings')).props['aria-selected'], true)
  view.route.name = 'agents'
  await settle()
  assert.equal(tab(projectTabKey('agents')).props['aria-selected'], true)
  assert.equal(tab(projectTabKey('settings')).props['aria-selected'], false)
  ;(tab(projectTabKey('settings')).props.onClick as () => void)()
  await settle()
  assert.equal(changes.at(-1), 'settings')
  ;(view.nodes().find(node => node.props['aria-label'] === 'Close Project settings')!.props.onClick as () => void)()
  await settle()
  assert.equal(tab('').props['aria-selected'], true)
  assert.equal(changes.at(-1), undefined)
  assert.equal(tab(projectTabKey('agents')).props['aria-selected'], false)
  view.route.name = 'chat'
  await settle()
  assert.equal(tab(projectTabKey('agents')).props['aria-selected'], false)
})

test('knowledge navigation moves to the explorer while details and filters stay in sync', async t => {
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const id = new URL(String(input)).searchParams.get('id')
    return Response.json(id ? { entry: catalog.entries.find(item => item.id === id), content: '# Content' } : catalog)
  })
  const view = mount(t, 'KnowledgeView.vue', {
    apiBase: 'http://fixture/projects/a', projectId: 'a', sidebarTarget: '#knowledge-target',
  }, wiki.id)
  await settle()
  const sidebar = view.nodes().find(node => node.props.id === 'knowledge-target')!
  assert(sidebar.children.some(node => node.props['aria-label'] === 'Knowledge entries'))
  const skills = view.nodes().find(node => node.tag === 'button' && node.children.some(child => child.text.trim() === 'Skills'))!
  assert(skills)
  ;(skills.props.onClick as () => void)()
  await settle()
  assert.match(view.text(), /1 \/ 3 entries/)
  assert.equal(view.nodes().filter(node => node.props.class === 'entry').length, 1)
  assert.match(view.text(), /Node wiki/, 'The selected detail remains readable while filtering the navigation')
  view.props.sidebarTarget = undefined
  await settle()
  assert(!sidebar.children.some(node => node.props['aria-label'] === 'Knowledge entries'))
  assert(view.nodes().some(node => node.props['aria-label'] === 'Knowledge entries'))
})

test('knowledge entry tabs restore their own reading positions', async t => {
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const id = new URL(String(input)).searchParams.get('id')
    return Response.json(id ? { entry: catalog.entries.find(item => item.id === id), content: '# Content' } : catalog)
  })
  const view = mount(t, 'KnowledgeView.vue', { apiBase: 'http://fixture/projects/a', projectId: 'a' }, wiki.id)
  await settle()
  const scroll = view.nodes().find(node => node.props.class === 'knowledge-scroll')!
  scroll.scrollTop = 120
  view.props.entryId = builtin.id
  await settle()
  assert.equal(scroll.scrollTop, 0)
  scroll.scrollTop = 55
  view.props.entryId = wiki.id
  await settle()
  assert.equal(scroll.scrollTop, 120)
  view.props.entryId = builtin.id
  await settle()
  assert.equal(scroll.scrollTop, 55)
})

test('file tree searches paths beyond loaded directories and restores browsing when cleared', async t => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    requests.push(String(input))
    if (new URL(String(input)).pathname.endsWith('/files/search')) return Response.json({
      paths: ['src/deep/notes.md'], truncated: false,
    })
    return Response.json({
      path: '', entries: [
        { name: 'notes.md', type: 'file', ext: '.md', size: 10, mtime: null },
        { name: 'picture.png', type: 'file', ext: '.png', size: 10, mtime: null },
        { name: 'src', type: 'dir', ext: '', size: 0, mtime: null },
      ],
    })
  })
  const view = mount(t, 'files/FileTree.vue', { apiBase: 'http://fixture', sessionId: 'a', treeOnly: true })
  await settle()
  const names = () => view.nodes().filter(node => node.props['data-test'] === 'file-entry').map(node => node.text)
  assert.deepEqual(names(), ['notes.md', 'picture.png', 'src'])
  const search = view.nodes().find(node => node.props['aria-label'] === 'Search file paths')!
  ;(search.props['onUpdate:modelValue'] as (value: string) => void)('NOTES')
  await new Promise(resolve => setTimeout(resolve, 250))
  await settle()
  assert.deepEqual(view.nodes().filter(node => node.props.class === 'file-search-result').map(node => node.children.at(-1)?.text), ['src/deep/notes.md'])
  assert.equal(requests.length, 2)
  assert.equal(new URL(requests[1]!).searchParams.get('query'), 'notes')
  ;(search.props['onUpdate:modelValue'] as (value: string) => void)('')
  await settle()
  assert.deepEqual(names(), ['notes.md', 'picture.png', 'src'])
})

test('knowledge tab browses content, navigates references, filters and keeps builtin skills read-only', async t => {
  const reads: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const id = new URL(String(input)).searchParams.get('id')
    if (id) reads.push(id)
    return Response.json(id ? { entry: catalog.entries.find(item => item.id === id), content: '# Knowledge content' } : catalog)
  })
  const view = mount(t, 'KnowledgeView.vue', { apiBase: 'http://fixture/projects/a', projectId: 'a' }, wiki.id)
  await settle()
  assert.match(view.text(), /Node wiki/)
  assert.match(view.text(), /Referenced by \(1\)/)
  ;(view.button('Back').props.onClick as () => void)()
  ;(view.button('Forward').props.onClick as () => void)()
  assert.deepEqual(view.history, [-1, 1])
  assert(!view.nodes().some(node => node.props['data-test'] === 'knowledge-graph'),
    'Entry documents show the page rather than the catalog graph')
  assert(view.button('Delete'))
  const outgoing = view.nodes().find(node => node.tag === 'button' && node.children.some(child => child.text === 'node'))
  assert(outgoing, 'Incoming references are rendered as navigation buttons')
  ;(outgoing.props.onClick as () => void)()
  await settle()
  assert.equal(view.route.query.entry, wiki.id, 'Embedded selection does not mutate the global route')
  assert.match(view.text(), /References \(1\)/)
  view.props.entryId = builtin.id
  await settle()
  assert.match(view.text(), /Built-in \/ read-only/)
  assert(!view.nodes().some(node => node.tag === 'button' && node.text === 'Delete'))
  view.props.entryId = wiki.id
  await settle()
  assert.equal(reads.filter(id => id === wiki.id).length, 1, 'Returning to an open page reuses its detail')
  view.props.entryId = ''
  await settle()
  assert(view.nodes().some(node => node.props['data-test'] === 'knowledge-graph'))
  const search = view.nodes().find(node => node.props['aria-label'] === 'Search knowledge')!
  ;(search.props['onUpdate:modelValue'] as (value: string) => void)('no-match')
  await settle()
  assert.match(view.text(), /No matching entries/)
})

test('hidden Knowledge tabs keep selection and filters, dismiss deletion and ignore unrelated routes', async t => {
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const id = new URL(String(input)).searchParams.get('id')
    return Response.json(id ? { entry: catalog.entries.find(item => item.id === id), content: '# Content' } : catalog)
  })
  const view = mount(t, 'KnowledgeView.vue', { apiBase: 'http://fixture/projects/a', projectId: 'a', active: true }, wiki.id)
  await settle()
  ;(view.button('Delete').props.onClick as () => void)()
  await settle()
  assert(view.nodes().some(node => node.props['data-test'] === 'confirm-delete'))
  view.props.active = false
  view.route.query.entry = builtin.id
  await settle()
  assert(!view.nodes().some(node => node.props['data-test'] === 'confirm-delete'))
  view.props.active = true
  await settle()
  assert.match(view.text(), /Referenced by \(1\)/)
  assert(view.button('Delete'))
})

test('closing a Knowledge tab aborts pending reads and never sends deletion', async t => {
  const calls: RequestInit[] = []
  t.mock.method(globalThis, 'fetch', (_input: URL, init: RequestInit) => {
    calls.push(init)
    return new Promise<Response>(() => {})
  })
  const view = mount(t, 'KnowledgeView.vue', { apiBase: 'http://fixture/projects/a', projectId: 'a' })
  assert.equal(calls.length, 1)
  view.unmount()
  assert.equal(calls[0].signal?.aborted, true)
  assert(calls.every(call => !call.method || call.method === 'GET'))
})

test('knowledge tab isolates late responses on project changes and denies unprivileged browsing', async t => {
  const requests: Array<{ signal?: AbortSignal | null; finish: (value: unknown) => void }> = []
  t.mock.method(globalThis, 'fetch', (_url: URL, init: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ signal: init.signal, finish: value => resolve(Response.json(value)) })
  }))
  const view = mount(t, 'KnowledgeView.vue', { apiBase: 'http://fixture/projects/a', projectId: 'a' })
  view.props.apiBase = 'http://fixture/projects/b'
  view.props.projectId = 'b'
  await settle()
  assert.equal(requests[0]!.signal?.aborted, true)
  requests[1]!.finish({ entries: [builtin], links: [] })
  await settle()
  requests[0]!.finish(catalog)
  await settle()
  assert.doesNotMatch(view.text(), /Chat memory/)
  assert.match(view.text(), /Node skill/)
  view.scope.value = { uiScopes: [] }
  await settle()
  assert.match(view.text(), /requires Main administrator/)
  assert.equal(requests.length, 2)
})

test('relationship graph renders directed edges, selectable unresolved nodes and keyboard navigation', async t => {
  const selections: string[] = []
  const graphCatalog: KnowledgeCatalog = {
    ...catalog, links: [...catalog.links, { source: wiki.id, target: 'memory/topics/missing.md', label: 'missing page' }],
  }
  const view = mount(t, 'KnowledgeGraph.vue', {
    catalog: graphCatalog, visibleIds: [wiki.id], selectedId: wiki.id,
    onSelect: (id: string) => selections.push(id),
  })
  await settle()
  const edges = view.nodes().filter(node => node.tag === 'path' && node.props['marker-end'])
  assert.equal(edges.length, 2)
  const nodes = view.nodes().filter(node => node.tag === 'g' && node.props.role === 'button')
  assert.equal(nodes.length, 3)
  const missing = nodes.find(node => String(node.props['aria-label']).includes('(unresolved reference)'))!
  assert(missing)
  assert.equal(missing.props.tabindex, '0')
  ;(missing.props.onClick as () => void)()
  const selected = nodes.find(node => node.props['aria-pressed'] === true)!
  const handlers = Array.isArray(selected.props.onKeydown) ? selected.props.onKeydown : [selected.props.onKeydown]
  for (const handler of handlers) (handler as (event: object) => void)({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(selections, ['memory/topics/missing.md', wiki.id])
})

test('relationship graph keeps its viewport when category filters change or have no matches', async t => {
  const view = mount(t, 'KnowledgeGraph.vue', {
    catalog, visibleIds: catalog.entries.map(item => item.id), selectedId: wiki.id,
  })
  const viewport = view.nodes().find(node => node.props['aria-label'] === 'Scrollable relationship graph')!
  assert.equal(view.nodes().filter(node => node.tag === 'g' && node.props.role === 'button').length, 3)
  view.props.visibleIds = [builtin.id]
  await settle()
  assert.equal(view.nodes().find(node => node.props['aria-label'] === 'Scrollable relationship graph'), viewport)
  assert.equal(view.nodes().filter(node => node.tag === 'g' && node.props.role === 'button').length, 1)
  view.props.visibleIds = []
  await settle()
  assert.equal(view.nodes().find(node => node.props['aria-label'] === 'Scrollable relationship graph'), viewport)
  assert.match(view.text(), /No entries match/)
  view.props.visibleIds = [memory.id]
  await settle()
  assert.equal(view.nodes().find(node => node.props['aria-label'] === 'Scrollable relationship graph'), viewport)
  const { descriptor } = parse(readFileSync(new URL('./components/KnowledgeGraph.vue', import.meta.url), 'utf8'))
  assert.match(descriptor.styles[0]!.content, /\.graph-scroll\s*\{[^}]*height:\s*min\(55vh,\s*480px\)/)
})

test('knowledge deletion removes the entry but keeps incoming edges and shows refresh failures explicitly', async t => {
  let lists = 0
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const id = new URL(String(input)).searchParams.get('id')
    if (id) return Response.json({ entry: wiki, content: '# Wiki' })
    if (++lists > 1) return new Response('', { status: 500 })
    return Response.json(catalog)
  })
  const view = mount(t, 'KnowledgeView.vue', { apiBase: 'http://fixture/projects/a', projectId: 'a' }, wiki.id)
  await settle()
  ;(view.button('Delete').props.onClick as () => void)()
  await settle()
  const confirm = view.nodes().find(node => node.props['data-test'] === 'confirm-delete')!
  assert(confirm)
  ;(confirm.props.onClick as () => void)()
  await settle()
  assert.match(view.text(), /File deleted/)
  assert.match(view.text(), /Unresolved reference/)
  assert.match(view.text(), /Referenced by \(1\)/)
  assert.match(view.text(), /could not complete.*500/)
  assert(!view.nodes().some(node => node.tag === 'button' && node.text === 'Delete'))
})

test('delete dialog shows incoming references and file scope, waits for confirmation, and surfaces stale revision', async t => {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const savedElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class {} })
  t.after(() => {
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else Reflect.deleteProperty(globalThis, 'document')
    if (savedElement) Object.defineProperty(globalThis, 'HTMLElement', savedElement); else Reflect.deleteProperty(globalThis, 'HTMLElement')
  })
  const requests: RequestInit[] = []
  let finish: (response: Response) => void = () => {}
  t.mock.method(globalThis, 'fetch', (_url: URL, init: RequestInit) => {
    requests.push(init)
    return new Promise<Response>(resolve => { finish = resolve })
  })
  const deleted: string[] = []
  const view = mount(t, 'KnowledgeDeleteDialog.vue', {
    apiBase: 'http://fixture/projects/a', projectId: 'a', target: wiki, incoming: catalog.links,
    onDeleted: (id: string) => deleted.push(id),
  })
  await settle()
  assert.equal(requests.length, 0, 'Opening the confirmation must not delete data')
  assert.match(view.text(), /1 incoming references/)
  assert.match(view.text(), /memory\/sessions\/chat.md/)
  assert.match(view.text(), /permanently deletes only this file/)
  const form = view.nodes().find(node => node.tag === 'form')!
  const submit = () => (form.props.onSubmit as (event: object) => void)({ preventDefault() {} })
  submit()
  submit()
  await settle()
  assert.equal(requests.length, 1, 'Duplicate submits are guarded')
  assert.deepEqual(JSON.parse(String(requests[0]!.body)), { id: wiki.id, revision: 'r1' })
  assert.equal(view.button('Cancel').props.disabled, true)
  finish(new Response('', { status: 409 }))
  await settle()
  assert.match(view.text(), /changed since it was loaded/)
  assert.deepEqual(deleted, [])
  submit()
  finish(Response.json({ deleted: wiki.id }))
  await settle()
  assert.deepEqual(deleted, [wiki.id])
})

const maintenanceReport: KnowledgeMaintenanceReport = {
  id: 'report-1', scannedAt: '2026-09-20T00:00:00Z', entriesScanned: 3,
  findings: [
    { id: 'dead', sourceId: wiki.id, sourceTitle: wiki.title, target: 'memory/topics/gone.md', label: 'Gone', reason: 'missing', repairable: true, message: 'Confirmed missing local file.' },
    { id: 'history', sourceId: memory.id, sourceTitle: memory.title, target: 'memory/topics/gone.md', label: 'Gone', reason: 'missing', repairable: false, message: 'Historical reference is preserved.' },
    { id: 'resource', sourceId: builtin.id, sourceTitle: builtin.title, target: 'builtin:skills/node/reference.txt', label: 'Reference', reason: 'outside-catalog', repairable: false, message: 'Exists outside catalog.' },
  ],
}
const repairPreview: KnowledgeRepairPreview = {
  reportId: maintenanceReport.id, sourceId: wiki.id, revision: 'r1',
  before: '# Wiki\n[Gone](gone.md)', after: '# Wiki\nGone', findingIds: ['dead'],
}

test('maintenance shows report classifications, only offers eligible previews, and rescans after confirmed repair', async t => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const path = new URL(String(input)).pathname
    calls.push(path)
    if (path.endsWith('/preview')) return Response.json(repairPreview)
    if (path.endsWith('/scan')) return Response.json({ ...maintenanceReport, id: 'report-2', findings: maintenanceReport.findings.slice(1) })
    return Response.json({ intervalMs: 86_400_000, scanning: false, report: maintenanceReport })
  })
  const changed: string[] = []
  const view = mount(t, 'KnowledgeMaintenance.vue', { apiBase: 'http://fixture/projects/a', projectId: 'a', onChanged: (id: string) => changed.push(id) })
  await settle()
  assert.equal(calls.length, 1, 'Opening maintenance does not initiate a scan or rewrite')
  ;(view.button('Show findings (3)').props.onClick as () => void)()
  await settle()
  assert.match(view.text(), /Confirmed missing/)
  assert.match(view.text(), /Historical reference is preserved/)
  assert.match(view.text(), /Exists outside catalog/)
  assert.equal(view.nodes().filter(node => node.tag === 'button' && node.text === 'Preview Wiki repair').length, 1)
  ;(view.button('Preview Wiki repair').props.onClick as () => void)()
  await settle()
  assert.equal(calls.filter(path => path.endsWith('/apply')).length, 0, 'Preview never applies edits')
  const confirmation = view.nodes().find(node => node.props['data-test'] === 'confirm-repair')!
  ;(confirmation.props.onClick as () => void)()
  await settle()
  assert.deepEqual(changed, [wiki.id])
  assert(calls.some(path => path.endsWith('/scan')))
  assert.match(view.text(), /Repair applied/)
  assert(!view.nodes().some(node => node.tag === 'button' && node.text === 'Preview Wiki repair'))
})

test('maintenance ignores stale responses after project switches and reports scan failure without hiding old findings', async t => {
  const pending: Array<{ signal?: AbortSignal | null; resolve: (response: Response) => void }> = []
  t.mock.method(globalThis, 'fetch', (_input: URL, init: RequestInit) => new Promise<Response>(resolve => pending.push({ signal: init.signal, resolve })))
  const view = mount(t, 'KnowledgeMaintenance.vue', { apiBase: 'http://fixture/projects/a', projectId: 'a' })
  view.props.apiBase = 'http://fixture/projects/b'
  await settle()
  assert.equal(pending[0]!.signal?.aborted, true)
  pending[1]!.resolve(Response.json({ intervalMs: 86_400_000, scanning: false, report: maintenanceReport }))
  await settle()
  pending[0]!.resolve(Response.json({ intervalMs: 86_400_000, scanning: false, report: null }))
  await settle()
  assert(view.button('Show findings (3)'))
  ;(view.button('Scan now').props.onClick as () => void)()
  await settle()
  pending[2]!.resolve(new Response('', { status: 500 }))
  await settle()
  assert.match(view.text(), /could not complete.*500/)
  assert(view.button('Show findings (3)'), 'The old timestamped report stays available after a failed scan')
})

test('hidden Knowledge maintenance cancels pending previews and cannot open a late repair dialog', async t => {
  let finishPreview: ((response: Response) => void) | undefined
  let previewSignal: AbortSignal | null | undefined
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    if (String(input).endsWith('/preview')) {
      previewSignal = init.signal
      return new Promise<Response>(resolve => { finishPreview = resolve })
    }
    return Response.json({ intervalMs: 86_400_000, scanning: false, report: maintenanceReport })
  })
  const view = mount(t, 'KnowledgeMaintenance.vue', { apiBase: 'http://fixture/projects/a', projectId: 'a', active: true })
  await settle()
  ;(view.button('Show findings (3)').props.onClick as () => void)()
  await settle()
  ;(view.button('Preview Wiki repair').props.onClick as () => void)()
  await settle()
  assert(finishPreview)
  view.props.active = false
  await settle()
  assert.equal(previewSignal?.aborted, true)
  finishPreview(Response.json(repairPreview))
  await settle()
  assert(!view.nodes().some(node => node.props['data-test'] === 'confirm-repair'))
  view.props.active = true
  await settle()
  assert(view.button('Hide findings'), 'Report expansion survives tab switches')
  assert(view.button('Preview Wiki repair'))
})

test('maintenance paginates large reports without hiding findings and resets pages when filtered', async t => {
  const findings = Array.from({ length: 105 }, (_, index) => ({
    ...maintenanceReport.findings[0]!, id: `finding-${index}`, target: `memory/topics/missing-${index}.md`,
  }))
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    intervalMs: 86_400_000, scanning: false, report: { ...maintenanceReport, findings },
  }))
  const view = mount(t, 'KnowledgeMaintenance.vue', { apiBase: 'http://fixture/projects/a', projectId: 'a' })
  await settle()
  ;(view.button('Show findings (105)').props.onClick as () => void)()
  await settle()
  assert.equal(view.nodes().filter(node => node.tag === 'li').length, 100)
  ;(view.button('Next findings').props.onClick as () => void)()
  await settle()
  assert.equal(view.nodes().filter(node => node.tag === 'li').length, 5)
  assert.match(view.text(), /missing-104\.md/)
  assert.equal(view.button('Next findings').props.disabled, true)
  const filter = view.nodes().find(node => node.props['aria-label'] === 'Filter link findings')!
  ;(filter.props['onUpdate:modelValue'] as (value: string) => void)('unavailable')
  await settle()
  assert.match(view.text(), /No findings match this filter/)
  ;(filter.props['onUpdate:modelValue'] as (value: string) => void)('all')
  await settle()
  assert.equal(view.nodes().filter(node => node.tag === 'li').length, 100)
  assert.equal(view.button('Previous findings').props.disabled, true)
})

test('repair dialog requires explicit confirmation, sends only revision identity, and retains conflicts', async t => {
  const descriptors = ['document', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class {} })
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key)
    }
  })
  const requests: RequestInit[] = []
  let finish: (response: Response) => void = () => {}
  t.mock.method(globalThis, 'fetch', (_url: URL, init: RequestInit) => {
    requests.push(init)
    return new Promise<Response>(resolve => { finish = resolve })
  })
  const applied: string[] = []
  const view = mount(t, 'KnowledgeRepairDialog.vue', {
    apiBase: 'http://fixture/projects/a', projectId: 'a', preview: repairPreview, onApplied: (id: string) => applied.push(id),
  })
  await settle()
  assert.equal(requests.length, 0)
  assert.match(view.text(), /Before.*# Wiki.*After/s)
  assert.match(view.text(), /No pages are deleted/)
  const submit = () => {
    const form = view.nodes().find(node => node.tag === 'form')!
    ;(form.props.onSubmit as (event: object) => void)({ preventDefault() {} })
  }
  submit(); submit()
  await settle()
  assert.equal(requests.length, 1)
  assert.equal(view.button('Cancel').props.disabled, true)
  assert.deepEqual(JSON.parse(String(requests[0]!.body)), { reportId: 'report-1', sourceId: wiki.id, revision: 'r1' })
  finish(new Response('', { status: 409 }))
  await settle()
  assert.match(view.text(), /scan again/)
  assert.deepEqual(applied, [])
  submit()
  finish(Response.json({ updated: wiki.id }))
  await settle()
  assert.deepEqual(applied, [wiki.id])
})
