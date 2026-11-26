import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

function setup(filename: string, props: Record<string, unknown>) {
  const url = new URL(`./components/io/${filename}`, import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: filename, inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  let mount = () => {}
  let unmount = () => {}
  const module = { exports: {} as { default: { setup: (props: unknown, context: unknown) => () => Vue.VNode } } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)((id: string) => id === 'vue'
    ? { ...Vue, onMounted: (fn: () => void) => { mount = fn }, onUnmounted: (fn: () => void) => { unmount = fn } }
    : require(id), module, module.exports)
  const render = module.exports.default.setup(props, { expose() {} })
  return { render, mount: () => mount(), unmount: () => unmount() }
}

test('elapsed clock is local, second-granularity, and stops on unmount', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10_000 })
  const clock = setup('IoCaptureTime.vue', { startedAt: new Date(5000).toISOString(), limit: '1:00' })
  assert.equal(clock.render().children, '0:05 / 1:00')
  t.mock.timers.tick(1000)
  assert.equal(clock.render().children, '0:05 / 1:00', 'setup alone starts no timer')
  clock.mount()
  t.mock.timers.tick(999)
  assert.equal(clock.render().children, '0:05 / 1:00')
  t.mock.timers.tick(1)
  assert.equal(clock.render().children, '0:07 / 1:00')
  clock.unmount()
  t.mock.timers.tick(5000)
  assert.equal(clock.render().children, '0:07 / 1:00')
})

test('only the mounted input meter samples mutable capture levels', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const levels = new Map([['mic', 0.6]])
  const meter = setup('IoInputLevel.vue', { levels, sourceId: 'mic' })
  meter.mount()
  t.mock.timers.tick(250)
  assert.equal(meter.render().props?.value, 0.6)
  meter.unmount()
  levels.set('mic', 0.1)
  t.mock.timers.tick(1000)
  assert.equal(meter.render().props?.value, 0.6)
})

test('I/O host and request cards have no shared UI polling clock', () => {
  const host = readFileSync(new URL('./components/io/IoHost.vue', import.meta.url), 'utf8')
  const card = readFileSync(new URL('./components/io/IoRequestCard.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(host, /clockTimer|bridge\.clock/)
  assert.doesNotMatch(card, /bridge\??\.clock|elapsedLabel/)
  assert.match(card, /v-if="phase === 'recording' \|\| phase === 'starting'"/)
})
