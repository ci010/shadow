import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, createSSRApp, defineComponent, getCurrentInstance, h, nextTick, reactive, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import * as fileHelpers from './composables/useSessionFiles.ts'

// Exercise the actual SFC setup/watch lifecycle with a headless Vue renderer.
function component(name: string): Component {
  const url = new URL(`./components/files/${name}.vue`, import.meta.url)
  const filename = fileURLToPath(url)
  const { descriptor } = parse(readFileSync(url, 'utf8'), { filename })
  assert.deepEqual(compileTemplate({ source: descriptor.template!.content, filename, id: name }).errors, [])
  const source = compileScript(descriptor, { id: name }).content
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} as { default: Component & { render?: () => null } } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)((id: string) =>
    id.endsWith('.vue') ? {} : id.endsWith('/composables/useSessionFiles') ? fileHelpers : require(id),
  module, module.exports)
  module.exports.default.render = () => null
  return module.exports.default
}

function mount(t: TestContext, name: string, initial: Record<string, unknown>) {
  const props = reactive({ ...initial })
  let instance: any
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const child = component(name)
  const app = renderer.createApp(defineComponent({
    setup: () => () => h(child, { ...props, ref: (value: unknown) => { instance = value } }),
  }))
  app.mount({})
  t.after(() => app.unmount())
  return { props, state: () => instance.$.setupState, unmount: () => app.unmount() }
}

function requests(t: TestContext) {
  const pending: { url: URL; signal: AbortSignal; finish: (value: unknown, status?: number) => void }[] = []
  t.mock.method(globalThis, 'fetch', (input: string, init: RequestInit) =>
    new Promise<Response>(resolve => pending.push({
      url: new URL(input), signal: init.signal!,
      finish: (value, status = 200) => resolve(Response.json(value, { status })),
    })))
  return pending
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve))
  await nextTick()
}

const entry = { name: '.node-version', ext: '', type: 'file', size: 8, mtime: null }
const base = { apiBase: 'http://localhost', sessionId: '', projectId: 'project-a', active: true }

test('changing a text preview encoding cancels stale responses and resets for a different file', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FilePreviewModal', { ...base, dir: '', entry: { ...entry, name: 'notes.txt', ext: '.txt' } })
  state().encoding = 'shift_jis'
  void state().loadText()
  assert.equal(pending[0]?.signal.aborted, true)
  assert.equal(pending[1]?.url.searchParams.get('encoding'), 'shift_jis')
  pending[1]!.finish({ binary: false, size: 6, content: '\u65e5\u672c\u8a9e', encoding: 'shift_jis' })
  await settle()
  pending[0]!.finish({ binary: false, size: 6, content: 'stale', encodingWarning: 'old warning' })
  await settle()
  assert.equal(state().textContent, '\u65e5\u672c\u8a9e')
  assert.equal(state().encodingWarning, '')
  props.entry = { ...entry, name: 'other.txt', ext: '.txt' }
  await nextTick()
  assert.equal(state().encoding, 'auto')
  assert.equal(pending[2]?.url.searchParams.has('encoding'), false)
})

test('scratch workbenches hide the explorer and Git without losing the expansion preference', async () => {
  for (const identity of [
    { sessionId: '', projectId: undefined, explorerEnabled: true, available: false },
    { sessionId: '', projectId: 'project-a', explorerEnabled: true, available: true },
    { sessionId: 'web:chat-one', projectId: undefined, explorerEnabled: true, available: true },
    { sessionId: 'web:chat-one', projectId: undefined, explorerEnabled: false, available: false },
  ]) {
    const child = component('FileWorkbench')
    const probe = defineComponent({
      ...child,
      render() {
        const state = getCurrentInstance()!.setupState
        state.width = 1000
        assert.equal(state.explorerAvailable, identity.available)
        assert.equal(state.expanded, identity.available)
        state.preference = true
        assert.equal(state.expanded, identity.available)
        assert.equal(state.preference, true)
        assert.equal(state.gitActive, identity.available)
        state.preference = false
        assert.equal(state.expanded, false)
        assert.equal(state.gitActive, false)
        return null
      },
    })
    await renderToString(createSSRApp(probe, { apiBase: 'http://localhost', contextKey: 'test', active: true, ...identity }))
  }
  const source = readFileSync(new URL('./components/files/FileWorkbench.vue', import.meta.url), 'utf8')
  assert.match(source, /<aside v-if="explorerAvailable"/)
  assert.match(source, /<HoverInfo v-if="explorerAvailable" text="Toggle files"/)
})

