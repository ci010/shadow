import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, createSSRApp, defineComponent, getCurrentInstance, h, nextTick, reactive, ref, type Component, type VNode } from 'vue'
import type { PreviewOptions } from '@open-file-viewer/core'
import { renderToString } from 'vue/server-renderer'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import * as fileHelpers from './composables/useSessionFiles.ts'
import * as workdirRequestErrors from './workdir-request-error.ts'
import * as gitFiles from './git-files.ts'
import { createHomeTreeCache, HomeTreeCacheKey } from './home-tree-cache.ts'
import { parseSessionGraph } from './folders-sidebar.ts'
import * as homeTreeCacheModule from './home-tree-cache.ts'
import { archiveDirectory, type ArchiveMember, type ArchiveReference } from './archive-format.ts'

// Exercise the actual SFC setup/watch lifecycle with a headless Vue renderer.
function component(name: string, modules: Record<string, unknown> = {}): Component {
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
    id in modules ? modules[id] : id.endsWith('.vue') || id.endsWith('.css') ? {} : /\/composables\/useSessionFiles(?:\.ts)?$/.test(id) ? fileHelpers
      : id.endsWith('/workdir-request-error.ts') ? workdirRequestErrors
      : id.endsWith('/git-files.ts') ? gitFiles
      : id.endsWith('/home-tree-cache.ts') ? homeTreeCacheModule : require(id),
  module, module.exports)
  module.exports.default.render = () => null
  return module.exports.default
}

function mount(t: TestContext, name: string, initial: Record<string, unknown>, homeCache?: ReturnType<typeof createHomeTreeCache>, modules?: Record<string, unknown>) {
  const props = reactive({ ...initial })
  let instance: any
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const child = component(name, modules)
  const app = renderer.createApp(defineComponent({
    setup: () => () => h(child, { ...props, ref: (value: unknown) => { instance = value } }),
  }))
  if (homeCache) app.provide(HomeTreeCacheKey, homeCache)
  app.mount({})
  t.after(() => app.unmount())
  return { props, state: () => instance.$.setupState, unmount: () => app.unmount() }
}

function requests(t: TestContext) {
  const pending: { url: URL; signal: AbortSignal; finish: (value: unknown, status?: number) => void; finishBlob: (value: string) => void }[] = []
  t.mock.method(globalThis, 'fetch', (input: string, init: RequestInit) =>
    new Promise<Response>(resolve => pending.push({
      url: new URL(input), signal: init.signal!,
      finish: (value, status = 200) => resolve(Response.json(value, { status })),
      finishBlob: value => resolve(new Response(value)),
    })))
  return pending
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve))
  await nextTick()
}

function fileTreeTemplate() {
  const url = new URL('./components/files/FileTree.vue', import.meta.url)
  const filename = fileURLToPath(url)
  const { descriptor } = parse(readFileSync(url, 'utf8'), { filename })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'FileTree' })
  assert.deepEqual(template.errors, [])
  const { outputText } = ts.transpileModule(template.code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} as { render: (context: Record<string, unknown>, cache: unknown[]) => VNode } }
  new Function('require', 'module', 'exports', outputText)(createRequire(url), module, module.exports)
  return (context: Record<string, unknown>) => renderToString(createSSRApp(defineComponent({
    components: {
      HoverInfo: defineComponent({ props: ['text'], setup: (_, { slots }) => () => slots.default?.({ triggerProps: {} }) }),
      FileTreeNode: defineComponent({ props: ['entry'], setup: props => () => h('span', props.entry.name) }),
      FilePreviewModal: defineComponent({ setup: () => () => null }),
      FileTreeContextMenu: defineComponent({ setup: () => () => null }),
      NodeOfflineState: defineComponent({ setup: () => () => null }),
    },
    setup: () => () => module.exports.render({ $slots: {}, ...context }, []),
  })))
}

const entry = { name: '.node-version', ext: '', type: 'file', size: 8, mtime: null }
const base = { apiBase: 'http://localhost', sessionId: '', folderId: 'folder-a', active: true }

const offlineResponse = { error: 'workdir_unavailable', reason: 'node-offline', nodeId: 'child', workdirId: 'folder' }

test('file row context menus preserve preview and expansion and support keyboard invocation', async t => {
  const menus: unknown[] = []
  const opened: unknown[] = []
  const { props, state } = mount(t, 'FileTreeNode', {
    ...base, dir: 'src', depth: 1, entry,
    onContextMenu: (value: unknown) => menus.push(value),
    onOpen: (value: unknown) => opened.push(value),
  })
  let prevented = 0
  const event = { preventDefault() { prevented++ }, stopPropagation() {} }
  state().openContextMenu(event)
  assert.deepEqual(menus, [{ event, path: 'src/.node-version', entry }])
  assert.equal(opened.length, 0)
  assert.equal(state().expanded, false)
  state().menuKey({ ...event, key: 'F10', shiftKey: true })
  assert.equal(menus.length, 2)
  assert.equal(prevented, 2)
  state().onRowClick()
  assert.equal(opened.length, 1)
  props.active = false
  await nextTick()
  state().openContextMenu(event)
  assert.equal(menus.length, 2)
})

