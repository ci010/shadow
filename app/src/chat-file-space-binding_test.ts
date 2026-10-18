import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { computed, createSSRApp, defineComponent, h, reactive } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { parseSessionGraph } from './folders-sidebar.ts'

// Compile the actual ChatTab -> FileWorkbench binding, not a duplicate selection
// helper: the regression was in this template despite correct graph metadata.
const url = new URL('./components/ChatTab.vue', import.meta.url)
const { descriptor } = parse(readFileSync(url, 'utf8'))
const tag = descriptor.template!.content.match(/<FileWorkbench\b[^>]+>/)![0]
const binding = tag.match(/:folder-id="[^"]+"/)![0]
const compiled = compileTemplate({ source: `<FileWorkbench ${binding} />`, filename: 'ChatTab.vue', id: 'folder-binding' })
assert.deepEqual(compiled.errors, [])
const module = { exports: {} as { render: (...args: any[]) => any } }
new Function('require', 'module', 'exports', ts.transpileModule(compiled.code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(createRequire(import.meta.url), module, module.exports)

function graph(folderId?: string) {
  return parseSessionGraph({ sessions: [
    { sessionId: 'web:folder', folderId, current: true },
    { sessionId: 'web:plain', current: true },
  ], nodes: [] })
}

test('ChatTab passes persisted Folder identity after launch/reload, switches cleanly, and never borrows the draft Folder', async () => {
  const state = reactive({ activeSessionId: 'web:folder', sessions: graph(), draft: { folder: { id: 'draft-folder' } } })
  const activeSession = computed(() => state.sessions.find(s => s.sessionId === state.activeSessionId))
  const root = defineComponent({
    components: { FileWorkbench: defineComponent({ props: ['folderId'], setup: props => () => h('output', props.folderId ?? 'no-project-root') }) },
    setup: () => ({ activeSessionId: computed(() => state.activeSessionId), activeSession, draft: state.draft }),
    render: module.exports.render,
  })
  const rendered = () => renderToString(createSSRApp(root))
  assert.match(await rendered(), /no-project-root/, 'Pending metadata must not borrow draft folder')
  state.sessions = graph('registered-folder')
  assert.match(await rendered(), />registered-folder</, 'Folder-launched existing session uses graph identity')
  state.sessions = [] // reload/new scoped graph is asynchronous
  assert.match(await rendered(), /no-project-root/)
  state.sessions = graph('registered-folder')
  assert.match(await rendered(), />registered-folder</, 'Reload restores persisted folder independently of draft')
  state.activeSessionId = 'web:plain'
  assert.match(await rendered(), /no-project-root/, 'Plain session has only its session workspace')
  state.sessions = graph('late-folder-update')
  assert.match(await rendered(), /no-project-root/, 'Late metadata for the previous selection cannot attach its folder')
  state.activeSessionId = 'web:folder'
  state.sessions = graph('opaque-remote-folder-id')
  assert.match(await rendered(), />opaque-remote-folder-id</, 'Remote folder IDs are passed unchanged, not inferred from paths')
  state.activeSessionId = ''
  assert.match(await rendered(), />draft-folder</)
})