test('memory event previews retain original source, scoped quotes and view state without refetching', async t => {
  const pending = requests(t)
  const source = '{"when":"2026-09-10T16:45:44Z","who":"agent","what":"Record one"}\n'
  const { props, state } = mount(t, 'FilePreviewModal', {
    ...base, dir: 'memory/events', entry: { ...entry, name: 'test.jsonl', ext: '.jsonl' },
  })
  pending[0]!.finish({ binary: false, content: source, size: source.length, sourcePath: 'C:\\Home\\memory\\events\\test.jsonl' })
  await settle()
  assert.equal(state().isMemoryEvents, true)
  assert.equal(state().sourceView, false)
  assert.equal(state().memoryRecords[0].event.what, 'Record one')
  assert.equal(state().sourcePath, 'C:\\Home\\memory\\events\\test.jsonl')
  state().sourceView = true
  await nextTick()
  assert.equal(state().textContent, source)
  assert.equal(pending.length, 1)
  props.dir = 'logs'
  await nextTick()
  assert.equal(state().isMemoryEvents, false)
  assert.equal(state().sourcePath, undefined)
  assert.equal(state().sourceView, false)
})

test('empty root and nested directories stay blank while retaining their loaded state', async t => {
  const pending = requests(t)
  const root = mount(t, 'FileTree', base)
  pending[0]!.finish({ path: '', entries: [] })
  await settle()
  assert.deepEqual(root.state().displayEntries, [])
  assert.equal(root.state().loaded, true)
  assert.equal(root.state().error, '')

  const folder = mount(t, 'FileTreeNode', {
    ...base, dir: '', depth: 0, entry: { ...entry, name: 'empty-folder', type: 'dir' },
  })
  folder.state().onRowClick()
  pending[1]!.finish({ path: 'empty-folder', entries: [] })
  await settle()
  assert.deepEqual(folder.state().displayChildren, [])
  assert.equal(folder.state().expanded, true)
  assert.equal(folder.state().loading, false)
  for (const name of ['FileTree', 'FileTreeNode']) {
    const source = readFileSync(new URL(`./components/files/${name}.vue`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, />\s*empty\s*<|This workdir is empty/)
    assert.match(source, /role="alert"/)
  }
})

test('a workdir losing Git returns from Changes to its normal file tree', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', {
    ...base, treeOnly: true, gitStatus: { available: true, entries: [{ path: 'changed.txt', status: 'modified' }] },
  })
  pending[0]!.finish({ path: '', entries: [entry] })
  await settle()
  state().changesOnly = true
  await nextTick()
  assert.equal(state().displayEntries[0].name, 'changed.txt')
  props.gitStatus = { available: false, reason: 'not_repository', entries: [] }
  await nextTick()
  assert.equal(state().changesOnly, false)
  assert.deepEqual(state().displayEntries, [entry])
  assert.equal(state().loaded, true)
  assert.equal(state().error, '')
  assert.equal(pending.length, 1, 'Git availability must not reset the loaded files')
})

test('refresh retains loaded root entries and preview while reconciling unchanged data', async t => {
  const pending = requests(t)
  const { state } = mount(t, 'FileTree', { ...base, previewOnOpen: true })
  const listing = { path: '', entries: [entry], workdir: { kind: 'local', displayPath: 'C:\\project-a' } }
  pending[0]!.finish(listing)
  await settle()
  const original = state().rootEntries
  state().onOpen({ path: entry.name, entry })
  const selected = state().previewEntry
  void state().reload()
  assert.equal(state().loading, true)
  assert.equal(state().loaded, true)
  assert.equal(state().rootEntries, original)
  assert.equal(state().previewEntry, selected)
  pending[1]!.finish(structuredClone(listing))
  await settle()
  assert.equal(state().rootEntries, original)
  assert.equal(state().previewEntry, selected)
  void state().reload()
  pending[2]!.finish({ invalid: true })
  await settle()
  assert.ok(state().error)
  assert.equal(state().loaded, true)
  assert.equal(state().rootEntries, original)
})

test('cached folders reopen without loading and refresh in place after an explicit revision', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTreeNode', {
    ...base, dir: '', depth: 0, refreshVersion: 0, entry: { ...entry, name: 'folder', type: 'dir' },
  })
  state().onRowClick()
  pending[0]!.finish({ path: 'folder', entries: [entry] })
  await settle()
  const original = state().children
  state().onRowClick()
  state().onRowClick()
  assert.equal(pending.length, 1)
  assert.equal(state().children, original)
  state().onRowClick()
  props.refreshVersion = 1
  await nextTick()
  assert.equal(pending.length, 1, 'Do not refetch a collapsed directory')
  assert.equal(state().stale, true)
  state().onRowClick()
  assert.equal(pending.length, 2)
  assert.equal(state().loaded, true)
  assert.equal(state().children, original)
  pending[1]!.finish({ path: 'folder', entries: [entry, { ...entry, name: 'new.txt' }] })
  await settle()
  assert.equal(state().children[0], original[0])
  assert.equal(state().children.length, 2)
  assert.equal(state().expanded, true)
  assert.equal(state().stale, false)
})