test('file tree closes context menus when the source changes or becomes inactive', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', base)
  pending[0]!.finish({ path: '', entries: [entry], workdir: { kind: 'local', displayPath: '/project' } })
  await settle()
  const request = { event: {}, path: 'src/a.ts' }
  state().openContextMenu(request)
  assert.equal(state().contextMenu, request)
  props.active = false
  await nextTick()
  assert.equal(state().contextMenu, undefined)
  state().openContextMenu(request)
  assert.equal(state().contextMenu, undefined)
  props.active = true
  await nextTick()
  state().openContextMenu(request)
  props.folderId = 'folder-b'
  await nextTick()
  assert.equal(state().contextMenu, undefined)
})

test('archive rows load only when expanded, cancel on collapse, retry, and discard stale sources', async t => {
  const pending: { archive: ArchiveReference; signal: AbortSignal; resolve: (entries: ArchiveMember[]) => void; reject: (error: Error) => void }[] = []
  const index: ArchiveMember[] = [{ path: 'folder/notes.txt', type: 'file', size: 4, encrypted: false, link: false }]
  const opened: unknown[] = []
  const { props, state } = mount(t, 'FileTreeNode', {
    ...base, dir: 'reports', depth: 0, entry: { ...entry, name: 'bundle.7z', ext: '.7z' }, onOpen: (value: unknown) => opened.push(value),
  }, undefined, {
    '../../archive-files.ts': { listArchive: (_api: string, _session: string, _folder: string, archive: ArchiveReference, signal: AbortSignal) =>
      new Promise<ArchiveMember[]>((resolve, reject) => pending.push({ archive, signal, resolve, reject })) },
  })
  assert.equal(state().expandable, true)
  assert.equal(pending.length, 0)
  state().onRowClick()
  assert.equal(opened.length, 0)
  assert.deepEqual(pending[0]!.archive, { path: 'reports/bundle.7z', members: [] })
  state().onRowClick()
  assert(pending[0]!.signal.aborted)
  pending[0]!.resolve(index)
  await settle()
  assert.deepEqual(state().children, [])
  state().onRowClick()
  pending[1]!.reject(new Error('damaged archive'))
  await settle()
  assert.match(state().loadError, /damaged/)
  void state().loadChildren()
  pending[2]!.resolve(index)
  await settle()
  assert.equal(state().children[0].name, 'folder')
  state().onRowClick(); state().onRowClick()
  assert.equal(pending.length, 3, 'Reopening a loaded archive reuses its metadata')
  props.refreshVersion = 1
  await settle()
  assert.equal(state().expanded, true)
  assert.equal(pending.length, 4, 'Refresh reloads expanded archives')
  props.apiBase = 'http://fixture/projects/other'
  await settle()
  assert(pending[3]!.signal.aborted)
  pending[3]!.resolve(index)
  await settle()
  assert.deepEqual(state().children, [])
})

test('archive subfolders expand from metadata without fetching or extracting, and changes remain diffs', async t => {
  const pending = requests(t)
  const index: ArchiveMember[] = [{ path: 'folder/notes.txt', type: 'file', size: 4, encrypted: false, link: false }]
  const folder = archiveDirectory(index, { path: 'bundle.zip', members: [] })[0]!
  const { state } = mount(t, 'FileTreeNode', { ...base, dir: 'bundle.zip', depth: 1, entry: folder, archiveIndex: index })
  state().onRowClick()
  await settle()
  assert.equal(pending.length, 0)
  assert.deepEqual(state().children[0].archive, { path: 'bundle.zip', members: ['folder/notes.txt'] })
  let opened = false
  const changed = mount(t, 'FileTreeNode', { ...base, dir: '', depth: 0, changesOnly: true,
    entry: { ...entry, name: 'bundle.zip' }, onOpen: () => { opened = true } })
  changed.state().onRowClick()
  assert.equal(changed.state().expandable, false)
  assert(opened)
})

test('archive containers never enter Open File Viewer or text decoding', async t => {
  const pending = requests(t)
  for (const ext of ['.zip', '.rar', '.7z', '.gz', '.xz']) {
    const { state } = mount(t, 'FilePreviewModal', { ...base, remote: true, dir: '', entry: { ...entry, name: `bundle${ext}`, ext } })
    assert.equal(state().archiveContainer, true)
    assert.equal(state().viewerFormat, undefined)
    assert.equal(state().textMode, false)
  }
  assert.equal(pending.length, 0)
})

test('archive entry previews use bounded inert source and release bytes and URLs when inactive', async t => {
  const pending = requests(t)
  const reads: AbortSignal[] = []
  const revoked: string[] = []
  t.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url))
  const { props, state } = mount(t, 'FilePreviewModal', {
    ...base, dir: 'bundle.zip', canQuote: true, selectionActive: true,
    entry: { ...entry, name: 'page.html', ext: '.html', archive: { path: 'bundle.zip', members: ['page.html'] } },
  }, undefined, {
    '../../archive-files.ts': { readArchiveEntry: async (_api: string, _session: string, _folder: string, _archive: unknown, signal: AbortSignal) => {
      reads.push(signal)
      return new Blob(['<script>unsafe()</script>', 'x'.repeat(70000)])
    } },
  })
  await settle()
  assert.equal(state().loaded, true)
  assert.equal(state().textMode, true)
  assert.equal(state().textContent.length, 65536)
  assert.equal(state().truncated, true)
  assert.equal(state().selectionEnabled, false)
  assert.equal(pending.length, 0, 'No invented archive member path is sent to the workspace API')
  const url = state().archiveUrl
  state().encoding = 'utf-8'
  await state().loadText()
  assert.equal(reads.length, 1, 'Changing encoding reuses only the current entry')
  props.active = false
  await settle()
  assert(revoked.includes(url))
  assert.equal(state().archiveBlob, undefined)
  props.active = true
  await settle()
  assert.equal(reads.length, 2)
})

