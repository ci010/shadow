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
      assert(!/DecisionGraph|DecisionDiscussion/.test(id), 'removed surfaces must not be imported')
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

test('decision history keeps safety/history without a mandatory admin destination', async () => {
  const component = load('YieldDecision')
  const decision = { question: 'Change scope?', status: 'user', options: ['Proceed', 'Keep scope'], defaultOption: 'Keep scope', sources: [], reference: { sessionId: 'example', physicalId: 'p', requestId: 'r' }, invalidated: { reason: 'Scope changed' }, answer: { option: 'Need more evidence', custom: true, answeredAt: '2026-10-12T00:00:00Z' } }
  const html = await render(component, { decision, apiBase: '/fixture', canManage: true })
  assert.doesNotMatch(html, /href="\/projects\/fixture\/chat\/web:chat-admin"/)
  assert.doesNotMatch(html, /decision-dashboard/)
  assert.match(html, /Scope changed/)
  assert.match(html, /historical, not approval/)
  assert.match(html, /Need more evidence/)
  assert.doesNotMatch(html, /<svg|decision-discussion|decision-graph|Ask for explanation|Request revised question|Mark premise obsolete/)
})

test('pending decision retains options, custom answer and cancel without discussion; read-only controls remain disabled', async () => {
  const actual = createRequire(import.meta.url)('./yield-requests.ts') as typeof import('./yield-requests.ts')
  for (const canAnswer of [true, false]) {
    const component = load('YieldQuestion', { '../yield-requests.ts': { ...actual, useYieldRequest: () => ({
      request: ref({ id: 'r', sessionId: 'example', question: 'Change scope?', recipient: { kind: 'user' }, origin: { physicalId: 'p' }, options: ['Proceed', 'Keep scope'], defaultOption: 'Keep scope' }),
      selected: ref('Keep scope'), customMode: ref(false), customText: ref(''), error: ref(''), submitting: ref(false), cancelling: ref(false), busy: ref(false), loading: ref(false), now: ref(Date.now()), answerable: ref(canAnswer), refresh: () => {}, submit: () => {}, submitCustom: () => {}, cancelQuestion: () => {},
    }) } })
    const html = await render(component, { apiBase: '/fixture', sessionId: 'example', active: true, canAnswer })
    assert.match(html, /Proceed/)
    assert.match(html, /Keep scope/)
    assert.match(html, /Or type your own answer/)
    assert.doesNotMatch(html, /decision-discussion|Ask for explanation|Request revised question|Return for investigation|Defer ·/)
    if (canAnswer) { assert.match(html, /Cancel task/); assert.match(html, /Continue/); assert.doesNotMatch(html, /<fieldset[^>]*disabled/) }
    else { assert.match(html, /<fieldset[^>]*disabled/); assert.match(html, /read-only access/); assert.doesNotMatch(html, /Cancel task/) }
  }
})


test('decision history does not invoke admin dashboard navigation even in legacy history', async () => {
  let clicked: (() => void) | undefined
  let selected = 0
  const probe = defineComponent({ inheritAttrs: false, setup(_props, { attrs, slots }) {
    clicked = attrs.onClick as () => void
    return () => h(vueRouter.RouterLink, attrs, slots)
  } })
  const component = load('YieldDecision', { 'vue-router': { ...vueRouter, RouterLink: probe } })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/projects/:projectId/chat/:sessionId?', name: 'chat', component: empty }] })
  await router.push('/projects/fixture/chat/web:chat-admin')
  const app = createSSRApp(component, { decision: { question: 'Choose?', status: 'waiting-user', options: ['A', 'B'], sources: [] }, apiBase: '/fixture' }).use(router)
  app.provide('shadow:show-project-dashboard', () => { selected++ })
  await renderToString(app)
  assert.equal(clicked, undefined)
  assert.equal(selected, 0)