test('a newer folder refresh cancels and ignores an older response without clearing cached rows', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTreeNode', {
    ...base, dir: '', depth: 0, refreshVersion: 0, entry: { ...entry, name: 'folder', type: 'dir' },
  })
  state().onRowClick()
  pending[0]!.finish({ path: 'folder', entries: [entry] })
  await settle()
  props.refreshVersion = 1
  await nextTick()
  props.refreshVersion = 2
  await nextTick()
  assert.equal(pending[1]?.signal.aborted, true)
  pending[2]!.finish({ path: 'folder', entries: [{ ...entry, name: 'latest.txt' }] })
  await settle()
  pending[1]!.finish({ path: 'folder', entries: [{ ...entry, name: 'stale.txt' }] })
  await settle()
  assert.equal(state().children[0].name, 'latest.txt')
  assert.equal(state().expanded, true)
})

const homeListing = { path: '', entries: [entry], workdir: { kind: 'local', scope: 'home', displayPath: 'C:\\synthetic-home' } }
const reflectionSource = { apiBase: 'http://localhost', sessionId: 'heartbeat:reflector-one', active: true }

test('reflection switches retain verified Home rows but cannot open them until the new source is confirmed', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', { ...reflectionSource, previewOnOpen: true })
  pending[0]!.finish(homeListing)
  await settle()
  const entries = state().rootEntries
  const key = state().workspaceKey
  props.sessionId = 'heartbeat:soul-reflector-two'
  await nextTick()
  assert.equal(state().loaded, true)
  assert.equal(state().rootEntries, entries)
  assert.equal(state().workspaceKey, key)
  assert.equal(state().sourcePending, true)
  assert.equal(state().displaySource.sessionId, reflectionSource.sessionId)
  state().onOpen({ path: entry.name, entry })
  assert.equal(state().previewEntry, null)
  pending[1]!.finish(structuredClone(homeListing))
  await settle()
  assert.equal(state().rootEntries, entries)
  assert.equal(state().workspaceKey, key)
  assert.equal(state().displaySource.sessionId, props.sessionId)
  assert.equal(state().sourcePending, false)
  state().onOpen({ path: entry.name, entry })
  assert.equal(state().previewEntry.name, entry.name)
})

test('superseded and hidden reflection requests cannot commit an old Home or source', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', reflectionSource)
  pending[0]!.finish(homeListing)
  await settle()
  const entries = state().rootEntries
  props.sessionId = 'heartbeat:reflector-two'
  await nextTick()
  props.active = false
  await nextTick()
  assert.equal(pending[1]?.signal.aborted, true)
  props.sessionId = 'heartbeat:reflector-three'
  await nextTick()
  assert.equal(pending.length, 2)
  props.active = true
  await nextTick()
  assert.equal(pending.length, 3)
  pending[2]!.finish(structuredClone(homeListing))
  await settle()
  pending[1]!.finish({ ...homeListing, workdir: { kind: 'remote', displayPath: 'C:\\other' } })
  await settle()
  assert.equal(state().rootEntries, entries)
  assert.equal(state().workdir.scope, 'home')
  assert.equal(state().displaySource.sessionId, props.sessionId)
  assert.equal(state().sourcePending, false)
})

test('different roots, remote roots and legacy metadata cannot reuse a verified Home identity', async t => {
  for (const workdir of [
    { ...homeListing.workdir, displayPath: 'D:\\different-home' },
    { kind: 'remote', displayPath: homeListing.workdir.displayPath },
    { kind: 'local', displayPath: homeListing.workdir.displayPath },
    undefined,
  ]) await t.test(JSON.stringify(workdir) ?? 'legacy listing', async t => {
    const pending = requests(t)
    const { props, state } = mount(t, 'FileTree', reflectionSource)
    pending[0]!.finish(homeListing)
    await settle()
    const key = state().workspaceKey
    const entries = state().rootEntries
    props.sessionId = 'heartbeat:reflector-two'
    await nextTick()
    pending[1]!.finish({ ...homeListing, workdir })
    await settle()
    assert.notEqual(state().workspaceKey, key)
    assert.notEqual(state().rootEntries, entries)
    assert.equal(state().sourcePending, false)
  })
})