test('archive member SDK previews use supplied bytes without a workspace member request', async t => {
  const pending = requests(t)
  const blob = new Blob(['office entry'])
  const { viewers } = mountViewer(t, { sourceBlob: blob })
  await settle()
  assert.equal(pending.length, 0)
  assert.equal(viewers[0]!.options.file, blob)
})

test('revealing a nested file expands only its ancestors and loads existing children', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTreeNode', {
    ...base, dir: '', depth: 0, entry: { ...entry, name: 'reports', type: 'dir' },
    selectedPath: 'reports/daily/REPORT.md', revealVersion: 1,
  })
  assert.equal(state().expanded, true)
  assert.equal(pending[0]!.url.searchParams.get('path'), 'reports')
  pending[0]!.finish({ path: 'reports', entries: [{ ...entry, name: 'daily', type: 'dir' }] })
  await settle()
  assert.equal(state().displayChildren[0].name, 'daily')
  state().onRowClick()
  assert.equal(state().expanded, false, 'Users may still collapse the revealed ancestor')
  props.revealVersion = 2
  await settle()
  assert.equal(state().expanded, true, 'Reopening the same link reveals it again')
  assert.equal(pending.length, 1, 'Loaded children are reused')
})

test('missing reveal paths and inactive trees do not trigger unrelated directory requests', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTreeNode', {
    ...base, active: false, dir: '', depth: 0, entry: { ...entry, name: 'reports', type: 'dir' },
    selectedPath: 'reports/daily/REPORT.md',
  })
  assert.equal(pending.length, 0)
  props.active = true
  await settle()
  assert.equal(pending.length, 1)
  pending[0]!.finish({ path: 'reports', entries: [] })
  await settle()
  assert.deepEqual(state().displayChildren, [])
  props.selectedPath = 'reports-other/REPORT.md'
  await settle()
  assert.equal(pending.length, 1)
})

test('file link reveal switches from changes to files and refreshes a stale root', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', { ...base, selectedPath: 'REPORT.md', revealVersion: 0 })
  pending[0]!.finish({ path: '', entries: [] })
  await settle()
  state().changesOnly = true
  props.revealVersion = 1
  await settle()
  assert.equal(state().changesOnly, false)
  assert.equal(pending.length, 2)
  pending[1]!.finish({ path: '', entries: [{ ...entry, name: 'REPORT.md', ext: '.md' }] })
  await settle()
  assert.equal(state().displayEntries[0].name, 'REPORT.md')
})

test('file explorer combines offline Git/files into one calm state and recovers after checking again', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', { ...base, gitOffline: true, gitError: '' })
  pending[0]!.finish(offlineResponse, 503)
  await settle()
  assert.equal(state().offline, true)
  assert.equal(state().error, '')
  void state().reload()
  assert.equal(state().offline, true, 'Keep the offline state visible during the check')
  pending[1]!.finish({ path: '', entries: [entry] })
  await settle()
  assert.equal(state().fileOffline, false)
  assert.equal(state().offline, true, 'Git still reports the owning node offline')
  props.gitOffline = false
  await settle()
  assert.equal(state().offline, false)
  assert.deepEqual(state().displayEntries, [entry])
  const source = readFileSync(new URL('./components/files/FileTree.vue', import.meta.url), 'utf8')
  assert.match(source, /<NodeOfflineState v-if="offline"/)
  assert.match(source, /<template v-else>\s*<div v-if="changesOnly && gitError"/)
  const notice = readFileSync(new URL('./components/files/NodeOfflineState.vue', import.meta.url), 'utf8')
  assert.match(notice, /role="status"/)
  assert.match(notice, /Check again/)
  assert.doesNotMatch(notice, /role="alert"|var\(--c-error/)
})

test('Git reconnection rechecks an offline file tree and genuine failures do not become offline', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', { ...base, gitOffline: true })
  pending[0]!.finish(offlineResponse, 503)
  await settle()
  props.gitOffline = false
  props.gitStatus = { available: true, entries: [] }
  await nextTick()
  assert.equal(pending.length, 2)
  pending[1]!.finish({ error: 'folder_unavailable' }, 409)
  await settle()
  assert.equal(state().offline, false)
  assert.match(state().error, /folder/)
})

test('old offline and successful root responses cannot restore another source or project', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', base)
  props.apiBase = 'http://fixture/projects/two'
  props.folderId = 'second'
  await nextTick()
  pending[0]!.finish(offlineResponse, 503)
  pending[1]!.finish({ path: '', entries: [entry] })
  await settle()
  assert.equal(state().offline, false)
  assert.equal(state().displaySource.apiBase, props.apiBase)
  void state().reload()
  props.apiBase = 'http://fixture/projects/three'
  await nextTick()
  pending[3]!.finish(offlineResponse, 503)
  pending[2]!.finish({ path: '', entries: [{ ...entry, name: 'previous-org.txt' }] })
  await settle()
  assert.equal(state().offline, true)
  assert.deepEqual(state().displayEntries, [])
  assert.equal(state().displaySource.apiBase, props.apiBase)
})

