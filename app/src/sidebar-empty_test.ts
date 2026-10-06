import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { createSSRApp, defineComponent, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

const url = new URL('./components/FoldersSidebar.vue', import.meta.url)
const { descriptor } = parse(readFileSync(url, 'utf8'))
const compiled = compileScript(descriptor, { id: 'folders-sidebar', inlineTemplate: true })
const { outputText } = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
const module = { exports: {} as { default: Component } }
const require = createRequire(url)
const slot = defineComponent({ inheritAttrs: false, setup: (_props, { slots }) => () => slots.default?.({ triggerProps: {} }) })
new Function('require', 'module', 'exports', outputText)(
  (id: string) => id.endsWith('.vue') ? { default: slot } : require(id), module, module.exports,
)

const render = (props: Record<string, unknown> = {}) => renderToString(createSSRApp(module.exports.default, {
  apiBase: 'http://fixture/projects/example',
  grouped: true,
  projectName: 'Example',
  sessions: [],
  activeSessionId: '',
  collapsed: new Set(),
  stages: {},
  sessionsLoading: false,
  sessionsError: '',
  ...props,
}))

test('empty sidebar keeps a direct scratch-chat action without empty conversation hints', async () => {
  const html = await render()
  assert.match(html, /Example/)
  assert.match(html, /aria-label="New work in Example"/)
  assert.doesNotMatch(html, /No conversations yet|No unassociated conversations|Open a folder to keep/)
  assert.match(html, /class="legacy-chats"/)
  assert.match(html, /Chats<\/h3>/)
  assert.match(html, /aria-label="New chat in Example"/)
  assert.match(html, /i-lucide-plus/)
  assert.doesNotMatch(html, /class="folder-conversations"/)
})

test('sidebar still announces loading and exposes actionable conversation errors', async () => {
  const loading = await render({ sessionsLoading: true })
  assert.match(loading, /Loading conversations/)
  assert.match(loading, /role="status"/)
  const failed = await render({ sessionsError: 'Synthetic session service unavailable' })
  assert.match(failed, /Synthetic session service unavailable/)
  assert.match(failed, /role="alert"/)
  assert.match(failed, /Retry conversations/)
})

test('standalone empty sidebar also exposes an accessible scratch-chat action', async () => {
  const html = await render({ grouped: false, projectName: undefined })
  assert.match(html, /aria-label="New chat"/)
  assert.match(html, /Chats<\/h3>/)
})