test('an unauthorized reflection clears the retained Home and exposes an explicit retryable error', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', reflectionSource)
  pending[0]!.finish(homeListing)
  await settle()
  props.sessionId = 'heartbeat:reflector-two'
  await nextTick()
  pending[1]!.finish({ error: 'Access denied' }, 403)
  await settle()
  assert.equal(state().loaded, false)
  assert.deepEqual(state().rootEntries, [])
  assert.equal(state().workdir, undefined)
  assert.ok(state().error)
  void state().reload()
  pending[2]!.finish(homeListing)
  await settle()
  assert.equal(state().loaded, true)
  assert.equal(state().error, '')
})

test('a confirmed shared workspace changes node transport without resetting cached expansion', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTreeNode', {
    ...reflectionSource, workspaceKey: 'verified-home', refreshVersion: 0,
    dir: '', depth: 0, entry: { ...entry, name: 'memory', type: 'dir' },
  })
  state().onRowClick()
  pending[0]!.finish({ path: 'memory', entries: [entry] })
  await settle()
  const children = state().children
  props.active = false
  await nextTick()
  state().onRowClick()
  assert.equal(state().expanded, true, 'Pending workspace confirmation must not toggle cached rows')
  props.sessionId = 'heartbeat:reflector-two'
  props.refreshVersion = 1
  props.active = true
  await nextTick()
  assert.equal(pending.length, 2, 'Commit source, activity and revision atomically with one child request')
  assert.equal(state().children, children)
  assert.equal(state().expanded, true)
  assert.equal(decodeURIComponent(pending[1]!.url.pathname), '/api/sessions/heartbeat:reflector-two/files')
  pending[1]!.finish({ path: 'memory', entries: [entry] })
  await settle()
  assert.equal(state().children, children)
  props.workspaceKey = 'different-workspace'
  await nextTick()
  assert.equal(state().expanded, false)
  assert.deepEqual(state().children, [])
})

test('draft tree loads project files and ignores an old project response after identity changes', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', base)
  assert.equal(pending[0]?.url.pathname, '/api/projects/project-a/files')
  props.projectId = 'project-b'
  await nextTick()
  assert.equal(pending[0]?.signal.aborted, true)
  assert.equal(pending[1]?.url.pathname, '/api/projects/project-b/files')
  pending[1]!.finish({ path: '', entries: [{ ...entry, name: 'current.custom' }] })
  await settle()
  pending[0]!.finish({ path: '', entries: [{ ...entry, name: 'stale.custom' }] })
  await settle()
  assert.equal(state().rootEntries[0].name, 'current.custom')
  assert.equal(state().loading, false)
  props.projectId = ''
  await nextTick()
  assert.deepEqual(state().rootEntries, [])
  assert.equal(pending.length, 2)
})

test('expanded project nodes abort and clear their children when the project changes', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTreeNode', {
    ...base, dir: '', depth: 0, entry: { ...entry, name: 'docs', type: 'dir' },
  })
  state().onRowClick()
  assert.equal(pending[0]?.url.pathname, '/api/projects/project-a/files')
  props.projectId = 'project-b'
  await nextTick()
  assert.equal(pending[0]?.signal.aborted, true)
  assert.equal(state().expanded, false)
  state().onRowClick()
  pending[1]!.finish({ path: 'docs', entries: [entry] })
  await settle()
  pending[0]!.finish({ path: 'docs', entries: [{ ...entry, name: 'stale' }] })
  await settle()
  assert.equal(state().children[0].name, '.node-version')
  assert.equal(pending[1]?.url.pathname, '/api/projects/project-b/files')
})

test('unknown text previews reset, cancel and never display data from a previous project', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FilePreviewModal', { ...base, dir: '', entry })
  assert.equal(pending[0]?.url.pathname, '/api/projects/project-a/preview')
  props.projectId = 'project-b'
  await nextTick()
  assert.equal(pending[0]?.signal.aborted, true)
  pending[1]!.finish({ binary: false, content: 'current', size: 20, truncated: true })
  await settle()
  pending[0]!.finish({ binary: false, content: 'stale', size: 5 })
  await settle()
  assert.equal(state().textContent, 'current')
  assert.equal(state().truncated, true)
  props.active = false
  props.projectId = 'project-c'
  await nextTick()
  assert.equal(state().textContent, '')
  assert.equal(state().truncated, false)
  assert.equal(pending.length, 2)
  props.active = true
  await nextTick()
  pending[2]!.finish({ binary: true, size: 3 })
  await settle()
  assert.equal(state().binary, true)
  assert.equal(state().textContent, '')
  props.entry = { ...entry, name: 'page.html', ext: '.html' }
  await nextTick()
  assert.equal(state().kind, 'html')
  assert.equal(state().binary, false)
  assert.equal(pending.length, 3)
  assert.equal(new URL(state().staticSrc).pathname, '/api/projects/project-c/static/page.html')
})