test('folder children report offline to the explorer, but never from stale project requests', async t => {
  const pending = requests(t)
  let offlineEvents = 0
  const { props, state } = mount(t, 'FileTreeNode', {
    ...base, dir: '', depth: 0, entry: { ...entry, name: 'folder', type: 'dir' },
    onNodeOffline: () => { offlineEvents++ },
  })
  state().onRowClick()
  pending[0]!.finish(offlineResponse, 503)
  await settle()
  assert.equal(offlineEvents, 1)
  assert.equal(state().loadError, '')
  void state().loadChildren()
  props.apiBase = 'http://fixture/projects/other'
  await nextTick()
  pending[1]!.finish(offlineResponse, 503)
  await settle()
  assert.equal(offlineEvents, 1)
  assert.equal(state().loadError, '')
})

for (const ext of ['.txt', '.png', '.html', '.mp4']) {
  test(`${ext} previews show explicit offline state, recover and reject previous project responses`, async t => {
    const pending = requests(t)
    const { props, state } = mount(t, 'FilePreviewModal', { ...base, remote: true, dir: '', entry: { ...entry, name: `preview${ext}`, ext } })
    pending[0]!.finish(offlineResponse, 503)
    await settle()
    assert.equal(state().offline, true)
    assert.equal(state().error, '')
    void state().loadText()
    assert.equal(state().offline, true)
    pending[1]!.finish(ext === '.txt' ? { binary: false, content: 'current preview', size: 15 } : { path: '', entries: [] })
    await settle()
    assert.equal(state().offline, false)
    assert.equal(state().loaded, true)
    void state().loadText()
    props.apiBase = 'http://fixture/projects/other'
    await nextTick()
    pending[3]!.finish({ error: 'denied' }, 403)
    pending[2]!.finish(offlineResponse, 503)
    await settle()
    assert.equal(state().offline, false)
    assert.match(state().error, /denied/)
    assert.equal(state().textContent, '')
  })
}

function mountViewer(t: TestContext, initial: Record<string, unknown> = {}) {
  const isDark = ref(false)
  const viewers: Array<{ options: PreviewOptions; destroyed: boolean }> = []
  const mounted = mount(t, 'FileViewerPreview', {
    ...base, path: 'reports/report.docx', name: 'report.docx', ...initial,
  }, undefined, {
    '../../composables/useTheme.ts': { useTheme: () => ({ isDark }) },
    '../../open-file-viewer-sdk.ts': {
      mountFileViewer(options: PreviewOptions) {
        const record = { options, destroyed: false }
        viewers.push(record)
        return { destroy: () => { record.destroyed = true } }
      },
    },
  })
  mounted.state().container = {}
  return { ...mounted, viewers, isDark }
}

test('Open File Viewer loads scoped bytes lazily, preserves names and destroys inactive previews', async t => {
  const pending = requests(t)
  const { props, state, viewers } = mountViewer(t, { active: false, name: 'report #.docx', path: 'reports/report #.docx' })
  assert.equal(pending.length, 0)
  props.active = true
  await nextTick()
  assert.equal(pending[0]!.url.pathname, '/api/folders/folder-a/raw')
  assert.equal(pending[0]!.url.searchParams.get('path'), 'reports/report #.docx')
  pending[0]!.finishBlob('original bytes')
  await settle()
  assert.equal(viewers.length, 1)
  assert(viewers[0]!.options.file instanceof Blob)
  assert.equal(await viewers[0]!.options.file.text(), 'original bytes')
  assert.equal(viewers[0]!.options.fileName, 'report #.docx')
  assert.equal(state().loading, true)
  viewers[0]!.options.onLoad!({ source: viewers[0]!.options.file, name: 'report #.docx', extension: 'docx', mimeType: '' })
  assert.equal(state().loading, false)
  props.active = false
  await nextTick()
  assert.equal(viewers[0]!.destroyed, true)
  assert.equal(pending[0]!.signal.aborted, true)
  assert.equal(state().loading, false)
  viewers[0]!.options.onError!(new Error('late parser failure'))
  assert.equal(state().error, '')
})

test('Open File Viewer handles offline recovery and discards old project bytes and callbacks', async t => {
  const pending = requests(t)
  const { props, state, viewers } = mountViewer(t)
  pending[0]!.finish(offlineResponse, 503)
  await settle()
  assert.equal(state().offline, true)
  assert.equal(viewers.length, 0)
  void state().load()
  pending[1]!.finishBlob('current')
  await settle()
  assert.equal(state().offline, false)
  void state().load()
  props.apiBase = 'http://fixture/projects/two'
  await nextTick()
  pending[3]!.finishBlob('second project')
  await settle()
  pending[2]!.finishBlob('stale')
  viewers[0]!.options.onError!(new Error('old render'))
  await settle()
  assert.equal(viewers.length, 2)
  assert.equal(viewers[0]!.destroyed, true)
  assert.equal(state().error, '')
  assert(viewers[1]!.options.file instanceof Blob)
  assert.equal(await viewers[1]!.options.file.text(), 'second project')
  props.folderId = 'folder-b'
  await nextTick()
  assert.equal(viewers[1]!.destroyed, true)
  pending[4]!.finish({ error: 'denied' }, 403)
  await settle()
  assert.equal(state().offline, false)
  assert.match(state().error, /denied/)
})

