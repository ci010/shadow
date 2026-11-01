import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { TestContext } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

interface ElementNode { tag: string; text: string; props: Record<string, any>; children: ElementNode[]; parent?: ElementNode }
const element = (tag: string, text = ''): ElementNode => ({ tag, text, props: {}, children: [] })
export const settleBotUi = async () => { await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick() }
/** Compiled Vue host renderer, not a browser. Native input/UiSelect mechanics have separate DOM tests. */
export function mountBotUi(t: TestContext, filename: string, props: Record<string, unknown>, options: { provide?: Map<symbol, unknown>; stubs?: Record<string, Vue.Component> } = {}) {
  function load(filename: string): Vue.Component {
    const url = new URL(`./components/${filename}`, import.meta.url)
    const { descriptor } = parse(readFileSync(url, 'utf8'))
    const source = compileScript(descriptor, { id: filename, inlineTemplate: true }).content
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
    const module = { exports: {} as { default: Vue.Component } }, require = createRequire(url)
    const fixtureRequire = (id: string): unknown => {
      if (id === 'vue') {
        const input = { beforeMount(el: ElementNode, binding: { value: unknown }) { el.props.inputValue = binding.value }, updated(el: ElementNode, binding: { value: unknown }) { el.props.inputValue = binding.value } }
        return { ...Vue, vModelText: input, vModelDynamic: input }
      }
      if (id === './UiSelect.vue') return { default: Vue.defineComponent({ inheritAttrs: false, setup: (_props, { attrs, slots }) => () => Vue.h('select', attrs, slots.default?.()) }) }
      if (id === 'vue-router') return { RouterLink: Vue.defineComponent({ setup: (_props, { attrs, slots }) => () => Vue.h('a', attrs, slots.default?.()) }) }
      if (id === './BotPairingCommand.vue') return { default: Vue.defineComponent({ props: ['challenge'], setup: props => () => Vue.h('pairing-command', { challenge: props.challenge }) }) }
      if (options.stubs?.[id]) return { default: options.stubs[id] }
      if (id.endsWith('.vue')) return { default: load(id.replace('./', '')) }
      return require(id)
    }
    new Function('require', 'module', 'exports', outputText)(fixtureRequire, module, module.exports)
    return module.exports.default
  }
  const renderer = Vue.createRenderer<ElementNode, ElementNode>({
    createElement: element, createText: text => element('#text', text), createComment: text => element('#comment', text),
    insert(node, parent, anchor) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node) },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text; node.children = [] },
    patchProp(node, key, _previous, value) { node.props[key] = value }, parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  })
  const root = element('root'), state = Vue.reactive({ ...props }), component = load(filename)
  const app = renderer.createApp(Vue.defineComponent({ setup: () => () => Vue.h(component, state) }))
  for (const [key, value] of options.provide ?? []) app.provide(key, value)
  app.mount(root)
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  t.after(unmount)
  const nodes = (): ElementNode[] => { const visit = (node: ElementNode): ElementNode[] => [node, ...node.children.flatMap(visit)]; return visit(root) }
  const text = () => nodes().filter(node => node.tag !== '#comment').map(node => node.text).join(' ')
  return { state, nodes, text, unmount,
    async select(index: number, value: string) { const node = nodes().filter(node => node.tag === 'select')[index]; assert(node); node.props['onUpdate:modelValue'](value); await settleBotUi() },
    input(name: string, value: string) { const node = nodes().find(node => node.tag === 'input' && node.props.name === name); assert(node); node.props['onUpdate:modelValue'](value) },
    async click(label: string) { const node = nodes().find(node => node.tag === 'button' && node.text === label); assert(node, `Missing button: ${label}`); assert(!node.props.disabled, `Disabled: ${label}`); await node.props.onClick(); await settleBotUi() },
    async submit(index = 0) { const node = nodes().filter(node => node.tag === 'form')[index]; assert(node); await node.props.onSubmit({ preventDefault() {} }); await settleBotUi() },
  }
}
