import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createSSRApp, defineComponent, h, ref, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { compileScript, parse } from 'vue/compiler-sfc'
import * as vueRouter from 'vue-router'
const { createRouter, createMemoryHistory } = vueRouter
import ts from 'typescript'

function load(name: string, overrides: Record<string, unknown> = {}) {
  const url = new URL(`./components/${name}.vue`, import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const script = compileScript(descriptor, { id: name, inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component } }, require = createRequire(url)
  const empty = defineComponent({ render: () => null })
  new Function('require', 'module', 'exports', outputText)((id: string) => {
    if (id in overrides) return overrides[id]
    if (id === 'vue-router') return vueRouter
    if (id.endsWith('.vue')) {
      return { default: empty }
    }
    return require(id)
  }, module, module.exports)
  return module.exports.default
}

const empty = defineComponent({ render: () => null })
async function render(component: Component, props: Record<string, unknown>) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/projects/:projectId/chat/:sessionId?', name: 'chat', component: empty }] })
  await router.push('/projects/fixture/chat/example')
  await router.isReady()
  return renderToString(createSSRApp(component, props).use(router))
}

test('input question uses composer placeholder without duplicate card hints and retains real expiry', async () => {
  const actual = createRequire(import.meta.url)('./yield-requests.ts') as typeof import('./yield-requests.ts')
  for (const deadline of [undefined, '2099-01-01T12:00:00Z']) {
    const request = { id: 'input-r', kind: 'input', sessionId: 'example', question: 'Which executable?', recipient: { kind: 'user' }, deadline }
    const component = load('YieldQuestion', { '../yield-requests.ts': { ...actual, useYieldRequest: () => ({
      request: ref(request), selected: ref(''), customMode: ref(false), customText: ref(''), error: ref(''), submitting: ref(false), cancelling: ref(false), busy: ref(false), loading: ref(false), now: ref(Date.now()), answerable: ref(true), refresh: () => {}, submit: () => {}, submitCustom: () => {}, cancelQuestion: () => {},
    }) } })
    const html = await render(component, { apiBase: '/fixture', sessionId: 'example', active: true, canAnswer: true, useComposer: true })
    assert.match(html, /Which executable\?/)
    assert.match(html, /Cancel task/)
    assert.doesNotMatch(html, /yield-composer-note|Type your answer|Waiting for input|No answer is chosen automatically/)
    if (deadline) assert.match(html, /Input expires at/)
    else {
      assert.doesNotMatch(html, /id="[^"]*-deadline"/)
      assert.equal(actual.yieldDeadlineText(request as never, Date.now()), '')
    }
  }
  for (const locale of ['en', 'zh-CN']) {
    const messages = JSON.parse(readFileSync(new URL(`./locales/${locale}.json`, import.meta.url), 'utf8'))
    assert.equal('Waiting for input. No answer is chosen automatically.' in messages, false)
    assert.ok(messages['Type your answer...'], 'placeholder key is still used by both composers')
  }
})