test('Open File Viewer retries parser failures and changes theme without downloading again', async t => {
  const pending = requests(t)
  const { state, viewers, isDark, unmount } = mountViewer(t)
  pending[0]!.finishBlob('original')
  await settle()
  viewers[0]!.options.onError!(new Error('broken archive'))
  assert.match(state().error, /broken archive/)
  assert.equal(state().loading, false)
  void state().load()
  pending[1]!.finishBlob('original')
  await settle()
  assert.equal(state().error, '')
  isDark.value = true
  await nextTick()
  assert.equal(pending.length, 2)
  assert.equal(viewers[1]!.destroyed, true)
  assert.equal(viewers[2]!.options.theme, 'dark')
  assert.equal(viewers[2]!.options.file, viewers[1]!.options.file)
  viewers[1]!.options.onUnsupported!({ source: '', name: '', extension: '', mimeType: '' })
  assert.equal(state().error, '')
  unmount()
  assert.equal(viewers[2]!.destroyed, true)
})

test('Open File Viewer keeps embedded attachment notifications separate from the opened file', async t => {
  const pending = requests(t)
  const { state, viewers } = mountViewer(t, { path: 'message.eml', name: 'message.eml' })
  pending[0]!.finishBlob('email')
  await settle()
  const notifications = viewers[0]!.options
  const child = { source: new Blob(['entry']), name: 'unknown.entry', extension: 'entry', mimeType: '' }
  notifications.onLoad!(child)
  assert.equal(state().loading, true)
  notifications.onUnsupported!(child)
  notifications.onError!(new Error('entry parser'), child)
  assert.equal(state().error, '')
  assert(notifications.file instanceof Blob)
  notifications.onLoad!({ ...child, source: notifications.file, name: 'message.eml' })
  assert.equal(state().loading, false)
  notifications.onUnsupported!({ ...child, source: notifications.file, name: 'message.eml' })
  assert.match(state().error, /cannot be previewed/)
})

test('Open File Viewer routes PDF and extra formats without text decoding or remote directory probes', async t => {
  const pending = requests(t)
  for (const ext of ['.pdf', '.docx', '.eml', '.glb']) {
    const { state } = mount(t, 'FilePreviewModal', { ...base, remote: true, dir: '', entry: { ...entry, name: `file${ext}`, ext } })
    assert(state().viewerFormat)
    assert.equal(state().textMode, false)
    assert.equal(state().selectionEnabled, false)
  }
  assert.equal(pending.length, 0, 'Only the viewer child fetches the protected raw bytes')
})

test('diff previews recover from offline and discard pending data on a project switch', async t => {
  const restoreGlobals: Array<() => void> = []
  for (const [name, value] of Object.entries({
    document: { addEventListener() {}, removeEventListener() {} },
    window: { getSelection: () => null },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    restoreGlobals.push(() => {
      if (previous) Object.defineProperty(globalThis, name, previous)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
  const pending = requests(t)
  const { props, state } = mount(t, 'FileDiffPreview', {
    ...base, path: 'notes.txt', selectionActive: false, canQuote: false, revision: 0,
  })
  t.after(() => { for (const restore of restoreGlobals) restore() })
  pending[0]!.finish(offlineResponse, 503)
  await settle()
  assert.equal(state().offline, true)
  assert.equal(state().error, '')
  void state().loadDiff()
  assert.equal(state().offline, true)
  const diff = { path: 'notes.txt', status: 'modified', base: 'HEAD', binary: false, truncated: false, hunks: [] }
  pending[1]!.finish(diff)
  await settle()
  assert.equal(state().offline, false)
  assert.equal(state().diff.path, 'notes.txt')
  void state().loadDiff()
  props.apiBase = 'http://fixture/projects/other'
  await nextTick()
  pending[3]!.finish(offlineResponse, 503)
  pending[2]!.finish(diff)
  await settle()
  assert.equal(state().offline, true)
  assert.equal(state().diff, undefined)
  assert.deepEqual(state().highlighted, [])
  assert.equal(pending[2]!.signal.aborted, true)
})

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
    { sessionId: '', folderId: undefined, explorerEnabled: true, available: false },
    { sessionId: '', folderId: 'folder-a', explorerEnabled: true, available: true },
    { sessionId: 'web:chat-one', folderId: undefined, explorerEnabled: true, available: true },
    { sessionId: 'web:chat-one', folderId: undefined, explorerEnabled: false, available: false },
  ]) {
    const child = component('FileWorkbench')
    const probe = defineComponent({
      ...child,
      render() {
        const state = getCurrentInstance()!.setupState
        state.width = 1000
        assert.equal(state.explorerAvailable, identity.available)
        assert.equal(state.expanded, false, 'Explorer starts collapsed even on wide screens')
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
  assert.match(source, /<aside v-if="explorerAvailable \|\| \(tabs\.knowledge && knowledgeEnabled\)"/)
  assert.match(source, /<HoverInfo v-if="explorerAvailable \|\| knowledgeSelected" :text="knowledgeSelected \? t\('Toggle Knowledge navigation \(Ctrl\+Shift\+E\)'\) : t\('Toggle files \(Ctrl\+Shift\+E\)'\)"/)
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

test('Git errors render only in Changes, which stays accessible through failure and retry', async t => {
  const pending = requests(t)
  const gitError = 'Git inspection exceeded its output limit. Choose a smaller workdir. [Git ls-files; stage=execute]'
  const { props, state } = mount(t, 'FileTree', { ...base, treeOnly: true, gitError })
  pending[0]!.finish({ path: '', entries: [entry] })
  await settle()
  const render = fileTreeTemplate()
  const html = () => render({ ...props, ...state() })
  assert.equal(state().changesAvailable, true, 'An initial failure must not disable Changes')
  let output = await html()
  assert.match(output, /\.node-version/)
  assert.doesNotMatch(output, /role="alert"|Retry Git/)
  assert.doesNotMatch(output, /role="tab"[^>]*disabled/)

  state().changesOnly = true
  await nextTick()
  output = await html()
  assert.match(output, /role="alert">Git inspection exceeded/)
  assert.match(output, /Retry Git/)
  assert.doesNotMatch(output, /Git status is not available|Working tree clean|No matching changes/)

  props.gitLoading = true
  await nextTick()
  assert.equal(state().changesOnly, true)
  output = await html()
  assert.match(output, /Loading changes/)
  assert.match(output, /class="file-tree-retry" disabled/)

  props.gitLoading = false
  props.gitError = ''
  props.gitStatus = { available: true, entries: [] }
  await nextTick()
  assert.equal(state().changesOnly, true)
  output = await html()
  assert.doesNotMatch(output, /role="alert"|Retry Git/)
  assert.match(output, /Working tree clean/)

  props.gitStatus = { available: true, entries: [], truncated: true }
  await nextTick()
  output = await html()
  assert.match(output, /Git changes are incomplete/)
  assert.doesNotMatch(output, /Working tree clean/)
  state().filterQuery = 'missing'
  await nextTick()
  assert.doesNotMatch(await html(), /No matching changes/)

  props.gitError = gitError
  state().filterQuery = 'missing'
  await nextTick()
  output = await html()
  assert.match(output, /role="alert">Git inspection exceeded/)
  assert.doesNotMatch(output, /Working tree clean|No matching changes/)
  state().changesOnly = false
  state().filterQuery = ''
  await nextTick()
  output = await html()
  assert.match(output, /\.node-version/)
  assert.doesNotMatch(output, /role="alert"|Retry Git/)
  assert.equal(pending.length, 1, 'Git errors and retries must not reload the file tree')
})

test('Changes keyboard navigation works during initial Git loading and failure', async t => {
  requests(t)
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const focused: string[] = []
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    getElementById: (id: string) => ({ focus: () => focused.push(id) }),
  } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const { props, state } = mount(t, 'FileTree', { ...base, treeOnly: true, gitLoading: true })
  let prevented = 0
  state().viewKey({ key: 'End', preventDefault: () => prevented++ })
  await nextTick()
  assert.equal(state().changesOnly, true)
  assert.match(focused.at(-1)!, /changes-tab$/)
  props.gitLoading = false
  props.gitError = 'Git inspection failed'
  await nextTick()
  assert.equal(state().changesOnly, true)
  state().viewKey({ key: 'Home', preventDefault: () => prevented++ })
  await nextTick()
  assert.equal(state().changesOnly, false)
  assert.match(focused.at(-1)!, /files-tab$/)
  state().viewKey({ key: 'ArrowRight', preventDefault: () => prevented++ })
  await nextTick()
  assert.equal(state().changesOnly, true)
  assert.equal(prevented, 3)
  props.gitOffline = true
  await nextTick()
  assert.equal(state().changesAvailable, false)
})

test('refresh retains loaded root entries and preview while reconciling unchanged data', async t => {
  const pending = requests(t)
  const { state } = mount(t, 'FileTree', { ...base, previewOnOpen: true })
  const listing = { path: '', entries: [entry], workdir: { kind: 'local', displayPath: 'C:\\folder-a' } }
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
const reflectionSource = { apiBase: 'http://localhost', sessionId: 'cron:opaque-learning-one', active: true }

function learningHomeCache() {
  const cache = createHomeTreeCache()
  cache.setSessions(reflectionSource.apiBase, parseSessionGraph({ nodes: [], sessions:
    [reflectionSource.sessionId, 'cron:opaque-learning-two', 'heartbeat:soul-reflector-two', 'heartbeat:reflector-two', 'heartbeat:reflector-three'].map(sessionId => ({
      sessionId, automation: { jobId: 'learning:encapsulator', name: 'Encapsulation', runId: sessionId,
        startedAt: '2026-09-16T00:00:00Z', contextMode: 'fresh', config: { source: 'learning', schedule: 'every 2h' } },
    })),
  }))
  return cache
}

test('separate reflection views reuse only confirmed same-org Home data, expansion and explicit refreshes', async t => {
  const pending = requests(t)
  const cache = learningHomeCache()
  const first = mount(t, 'FileTree', reflectionSource, cache)
  pending[0].finish(homeListing)
  await settle()
  const home = first.state().homeState
  const folder = { ...entry, name: 'memory', type: 'dir' }
  const a = mount(t, 'FileTreeNode', {
    ...reflectionSource, dir: '', depth: 0, entry: folder, workspaceKey: first.state().workspaceKey, homeState: home,
  })
  a.state().onRowClick()
  pending[1].finish({ path: 'memory', entries: [entry], workdir: homeListing.workdir })
  await settle()
  const children = a.state().children
  first.props.active = false
  a.props.active = false
  await nextTick()
  const secondSource = { ...reflectionSource, sessionId: 'cron:opaque-learning-two' }
  const second = mount(t, 'FileTree', secondSource, cache)
  assert.equal(second.state().loaded, true, 'Use cached rows immediately instead of a new loading tree')
  assert.equal(second.state().sourcePending, true, 'The new session must still verify its Home')
  assert.equal(second.state().homeState, home)
  const b = mount(t, 'FileTreeNode', {
    ...secondSource, active: false, dir: '', depth: 0, entry: folder,
    workspaceKey: second.state().workspaceKey, homeState: home, refreshVersion: home.revision,
  })
  assert.equal(b.state().expanded, true)
  assert.equal(b.state().children, children)
  pending[2].finish(structuredClone(homeListing))
  await settle()
  b.props.active = true
  await nextTick()
  assert.equal(pending.length, 3, 'Switching sessions validates the root without refetching loaded folders')
  assert.equal(second.state().sourcePending, false)
  const refresh = second.state().reload()
  pending[3].finish(homeListing)
  await refresh
  b.props.refreshVersion = home.revision
  await nextTick()
  assert.equal(pending[4].url.pathname, `/api/sessions/${encodeURIComponent(secondSource.sessionId)}/files`)
  pending[4].finish({ path: 'memory', entries: [entry, { ...entry, name: 'new.txt' }], workdir: homeListing.workdir })
  await settle()
  assert.equal(a.state().children.length, 2, 'An explicit refresh updates all views of the same Home')
  const foreign = mount(t, 'FileTree', { ...secondSource, apiBase: 'http://localhost/projects/other' }, cache)
  assert.equal(foreign.state().loaded, false)
  assert.equal(foreign.state().homeState, undefined)
  pending[5].finish(homeListing)
  await settle()
  assert.notEqual(foreign.state().homeState, home, 'Equal filesystem display paths never cross org API scopes')
  assert.equal(foreign.state().homeState.directories.size, 0)
  b.props.refreshVersion = home.revision + 1
  await nextTick()
  pending[6].finish({ path: 'memory', entries: [{ ...entry, name: 'wrong-home.txt' }],
    workdir: { ...homeListing.workdir, displayPath: 'D:\\changed-home' } })
  await settle()
  assert.match(b.state().loadError, /Folder location changed/)
  assert.equal(a.state().children.length, 2, 'A changed child-listing root cannot corrupt the shared Home cache')
})

test('reflection switches retain verified Home rows but cannot open them until the new source is confirmed', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', { ...reflectionSource, previewOnOpen: true }, learningHomeCache())
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
  const { props, state } = mount(t, 'FileTree', reflectionSource, learningHomeCache())
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
    const { props, state } = mount(t, 'FileTree', reflectionSource, learningHomeCache())
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
  const { props, state } = mount(t, 'FileTree', reflectionSource, learningHomeCache())
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

test('draft tree loads folder files and ignores an old folder response after identity changes', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', base)
  assert.equal(pending[0]?.url.pathname, '/api/folders/folder-a/files')
  props.folderId = 'folder-b'
  await nextTick()
  assert.equal(pending[0]?.signal.aborted, true)
  assert.equal(pending[1]?.url.pathname, '/api/folders/folder-b/files')
  pending[1]!.finish({ path: '', entries: [{ ...entry, name: 'current.custom' }] })
  await settle()
  pending[0]!.finish({ path: '', entries: [{ ...entry, name: 'stale.custom' }] })
  await settle()
  assert.equal(state().rootEntries[0].name, 'current.custom')
  assert.equal(state().loading, false)
  props.folderId = ''
  await nextTick()
  assert.deepEqual(state().rootEntries, [])
  assert.equal(pending.length, 2)
})

test('expanded folder nodes abort and clear their children when the folder changes', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTreeNode', {
    ...base, dir: '', depth: 0, entry: { ...entry, name: 'docs', type: 'dir' },
  })
  state().onRowClick()
  assert.equal(pending[0]?.url.pathname, '/api/folders/folder-a/files')
  props.folderId = 'folder-b'
  await nextTick()
  assert.equal(pending[0]?.signal.aborted, true)
  assert.equal(state().expanded, false)
  state().onRowClick()
  pending[1]!.finish({ path: 'docs', entries: [entry] })
  await settle()
  pending[0]!.finish({ path: 'docs', entries: [{ ...entry, name: 'stale' }] })
  await settle()
  assert.equal(state().children[0].name, '.node-version')
  assert.equal(pending[1]?.url.pathname, '/api/folders/folder-b/files')
})

test('unknown text previews reset, cancel and never display data from a previous folder', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FilePreviewModal', { ...base, dir: '', entry })
  assert.equal(pending[0]?.url.pathname, '/api/folders/folder-a/preview')
  props.folderId = 'folder-b'
  await nextTick()
  assert.equal(pending[0]?.signal.aborted, true)
  pending[1]!.finish({ binary: false, content: 'current', size: 20, truncated: true })
  await settle()
  pending[0]!.finish({ binary: false, content: 'stale', size: 5 })
  await settle()
  assert.equal(state().textContent, 'current')
  assert.equal(state().truncated, true)
  props.active = false
  props.folderId = 'folder-c'
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
  assert.equal(new URL(state().staticSrc).pathname, '/api/folders/folder-c/static/page.html')
})

test('explicit session tree discards Home state and scopes child previews and context menu paths to Main storage', async t => {
  const pending = requests(t)
  const { props, state } = mount(t, 'FileTree', { ...base, sessionId: 'web:chat-one', folderId: undefined, sessionWorkspace: false, treeOnly: true })
  pending[0]!.finish({ path: '', entries: [entry], workdir: { kind: 'local', scope: 'home', displayPath: 'C:\\private-project-home' } })
  await settle()
  props.sessionWorkspace = true
  await nextTick()
  assert.equal(state().loaded, false)
  assert.deepEqual(state().displayEntries, [])
  assert.match(pending[1]!.url.pathname, /\/workspace\/files$/)
  pending[1]!.finish({ path: '', entries: [entry], workdir: { kind: 'local', displayPath: 'C:\\session-storage' } })
  await settle()
  assert.equal(state().workspaceLabel, 'Session workspace')
  assert.equal(state().workdir.displayPath, 'C:\\session-storage')
  assert.equal(state().homeState, undefined)
  const preview = mount(t, 'FilePreviewModal', { ...base, sessionId: 'web:chat-one', folderId: undefined, sessionWorkspace: true, dir: '', entry })
  assert.match(pending.at(-1)!.url.pathname, /\/workspace\/preview$/)
  pending.at(-1)!.finish({ binary: false, size: 7, content: 'session' })
  await settle()
  assert.equal(preview.state().files.rawUrl('web:chat-one', 'image.png').includes('/workspace/raw?'), true)
  assert.equal(preview.state().files.staticUrl('web:chat-one', 'page/index.html').includes('/workspace/static/page/index.html'), true)
})

test('two file spaces retain distinct tabs and preview source through switching workbench contexts', async t => {
  const restoreGlobals: (() => void)[] = []
  const globals: Record<string, unknown> = { document: { addEventListener() {}, removeEventListener() {}, getElementById() { return undefined } }, window: { addEventListener() {}, removeEventListener() {} }, ResizeObserver: class { observe() {} disconnect() {} } }
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    restoreGlobals.push(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key) })
  }
  requests(t)
  const { props, state } = mount(t, 'FileWorkbench', { ...base, sessionId: 'web:chat-one', contextKey: 'one', active: true })
  t.after(() => restoreGlobals.forEach(restore => restore()))
  assert.equal(state().expanded, false)
  const project = { path: 'same.txt', entry, source: { folderId: 'folder-a' } }
  const session = { path: 'same.txt', entry, source: { sessionWorkspace: true } }
  state().openFile(project)
  state().openFile(session)
  assert.equal(state().tabs.files.length, 2)
  assert.deepEqual(state().selectedSource, session.source)
  // A registered Folder must not hijack an explicitly scoped attachment/session
  // link, while an unscoped Markdown workdir link belongs to Project files.
  state().openLinkedFile({ path: 'report.md', entry: { ...entry, name: 'report.md' } })
  assert.deepEqual(state().selectedSource, { folderId: 'folder-a' })
  state().openLinkedFile(session)
  assert.deepEqual(state().selectedSource, session.source)
  assert.equal(state().fileSpace, 'session')
  state().fileSpace = 'session'
  props.folderId = 'folder-b'
  props.contextKey = 'two'
  await nextTick()
  assert.equal(state().fileSpace, 'project')
  props.folderId = undefined
  props.contextKey = 'three'
  await nextTick()
  assert.equal(state().fileSpace, 'session')
})


test('tree-external Chinese attachment previews reuse text and document viewers without any tree request', async t => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    calls.push(String(input))
    return new Response('报告内容')
  })
  const url = 'http://localhost/api/media?chatId=test&path=' + encodeURIComponent('C:\\Users\\test\\Documents\\Shadow\\报告.txt')
  const { props, state } = mount(t, 'FilePreviewModal', {
    apiBase: 'http://localhost', sessionId: 'web:test', attachmentUrl: url,
    dir: '', entry: { name: '报告.txt', ext: '.txt', type: 'file', size: 0, mtime: null },
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(state().textContent, '报告内容')
  assert.equal(state().rawSource, url)
  assert.deepEqual(calls, [url])
  props.entry = { name: '报告.pdf', ext: '.pdf', type: 'file', size: 0, mtime: null }
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(state().loaded, true)
  assert.ok(state().archiveBlob instanceof Blob)
  assert.deepEqual(calls, [url, url])
})


test('attachment reveal is absent on Web and remote Electron and shown only after host verification', async t => {
  const initial = { paths: ['C:\\Documents\\Shadow\\report.txt'], apiBase: 'http://localhost', sessionId: 'web:test' }
  const web = mount(t, '../MessageAttachments', initial)
  assert.equal(web.state().revealable.size, 0)
  let local = false
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { href: 'http://localhost/' }, shadowDesktop: { fileExplorer: { attachment: async () => local } },
  } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') })
  t.mock.method(globalThis, 'fetch', async () => Response.json({ proof: { path: initial.paths[0] } }))
  const remote = mount(t, '../MessageAttachments', initial)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(remote.state().revealable.size, 0)
  local = true
  const owned = mount(t, '../MessageAttachments', initial)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(owned.state().revealable.has(initial.paths[0]), true)
  owned.state().openAttachment(owned.state().items[0])
  assert.match(owned.state().preview.url, /api\/media/)
  assert.equal(owned.state().preview.entry.name, 'report.txt')
})
